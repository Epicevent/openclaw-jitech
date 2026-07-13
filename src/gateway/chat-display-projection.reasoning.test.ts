// Issue #57: chat.history display projection must strip the model's
// <think>/<final> reasoning scaffolding from assistant text (mirroring the
// streaming delivery path), so re-opening a conversation shows clean prose and
// renders inline base64 images that were trapped inside the raw <final> block.
import { describe, expect, it } from "vitest";
import { projectChatDisplayMessages } from "./chat-display-projection.js";

function assistantText(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}
function projectedText(message: Record<string, unknown> | undefined): string {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((b) => (b as { text?: string })?.text ?? "").join("");
}

describe("chat.history reasoning-tag stripping (issue #57)", () => {
  it("unwraps <final> and drops <think> from assistant history text", () => {
    const [msg] = projectChatDisplayMessages([
      assistantText("<think>internal reasoning here</think><final>Here is the answer.</final>"),
    ]);
    const out = projectedText(msg);
    expect(out).not.toContain("<final>");
    expect(out).not.toContain("<think>");
    expect(out).not.toContain("internal reasoning");
    expect(out).toContain("Here is the answer.");
  });

  it("preserves an inline base64 image that was trapped inside <final>", () => {
    const img = "![diagram](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)";
    const [msg] = projectChatDisplayMessages([assistantText(`<final>여기 그림입니다.\n${img}</final>`)]);
    const out = projectedText(msg);
    expect(out).not.toContain("<final>");
    expect(out).toContain(img); // the data-URI markdown survives → dashboard renders it
  });

  it("leaves a plain answer (no reasoning tags) untouched", () => {
    const [msg] = projectChatDisplayMessages([assistantText("Just a normal answer, no tags.")]);
    expect(projectedText(msg)).toBe("Just a normal answer, no tags.");
  });

  it("does not strip <final> the USER literally typed", () => {
    const [msg] = projectChatDisplayMessages([
      { role: "user", content: [{ type: "text", text: "why does <final>x</final> show up?" }] },
    ]);
    expect(projectedText(msg)).toContain("<final>x</final>");
  });

  it("keeps an example <final> that lives inside a code span", () => {
    const [msg] = projectChatDisplayMessages([
      assistantText("<final>Use the `<final>...</final>` wrapper like this.</final>"),
    ]);
    const out = projectedText(msg);
    expect(out).toContain("`<final>...</final>`");
  });
});
