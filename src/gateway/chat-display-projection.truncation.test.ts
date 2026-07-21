// Regression for the customer report "긴 답변이 대시보드에서 잘린다": the
// chat.history display projection truncated assistant answers at a low
// per-block char cap while the stored transcript stayed intact. The default
// cap is now a payload safety valve (100k), not an answer-length limit.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  projectChatDisplayMessages,
  resolveEffectiveChatHistoryMaxChars,
} from "./chat-display-projection.js";

function assistantWith(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function projectedText(message: Record<string, unknown> | undefined): string {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return content.map((b) => (b as { text?: string })?.text ?? "").join("");
}

describe("chat.history display truncation cap", () => {
  it("does not truncate an ordinary long answer (the reported bug)", () => {
    // ~17k chars, the size that arrived truncated in the field.
    const answer = "번호 N: 잘림 여부 확인용 더미 문장입니다. ".repeat(700);
    expect(answer.length).toBeGreaterThan(8_000);
    expect(answer.length).toBeLessThan(DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS);

    const [projected] = projectChatDisplayMessages([assistantWith(answer)]);
    const out = projectedText(projected);
    expect(out).not.toContain("(truncated)");
    expect(out.length).toBe(answer.length);
  });

  it("does not truncate the largest block that actually exists in the fleet", () => {
    // Measured 2026-07-17 across all 14 customer slots: the biggest single stored text
    // block is 60,761 chars (oc14); nothing anywhere exceeds 100k. The default cap must
    // stay above the real ceiling, or the field keeps seeing "(truncated)".
    const FLEET_MAX_BLOCK_CHARS = 60_761;
    expect(DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS).toBeGreaterThan(FLEET_MAX_BLOCK_CHARS);

    const answer = "가".repeat(FLEET_MAX_BLOCK_CHARS);
    const [projected] = projectChatDisplayMessages([assistantWith(answer)]);
    const out = projectedText(projected);
    expect(out).not.toContain("(truncated)");
    expect(out.length).toBe(FLEET_MAX_BLOCK_CHARS);
  });

  it("still truncates a pathological block beyond the cap (safety valve intact)", () => {
    const huge = "x".repeat(DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS + 5_000);
    const [projected] = projectChatDisplayMessages([assistantWith(huge)]);
    const out = projectedText(projected);
    expect(out).toContain("(truncated)");
    expect(out.length).toBeLessThan(huge.length);
  });

  it("honors an explicit per-request maxChars override", () => {
    const answer = "a".repeat(5_000);
    const [projected] = projectChatDisplayMessages([assistantWith(answer)], { maxChars: 1_000 });
    expect(projectedText(projected)).toContain("(truncated)");
  });

  it("prefers a configured gateway.webchat.chatHistoryMaxChars", () => {
    expect(resolveEffectiveChatHistoryMaxChars({ gateway: { webchat: { chatHistoryMaxChars: 200 } } })).toBe(
      200,
    );
    expect(resolveEffectiveChatHistoryMaxChars({})).toBe(DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS);
    expect(resolveEffectiveChatHistoryMaxChars({}, 42)).toBe(42);
  });
});
