// W1b fix: the takeover fence must decide on CONTENT, not stat metadata.
// On a network filesystem the stat fields (mtime/ctime, sometimes ino) drift on
// attribute-cache revalidation with no writer, which falsely aborted real turns
// (issue #35 — same code trips on a NAS-backed slot, never on a local one). The
// fence now re-hashes the baseline byte span: benign jitter re-arms and
// continues; a genuine content takeover (append / rewrite / truncate) still
// throws.
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEmbeddedAttemptSessionLockController,
  EmbeddedAttemptSessionTakeoverError,
} from "./attempt.session-lock.js";

let dir: string;
let sessionFile: string;

// A stub cross-process lock — the fence logic under test is filesystem-based,
// not lock-based.
const stubAcquire = (async () => ({ release: async () => {} })) as unknown as Parameters<
  typeof createEmbeddedAttemptSessionLockController
>[0]["acquireSessionWriteLock"];

async function makeController() {
  return await createEmbeddedAttemptSessionLockController({
    acquireSessionWriteLock: stubAcquire,
    lockOptions: { sessionFile, timeoutMs: 1000, staleMs: 1000, maxHoldMs: 1000 },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openclaw-fence-content-"));
  sessionFile = join(dir, "session.jsonl");
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: "session", id: "s1" })}\n${JSON.stringify({ type: "message", id: "m1" })}\n`,
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("session fence content confirmation (issue #35 W1b)", () => {
  it("re-arms (does not trip) on metadata-only jitter — mtime/ctime change, bytes intact", async () => {
    const controller = await makeController();
    await controller.releaseForPrompt();
    // Simulate network-FS attribute revalidation: change mtime/ctime with no
    // content change (utimes touches times but not size/bytes).
    const future = new Date(Date.now() + 60_000);
    utimesSync(sessionFile, future, future);

    // Must NOT throw — benign jitter re-arms and the turn continues.
    await expect(controller.withSessionWriteLock(async () => "ok")).resolves.toBe("ok");
    expect(controller.hasSessionTakeover()).toBe(false);
  });

  it("trips on a foreign append (size grew, baseline bytes intact)", async () => {
    const controller = await makeController();
    await controller.releaseForPrompt();
    appendFileSync(sessionFile, `${JSON.stringify({ type: "message", id: "foreign" })}\n`);

    await expect(controller.withSessionWriteLock(async () => "ok")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("trips on an in-place rewrite of the same size (baseline bytes changed)", async () => {
    const controller = await makeController();
    const originalSize = statSync(sessionFile).size;
    await controller.releaseForPrompt();
    // Overwrite with different content of the SAME byte length.
    const replacement = "X".repeat(originalSize);
    writeFileSync(sessionFile, replacement);
    expect(statSync(sessionFile).size).toBe(originalSize);

    await expect(controller.withSessionWriteLock(async () => "ok")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
  });

  it("trips on a truncation (size shrank)", async () => {
    const controller = await makeController();
    await controller.releaseForPrompt();
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "s1" })}\n`);

    await expect(controller.withSessionWriteLock(async () => "ok")).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
  });

  it("does not trip when the fence was never armed", async () => {
    const controller = await makeController();
    appendFileSync(sessionFile, "noise\n");
    // No releaseForPrompt → fence inactive → no check.
    await expect(controller.withSessionWriteLock(async () => "ok")).resolves.toBe("ok");
  });
});
