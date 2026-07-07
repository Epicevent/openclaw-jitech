import { describe, expect, it } from "vitest";
import { parseSessionFolderPath } from "./session-folder.js";

describe("parseSessionFolderPath", () => {
  it("canonicalizes segments (trim, drop empties, join)", () => {
    expect(parseSessionFolderPath(" 전구체 / 액상 ")).toEqual({
      ok: true,
      folderPath: "전구체/액상",
    });
    expect(parseSessionFolderPath("/a//b/")).toEqual({ ok: true, folderPath: "a/b" });
  });

  it("NFC-normalizes Korean input", () => {
    const nfd = "전구체".normalize("NFD");
    const parsed = parseSessionFolderPath(nfd);
    expect(parsed).toEqual({ ok: true, folderPath: "전구체" });
  });

  it("rejects empty, non-string, and control characters", () => {
    expect(parseSessionFolderPath("").ok).toBe(false);
    expect(parseSessionFolderPath("   /  ").ok).toBe(false);
    expect(parseSessionFolderPath(42).ok).toBe(false);
    expect(parseSessionFolderPath("a\tb").ok).toBe(false);
  });

  it("allows spaces inside folder names", () => {
    expect(parseSessionFolderPath("연구 자료/고체 전구체")).toEqual({
      ok: true,
      folderPath: "연구 자료/고체 전구체",
    });
  });

  it("rejects dot segments and over-limits", () => {
    expect(parseSessionFolderPath("a/../b").ok).toBe(false);
    expect(parseSessionFolderPath("a/b/c/d/e").ok).toBe(false);
    expect(parseSessionFolderPath("x".repeat(61)).ok).toBe(false);
  });
});
