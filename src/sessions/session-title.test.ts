import { describe, expect, test } from "vitest";
import { buildSessionTitleUserPrompt, sanitizeSuggestedSessionTitle } from "./session-title.js";

describe("sanitizeSuggestedSessionTitle", () => {
  test("trims and returns a plain title", () => {
    expect(sanitizeSuggestedSessionTitle("  Precursor synthesis plan  ")).toBe(
      "Precursor synthesis plan",
    );
  });

  test("keeps only the first line", () => {
    expect(sanitizeSuggestedSessionTitle("DMPBF4 deposition\nextra commentary")).toBe(
      "DMPBF4 deposition",
    );
  });

  test("strips wrapping straight and smart quotes and backticks", () => {
    expect(sanitizeSuggestedSessionTitle('"Cobalt run"')).toBe("Cobalt run");
    expect(sanitizeSuggestedSessionTitle("`build fix`")).toBe("build fix");
    expect(sanitizeSuggestedSessionTitle("“liquid phase”")).toBe("liquid phase");
  });

  test("collapses internal whitespace", () => {
    expect(sanitizeSuggestedSessionTitle("TDMAZr    vapor\tcheck")).toBe("TDMAZr vapor check");
  });

  test("drops trailing sentence punctuation", () => {
    expect(sanitizeSuggestedSessionTitle("Session about cobalt.")).toBe("Session about cobalt");
    expect(sanitizeSuggestedSessionTitle("Why did it crash?!")).toBe("Why did it crash");
  });

  test("caps overly long titles to 60 chars", () => {
    const long = "a".repeat(120);
    expect(sanitizeSuggestedSessionTitle(long)).toHaveLength(60);
  });

  test("returns empty string for empty or whitespace input", () => {
    expect(sanitizeSuggestedSessionTitle("")).toBe("");
    expect(sanitizeSuggestedSessionTitle("   ")).toBe("");
  });
});

describe("buildSessionTitleUserPrompt", () => {
  test("returns null when there is no usable context", () => {
    expect(buildSessionTitleUserPrompt({})).toBeNull();
    expect(
      buildSessionTitleUserPrompt({ firstUserMessage: "  ", lastMessagePreview: null }),
    ).toBeNull();
  });

  test("includes the first user message", () => {
    const prompt = buildSessionTitleUserPrompt({ firstUserMessage: "Help me deposit cobalt" });
    expect(prompt).toContain("First user message:");
    expect(prompt).toContain("Help me deposit cobalt");
  });

  test("includes the recent message only when it differs from the first", () => {
    const same = buildSessionTitleUserPrompt({
      firstUserMessage: "same text",
      lastMessagePreview: "same text",
    });
    expect(same).not.toContain("Most recent message:");

    const differs = buildSessionTitleUserPrompt({
      firstUserMessage: "open the run",
      lastMessagePreview: "now check NAS",
    });
    expect(differs).toContain("Most recent message:");
    expect(differs).toContain("now check NAS");
  });
});
