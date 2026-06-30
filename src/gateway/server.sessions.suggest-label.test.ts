import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

// The handler's only external dependency is the model completion. Stub it so the
// in-process gateway exercises the whole pipeline (target resolution → transcript
// read → prompt build → sanitize → respond) deterministically, without a provider.
const completionState: { raw: string; prepareError: string | null } = {
  raw: "",
  prepareError: null,
};

vi.mock("../agents/simple-completion-runtime.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    prepareSimpleCompletionModelForAgent: vi.fn(async () =>
      completionState.prepareError
        ? { error: completionState.prepareError }
        : {
            selection: { provider: "ollama", modelId: "test", agentDir: "/tmp" },
            model: {},
            auth: { apiKey: "test-key", mode: "api-key" },
          },
    ),
    completeWithPreparedSimpleCompletionModel: vi.fn(async () => ({ raw: completionState.raw })),
  };
});

vi.mock("../agents/pi-embedded-utils.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    extractAssistantText: (response: { raw?: string }) => response?.raw ?? "",
  };
});

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

type SuggestPayload = { ok: boolean; key: string; suggestion: string };

async function seedTranscript(dir: string, sessionId: string, firstUserMessage: string) {
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "user", content: firstUserMessage } }),
    ].join("\n"),
    "utf-8",
  );
}

beforeEach(() => {
  completionState.raw = "";
  completionState.prepareError = null;
});

test("sessions.suggestLabel returns a sanitized AI title derived from the transcript", async () => {
  const { dir } = await createSessionStoreDir();
  await seedTranscript(dir, "sess-suggest-ok", "Help me deposit cobalt onto the wafer");
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-suggest-ok") } });
  // Model returns a quoted, punctuated title; the handler must clean it up.
  completionState.raw = '  "Cobalt deposition run."  ';

  const res = await directSessionReq<SuggestPayload>("sessions.suggestLabel", { key: "main" });
  expect(res.ok).toBe(true);
  expect(res.payload?.suggestion).toBe("Cobalt deposition run");
});

test("sessions.suggestLabel returns an empty suggestion when the session has no transcript", async () => {
  await createSessionStoreDir();
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-suggest-empty") } });

  const res = await directSessionReq<SuggestPayload>("sessions.suggestLabel", { key: "main" });
  expect(res.ok).toBe(true);
  expect(res.payload?.suggestion).toBe("");
});

test("sessions.suggestLabel returns an empty suggestion for an unknown session key", async () => {
  await createSessionStoreDir();
  await writeSessionStore({ entries: {} });

  const res = await directSessionReq<SuggestPayload>("sessions.suggestLabel", {
    key: "does-not-exist",
  });
  expect(res.ok).toBe(true);
  expect(res.payload?.suggestion).toBe("");
});

test("sessions.suggestLabel surfaces an error when the model is unavailable", async () => {
  const { dir } = await createSessionStoreDir();
  await seedTranscript(dir, "sess-suggest-unavail", "anything at all");
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-suggest-unavail") } });
  completionState.prepareError = "No model configured for agent.";

  const res = await directSessionReq<SuggestPayload>("sessions.suggestLabel", { key: "main" });
  expect(res.ok).toBe(false);
});
