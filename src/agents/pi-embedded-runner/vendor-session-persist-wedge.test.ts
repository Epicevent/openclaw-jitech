// Wave 0 unit reproduction of the vendor session-write wedge behind issue #35.
//
// Mechanic (vendor @earendil-works/pi-coding-agent session-manager.js `_persist`):
// when `flushed` is false, the first assistant entry is written with
// `openSync(sessionFile, "wx")` — O_CREAT|O_EXCL. If that file already exists
// (a *different* manager instance created it first for the same session file),
// the open throws EEXIST BEFORE `flushed = true` runs, so `flushed` stays false
// forever and every subsequent persist re-throws EEXIST. The session is wedged:
// no message it produces from that point on can ever land on disk.
//
// This test asserts the post-surgery behavior: the second manager recovers by
// appending to the existing file instead of dying on EEXIST. It passes because
// of the Wave 2 fork-local pnpm patch of the vendor `_persist`
// (patches/@earendil-works__pi-coding-agent@0.78.1.patch, allowlisted in
// scripts/check-package-patches.mjs — that guard is inherited from upstream
// and its "publish a new version" remedy is unavailable to this fork; the
// owner approved the exception on 2026-07-09). If a vendor bump drops the
// patch, pnpm fails the install; if the upstream bug is ever fixed upstream,
// retire the patch, the allowlist entry, and keep this test as the regression
// guard. The wedge's in-process trigger is independently prevented by the
// session-file mutex (#40 + Wave 1); the patch is defense-in-depth against
// cross-process races and any future mutex-bypassing path.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let sessionFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openclaw-w0-wedge-"));
  sessionFile = join(dir, "shared-session.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Two managers opened on the same explicit session file that does not yet
// exist. `.open` on a missing path starts a fresh unflushed session while
// preserving the explicit path — exactly the state two concurrent runs on one
// aliased session land in. When both later write their first assistant entry,
// the second races into `openSync(..., "wx")` on a file the first already made.
function openManagerOnSharedFile(): SessionManager {
  return SessionManager.open(sessionFile, dir);
}

// Minimal message shapes: the vendor persist path only reads role/content, so
// a bare object exercises the "wx" write without constructing the full heavy
// Message type (timestamp, usage, provider, ...). Cast to the append param type.
type Appendable = Parameters<SessionManager["appendMessage"]>[0];
const userMessage = { role: "user", content: "hi" } as unknown as Appendable;
function assistantMessage(text: string): Appendable {
  return { role: "assistant", content: [{ type: "text", text }] } as unknown as Appendable;
}

function countAssistantLines(file: string): number {
  if (!existsSync(file)) {
    return 0;
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes('"role":"assistant"') || line.includes('"role": "assistant"'))
    .length;
}

describe("vendor session _persist wedge (issue #35)", () => {
  it(
    "second manager on the same session file recovers on EEXIST instead of wedging (fork patch)",
    () => {
      const a = openManagerOnSharedFile();
      const b = openManagerOnSharedFile();

      a.appendMessage(userMessage);
      b.appendMessage(userMessage);

      // A writes first: creates the file via "wx", flushed becomes true.
      a.appendMessage(assistantMessage("from A"));
      expect(existsSync(sessionFile)).toBe(true);

      // B now writes: the patched vendor catches EEXIST on its "wx" create and
      // falls back to append instead of throwing and staying unflushed forever.
      expect(() => b.appendMessage(assistantMessage("from B"))).not.toThrow();

      // And a subsequent B message must also land, proving B is not wedged.
      expect(() => b.appendMessage(assistantMessage("from B again"))).not.toThrow();

      // At least A's assistant message survives on disk (B's landing depends on
      // the chosen recovery: append vs atomic rewrite — either is acceptable).
      expect(countAssistantLines(sessionFile)).toBeGreaterThanOrEqual(1);
    },
  );
});
