import fs from "node:fs";
import path from "node:path";

// One in-process mutex per session file.
//
// The cross-process session write lock is deliberately RELEASED during the model
// prompt (see attempt.session-lock.ts `releaseForPrompt`), so by itself it cannot
// keep two in-process runs off one session file for the whole run. That is exactly
// how concurrent runs on one file corrupt it: run B writes during run A's prompt
// window, A's fingerprint fence fires `EmbeddedAttemptSessionTakeoverError`, and the
// session manager's O_EXCL recreate then EEXIST-cascades into a customer blackout
// (issue #35).
//
// Holding this mutex around an attempt — the whole thing, prompt included —
// serializes every in-process run that resolves to the same session file, while the
// cross-process file lock + fence remain the guard against other OS processes.
const sessionFileMutexes = new Map<string, Promise<void>>();

// Normalize the same way the session write lock does (resolve, then realpath the
// containing directory) so a file maps to one key regardless of how the path was
// expressed. Mirrors `resolveNormalizedSessionFile` in agents/session-write-lock.ts,
// but synchronous: the sessions directory always exists by the time a run executes.
function resolveSessionFileMutexKey(sessionFile: string): string {
  const resolved = path.resolve(sessionFile);
  try {
    const normalizedDir = fs.realpathSync(path.dirname(resolved));
    return path.join(normalizedDir, path.basename(resolved));
  } catch {
    return resolved;
  }
}

/**
 * Run `fn` while holding the in-process mutex for `sessionFile`. Calls for the same
 * file run strictly one at a time (FIFO); calls for different files run in parallel.
 * A falsy `sessionFile` runs `fn` unguarded (nothing to serialize on).
 */
export async function withSessionFileMutex<T>(
  sessionFile: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const key = sessionFile?.trim() ? resolveSessionFileMutexKey(sessionFile) : "";
  if (!key) {
    return await fn();
  }
  const previous = sessionFileMutexes.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  sessionFileMutexes.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    releaseCurrent();
    if (sessionFileMutexes.get(key) === tail) {
      sessionFileMutexes.delete(key);
    }
  }
}
