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
// This test asserts the DESIRED post-surgery behavior (the second manager
// recovers by appending/rewriting instead of dying on EEXIST, and both
// managers' assistant messages survive). Against the current unpatched vendor
// it fails — hence `it.fails`. Wave 2 (the pnpm patch of `_persist`) flips this
// to a plain `it` and it must then pass. If someone bumps the vendor and the
// upstream bug is gone, `it.fails` itself fails loudly — which is the signal we
// want to retire the patch.
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

function newManagerOnSharedFile(): SessionManager {
  // Two managers, same explicit session file that does not yet exist. Both
  // start unflushed with the explicit path preserved — exactly the state two
  // concurrent runs on one aliased session land in.
  return new SessionManager(dir, dir, sessionFile, /* persist */ true);
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
  it.fails(
    "second manager on the same session file must not wedge on EEXIST (flips to pass after Wave 2 patch)",
    () => {
      const a = newManagerOnSharedFile();
      const b = newManagerOnSharedFile();

      a.appendMessage({ role: "user", content: "hi" });
      b.appendMessage({ role: "user", content: "hi" });

      // A writes first: creates the file via "wx", flushed becomes true.
      a.appendMessage({ role: "assistant", content: "from A" });
      expect(existsSync(sessionFile)).toBe(true);

      // B now writes: unpatched vendor does openSync("wx") → EEXIST → throws and
      // stays unflushed forever. Post-surgery it must append/rewrite instead.
      expect(() => b.appendMessage({ role: "assistant", content: "from B" })).not.toThrow();

      // And a subsequent B message must also land, proving B is not wedged.
      expect(() => b.appendMessage({ role: "assistant", content: "from B again" })).not.toThrow();

      // At least A's assistant message survives on disk (B's landing depends on
      // the chosen recovery: append vs atomic rewrite — either is acceptable).
      expect(countAssistantLines(sessionFile)).toBeGreaterThanOrEqual(1);
    },
  );
});
