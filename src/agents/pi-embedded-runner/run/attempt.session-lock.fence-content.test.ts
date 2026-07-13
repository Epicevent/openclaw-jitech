// W1b fix: the takeover fence must decide on CONTENT, not stat metadata.
// Ground truth from a reproducing slot: the transcript grows by this run's own
// IN-PLACE appends (size 6750->7905->...; ino constant; ctime==mtime moving
// with size) — a stat-only fence mis-read those own appends as a foreign
// takeover and aborted the turn (issue #35). The fence now re-hashes the
// baseline byte span: any tail-preserving growth (an append — ours or a queued
// follow-up) re-arms and continues; only a destructive rewrite or truncation
// still throws.
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

  it("re-arms (does not trip) on an in-place append — the run's own turn growth", async () => {
    const controller = await makeController();
    await controller.releaseForPrompt();
    // Simulate the run appending its next transcript entry (tool result /
    // streamed reply). Baseline bytes stay intact; the file only grows.
    appendFileSync(sessionFile, `${JSON.stringify({ type: "message", id: "own-append" })}\n`);

    await expect(controller.withSessionWriteLock(async () => "ok")).resolves.toBe("ok");
    expect(controller.hasSessionTakeover()).toBe(false);
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
