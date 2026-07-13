import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { isSessionWriteLockTimeoutError } from "../../session-write-lock-error.js";
import type { acquireSessionWriteLock } from "../../session-write-lock.js";

const log = createSubsystemLogger("session-lock");

// Bytes of the file tail we hash to distinguish a real content change from
// benign stat jitter. A session entry is one JSONL line; 4 KiB comfortably
// covers a trailing entry, and reading our own just-written tail hits our
// page cache so it stays self-consistent.
const SESSION_FILE_TAIL_HASH_BYTES = 4096;

async function hashSessionFileRange(
  sessionFile: string,
  position: number,
  length: number,
): Promise<{ length: number; hash: string }> {
  if (length <= 0) {
    return { length: 0, hash: createHash("sha256").digest("hex") };
  }
  const handle = await fs.open(sessionFile, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return {
      length: bytesRead,
      hash: createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

async function hashSessionFileTail(
  sessionFile: string,
  size: bigint,
): Promise<{ length: number; hash: string }> {
  const numericSize = Number(size);
  const length = Math.min(numericSize, SESSION_FILE_TAIL_HASH_BYTES);
  return await hashSessionFileRange(sessionFile, numericSize - length, length);
}

type SessionLock = Awaited<ReturnType<typeof acquireSessionWriteLock>>;
type AcquireSessionWriteLock = typeof acquireSessionWriteLock;

type LockOptions = {
  sessionFile: string;
  timeoutMs: number;
  staleMs: number;
  maxHoldMs: number;
};

type SessionEventProcessor = {
  _processAgentEvent?: (event: unknown) => Promise<void>;
  _extensionRunner?: {
    hasHandlers?: (eventType: string) => boolean;
  };
  __openclawSessionEventWriteLockInstalled?: boolean;
};

type SessionEventQueueOwner = {
  _agentEventQueue?: PromiseLike<unknown>;
};

type SessionWithAgentPrompt = {
  agent?: {
    streamFn?: PromptReleaseStreamFn;
  };
};

type SessionWithExternalHooks = SessionEventProcessor & {
  compact?: LockableFunction;
  agent?: {
    beforeToolCall?: LockableFunction;
    afterToolCall?: LockableFunction;
    onPayload?: LockableFunction;
    onResponse?: LockableFunction;
  };
};

type PromptReleaseStreamFn = ((...args: unknown[]) => unknown) & {
  __openclawSessionLockPromptReleaseInstalled?: boolean;
};

type LockableFunction = ((...args: unknown[]) => unknown) & {
  __openclawSessionWriteLockInstalled?: boolean;
};

function sessionHasExtensionHandlers(session: SessionEventProcessor, eventType: string): boolean {
  const extensionRunner = session["_extensionRunner"];
  const hasHandlers = extensionRunner?.hasHandlers;
  if (typeof hasHandlers !== "function") {
    return false;
  }
  try {
    return hasHandlers.call(extensionRunner, eventType);
  } catch {
    return true;
  }
}

function eventMayReachTranscriptWriters(session: SessionEventProcessor, event: unknown): boolean {
  const type = (event as { type?: unknown } | null)?.type;
  if (type === "message_update" || type === "message_end" || type === "agent_end") {
    return true;
  }
  if (typeof type !== "string") {
    return false;
  }
  return sessionHasExtensionHandlers(session, type);
}

function installLockableFunction(params: {
  owner: Record<string, unknown>;
  key: string;
  shouldLock: () => boolean;
  waitBeforeLock?: () => Promise<void>;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  const current = params.owner[params.key] as LockableFunction | undefined;
  if (typeof current !== "function" || current["__openclawSessionWriteLockInstalled"] === true) {
    return;
  }
  const wrapped: LockableFunction = async function lockedExternalHook(
    this: unknown,
    ...args: unknown[]
  ) {
    if (!params.shouldLock()) {
      return await current.apply(this, args);
    }
    await params.waitBeforeLock?.();
    return await params.withSessionWriteLock(async () => await current.apply(this, args));
  };
  wrapped["__openclawSessionWriteLockInstalled"] = true;
  params.owner[params.key] = wrapped;
}

type SessionFileFingerprint =
  | { exists: false }
  | {
      exists: true;
      dev: bigint;
      ino: bigint;
      size: bigint;
      mtimeNs: bigint;
      ctimeNs: bigint;
      /** sha256 of the last SESSION_FILE_TAIL_HASH_BYTES on-disk bytes. */
      tail: { length: number; hash: string };
    };

function sameSessionFileFingerprint(
  left: SessionFileFingerprint | undefined,
  right: SessionFileFingerprint,
): boolean {
  if (!left || left.exists !== right.exists) {
    return false;
  }
  if (!left.exists || !right.exists) {
    return true;
  }
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

// Name exactly which stat fields changed when the fence trips (issue #35 W1b).
// A bare "session file changed" is unactionable; the delta discriminates the
// concurrent writer's shape: `ino` changed = atomic temp+rename replacement;
// `size`/`mtime` changed = an in-place append/rewrite; `ctime` only = a
// metadata-only touch (open-for-write with no bytes, chmod). Greppable via
// `session-fence-tripped`.
export function describeSessionFileFingerprintDelta(
  before: SessionFileFingerprint | undefined,
  after: SessionFileFingerprint,
): string {
  if (!before) {
    return "no-baseline";
  }
  if (before.exists !== after.exists) {
    return before.exists ? "file-removed" : "file-created";
  }
  if (!before.exists || !after.exists) {
    return "existence-toggled";
  }
  const parts: string[] = [];
  if (before.dev !== after.dev) {
    parts.push("dev");
  }
  if (before.ino !== after.ino) {
    parts.push(`ino(${before.ino}->${after.ino})`);
  }
  if (before.size !== after.size) {
    parts.push(`size(${before.size}->${after.size})`);
  }
  if (before.mtimeNs !== after.mtimeNs) {
    parts.push("mtime");
  }
  if (before.ctimeNs !== after.ctimeNs) {
    parts.push("ctime");
  }
  return parts.length > 0 ? parts.join(",") : "none";
}

async function readSessionFileFingerprint(sessionFile: string): Promise<SessionFileFingerprint> {
  try {
    const stat = await fs.stat(sessionFile, { bigint: true });
    return {
      exists: true,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      tail: await hashSessionFileTail(sessionFile, stat.size),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

async function waitForSessionEventQueue(session: unknown): Promise<void> {
  const owner = session as SessionEventQueueOwner;
  for (let attempts = 0; attempts < 5; attempts += 1) {
    const queue = owner?.["_agentEventQueue"];
    if (!queue || typeof queue.then !== "function") {
      return;
    }
    await Promise.resolve(queue).catch(() => {});
    if (owner?.["_agentEventQueue"] === queue) {
      return;
    }
  }
  const queue = owner?.["_agentEventQueue"];
  if (queue && typeof queue.then === "function") {
    await Promise.resolve(queue).catch(() => {});
  }
}

export class EmbeddedAttemptSessionTakeoverError extends Error {
  constructor(sessionFile: string) {
    super(`session file changed while embedded prompt lock was released: ${sessionFile}`);
    this.name = "EmbeddedAttemptSessionTakeoverError";
  }
}

export function installSessionEventWriteLock(params: {
  session: unknown;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  const session = params.session as SessionEventProcessor;
  const original = session["_processAgentEvent"];
  if (
    typeof original !== "function" ||
    session["__openclawSessionEventWriteLockInstalled"] === true
  ) {
    return;
  }
  session["__openclawSessionEventWriteLockInstalled"] = true;
  session["_processAgentEvent"] = async function lockedProcessAgentEvent(
    this: unknown,
    event: unknown,
  ) {
    if (!eventMayReachTranscriptWriters(session, event)) {
      return await original.call(this, event);
    }
    return await params.withSessionWriteLock(async () => await original.call(this, event));
  };
}

export function installSessionExternalHookWriteLock(params: {
  session: unknown;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  const session = params.session as SessionWithExternalHooks;
  const agent = session.agent;
  if (agent) {
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "beforeToolCall",
      shouldLock: () => true,
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "afterToolCall",
      shouldLock: () => sessionHasExtensionHandlers(session, "tool_result"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "onPayload",
      shouldLock: () => sessionHasExtensionHandlers(session, "before_provider_request"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "onResponse",
      shouldLock: () => sessionHasExtensionHandlers(session, "after_provider_response"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
  }
  installLockableFunction({
    owner: session as Record<string, unknown>,
    key: "compact",
    shouldLock: () => true,
    waitBeforeLock: () => waitForSessionEventQueue(session),
    withSessionWriteLock: params.withSessionWriteLock,
  });
}

export type EmbeddedAttemptSessionLockController = {
  releaseForPrompt(): Promise<void>;
  waitForSessionEvents(session: unknown): Promise<void>;
  withSessionWriteLock<T>(run: () => Promise<T> | T): Promise<T>;
  acquireForCleanup(params?: { session?: unknown }): Promise<SessionLock>;
  hasSessionTakeover(): boolean;
};

export async function createEmbeddedAttemptSessionLockController(params: {
  acquireSessionWriteLock: AcquireSessionWriteLock;
  lockOptions: LockOptions;
}): Promise<EmbeddedAttemptSessionLockController> {
  const acquireLock = async (): Promise<SessionLock> =>
    await params.acquireSessionWriteLock({
      sessionFile: params.lockOptions.sessionFile,
      timeoutMs: params.lockOptions.timeoutMs,
      staleMs: params.lockOptions.staleMs,
      maxHoldMs: params.lockOptions.maxHoldMs,
    });

  let heldLock: SessionLock | undefined = await acquireLock();
  const activeWriteLock = new AsyncLocalStorage<SessionLock>();
  let fenceFingerprint: SessionFileFingerprint | undefined;
  let fenceActive = false;
  let takeoverDetected = false;

  async function acquireWriteLock(): Promise<{ lock: SessionLock; owned: boolean }> {
    if (heldLock) {
      return { lock: heldLock, owned: false };
    }
    try {
      return { lock: await acquireLock(), owned: true };
    } catch (err) {
      if (isSessionWriteLockTimeoutError(err)) {
        takeoverDetected = true;
      }
      throw err;
    }
  }

  function tripTakeover(current: SessionFileFingerprint): never {
    takeoverDetected = true;
    log.warn(
      `session-fence-tripped file=${params.lockOptions.sessionFile} ` +
        `changed=${describeSessionFileFingerprintDelta(fenceFingerprint, current)}`,
    );
    throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
  }

  async function assertSessionFileFence(): Promise<void> {
    if (!fenceActive) {
      return;
    }
    const baseline = fenceFingerprint;
    const current = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    // Fast path: nothing moved. Unchanged behavior on a local filesystem.
    if (sameSessionFileFingerprint(baseline, current)) {
      return;
    }
    // The fence exists to catch a DESTRUCTIVE takeover: another run that
    // rewrote or truncated this session's history while our prompt lock was
    // released (e.g. a foreign compaction rebuilding the file). It must NOT
    // fire on the ordinary case, which a stat-only check cannot tell apart:
    // this run writes its own entries. Ground truth from the reproducing slot
    // (issue #35 W1b), named by the delta diagnostic:
    //   - `changed=file-created` — a fresh session's FIRST turn. The vendor
    //     SessionManager buffers entries in memory until the first assistant
    //     message, so at releaseForPrompt (before the prompt) the file does
    //     not exist yet; the run's own first flush then creates it. Baseline
    //     absent + file now present is this run creating its own transcript.
    //   - later turns: in-place appends (size 6750->7905->...; ino constant;
    //     ctime==mtime moving with size) — the run's own growth.
    // The in-process session-file mutex (#40) is held across the whole attempt
    // INCLUDING the prompt, so no second in-process run can create or write the
    // file during the release window. So both shapes are benign. Only a
    // destructive change (the file shrank, vanished, or its existing bytes were
    // rewritten) is a real takeover.
    if (!baseline || !baseline.exists) {
      // Armed before any flush; the file we now see is our own first write.
      // No baseline bytes to confirm, but the mutex rules out a foreign
      // creator — adopt and continue.
      log.info(
        `session-fence-rearmed file=${params.lockOptions.sessionFile} ` +
          `changed=${describeSessionFileFingerprintDelta(baseline, current)}`,
      );
      fenceFingerprint = current;
      return;
    }
    if (!current.exists || current.size < baseline.size) {
      tripTakeover(current); // truncated / replaced by a shorter file
    }
    // Re-hash exactly the byte span the baseline covered; if those bytes are
    // intact, no one rewrote our history in place — it was only appended to.
    const confirmation = await hashSessionFileRange(
      params.lockOptions.sessionFile,
      Number(baseline.size) - baseline.tail.length,
      baseline.tail.length,
    );
    if (confirmation.hash !== baseline.tail.hash || confirmation.length !== baseline.tail.length) {
      tripTakeover(current); // our history bytes changed = destructive rewrite
    }
    // History intact, file only appended to (or stat drifted with no content
    // change): benign. Re-arm on the fresh fingerprint and continue the turn.
    log.info(
      `session-fence-rearmed file=${params.lockOptions.sessionFile} ` +
        `changed=${describeSessionFileFingerprintDelta(baseline, current)}`,
    );
    fenceFingerprint = current;
  }

  async function refreshSessionFileFence(): Promise<void> {
    if (fenceActive && !takeoverDetected) {
      fenceFingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    }
  }

  const noopLock: SessionLock = { release: async () => {} };

  return {
    async releaseForPrompt(): Promise<void> {
      if (!heldLock) {
        return;
      }
      const lock = heldLock;
      heldLock = undefined;
      fenceFingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
      fenceActive = true;
      await lock.release();
    },
    waitForSessionEvents: waitForSessionEventQueue,
    async withSessionWriteLock<T>(run: () => Promise<T> | T): Promise<T> {
      if (takeoverDetected) {
        throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
      }
      if (activeWriteLock.getStore()) {
        return await run();
      }
      const { lock, owned } = await acquireWriteLock();
      try {
        await assertSessionFileFence();
        const runWithLock = async () => {
          const result = await run();
          await refreshSessionFileFence();
          return result;
        };
        if (owned) {
          return await activeWriteLock.run(lock, runWithLock);
        }
        return await runWithLock();
      } finally {
        if (owned) {
          await lock.release();
        }
      }
    },
    async acquireForCleanup(cleanupParams?: { session?: unknown }): Promise<SessionLock> {
      if (cleanupParams?.session) {
        await waitForSessionEventQueue(cleanupParams.session);
      }
      if (takeoverDetected) {
        return noopLock;
      }
      try {
        heldLock ??= await acquireLock();
      } catch (err) {
        if (isSessionWriteLockTimeoutError(err)) {
          takeoverDetected = true;
          return noopLock;
        }
        throw err;
      }
      const cleanupLock = heldLock;
      heldLock = undefined;
      try {
        await assertSessionFileFence();
      } catch (err) {
        await cleanupLock.release();
        if (err instanceof EmbeddedAttemptSessionTakeoverError) {
          return noopLock;
        }
        throw err;
      }
      return cleanupLock;
    },
    hasSessionTakeover(): boolean {
      return takeoverDetected;
    },
  };
}

export function installPromptSubmissionLockRelease(params: {
  session: unknown;
  waitForSessionEvents: (session: unknown) => Promise<void>;
  releaseForPrompt: () => Promise<void>;
}): void {
  const agent = (params.session as SessionWithAgentPrompt).agent;
  if (typeof agent?.streamFn !== "function") {
    return;
  }
  const currentStreamFn = agent.streamFn;
  if (currentStreamFn["__openclawSessionLockPromptReleaseInstalled"] === true) {
    return;
  }
  const originalStreamFn = currentStreamFn.bind(agent);
  const wrappedStreamFn: PromptReleaseStreamFn = async (...args: unknown[]) => {
    await params.waitForSessionEvents(params.session);
    await params.releaseForPrompt();
    return await originalStreamFn(...args);
  };
  wrappedStreamFn["__openclawSessionLockPromptReleaseInstalled"] = true;
  agent.streamFn = wrappedStreamFn;
}
