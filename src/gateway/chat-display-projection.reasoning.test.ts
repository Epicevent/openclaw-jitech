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

  // Issue #59: some models wrap the final answer in a bare <text>…</text> scaffold.
  it("unwraps a bare <text> scaffold wrapper (issue #59)", () => {
    const [msg] = projectChatDisplayMessages([
      assistantText("<text> 요청하신 이미지를 생성했습니다. </text>"),
    ]);
    const out = projectedText(msg);
    expect(out).not.toContain("<text>");
    expect(out).not.toContain("</text>");
    expect(out).toContain("요청하신 이미지를 생성했습니다.");
  });

  it("must NOT strip SVG <text x=…> elements (issue #59 — would break diagrams)", () => {
    const svg = '<svg width="20"><text x="1" y="2" fill="black">A</text><text x="5" y="6">B</text></svg>';
    const [msg] = projectChatDisplayMessages([assistantText(`<text>Here:\n${svg}</text>`)]);
    const out = projectedText(msg);
    expect(out).not.toMatch(/^<text>/); // the bare wrapper is gone
    expect(out).toContain(svg); // every attributed SVG <text …> survives verbatim
  });

  it("keeps a bare <text> that lives inside a code span (issue #59)", () => {
    const [msg] = projectChatDisplayMessages([
      assistantText("<text>Wrap answers in `<text>...</text>` like this.</text>"),
    ]);
    expect(projectedText(msg)).toContain("`<text>...</text>`");
  });
});

describe("chat.history hides internal inter-session tool deliveries (issue #60)", () => {
  it("hides an image_generate inter-session envelope rendered as a 'You' bubble", () => {
    const out = projectChatDisplayMessages([
      { role: "user", content: [{ type: "text", text: "빨간 원 이미지 만들어줘" }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "[Inter-session message] sourceSession=image_generate:abc sourceChannel=webchat " +
              "sourceTool=image_generate isUser=false\nThis content was routed by OpenClaw from " +
              "another session or internal tool.",
          },
        ],
      },
    ]);
    const joined = out.map(projectedText).join("\n");
    expect(joined).toContain("빨간 원 이미지 만들어줘"); // the real user turn stays
    expect(joined).not.toContain("Inter-session message"); // the plumbing envelope is gone
    expect(joined).not.toContain("image_generate");
  });

  it("keeps a media-bearing image_generate delivery but strips its envelope header (image must survive)", () => {
    const out = projectChatDisplayMessages([
      { role: "user", content: [{ type: "text", text: "별 이미지 만들어줘" }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "[Inter-session message] sourceSession=image_generate:abc sourceChannel=webchat " +
              "sourceTool=image_generate isUser=false\nThis content was routed by OpenClaw from " +
              "another session or internal tool.",
          },
          { type: "image", data: "/9j/2wBDAAUFBQUFBQUGBgUI" },
        ],
      },
    ]);
    // The alarming envelope header must be gone …
    expect(out.map(projectedText).join("\n")).not.toContain("Inter-session message");
    // … but the generated image block must still be present (NOT hidden with it).
    const hasImage = out.some(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as Array<{ type?: string }>).some((b) => b?.type === "image"),
    );
    expect(hasImage).toBe(true);
  });

  it("normalizes an inline {type:image,data,mimeType} block into renderable source.base64 (root fix)", () => {
    const [msg] = projectChatDisplayMessages([
      { role: "assistant", content: [{ type: "image", data: "/9j/2wBDAAUF", mimeType: "image/jpeg" }] },
    ]);
    const block = (msg.content as Array<Record<string, unknown>>).find((b) => b.type === "image");
    expect(block).toBeTruthy();
    // The base64 must NOT be gutted — it must survive under the shape the client renders.
    expect(block?.data).toBeUndefined();
    const source = block?.source as Record<string, unknown> | undefined;
    expect(source?.type).toBe("base64");
    expect(source?.data).toBe("/9j/2wBDAAUF");
    expect(source?.media_type).toBe("image/jpeg");
  });

  it("still keeps a genuine cross-session message (not a hideable tool)", () => {
    const out = projectChatDisplayMessages([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "[Inter-session message] sourceSession=agent:main:other sourceChannel=webchat\nHello from another session.",
          },
        ],
      },
    ]);
    expect(out.map(projectedText).join("\n")).toContain("Hello from another session.");
  });
});
