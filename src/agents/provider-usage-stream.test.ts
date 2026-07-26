import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeProviderUsageReceiptStore,
  exportProviderUsageReceipts,
} from "./provider-usage-receipts.store.js";
import { wrapStreamFnWithProviderUsageReceipts } from "./provider-usage-stream.js";

function finalMessage(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "content is never stored" }],
    api: "google-generative-ai",
    provider: "google",
    model: "gemini-3.6-flash",
    stopReason,
    timestamp: Date.now(),
    responseId: "response-1",
    responseModel: "gemini-3.6-flash-001",
    responseModelEvidenceSource: "gemini_response.modelVersion",
    providerFinishReason: stopReason,
    providerUsage: {
      source: "gemini_response.usageMetadata",
      promptTokenCount: 11,
      cachedContentTokenCount: 2,
      candidatesTokenCount: 5,
      thoughtsTokenCount: 3,
      toolUsePromptTokenCount: 1,
      totalTokenCount: 20,
    },
    usage: {
      input: 9,
      output: 5,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 16,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as AssistantMessage;
}

function fakeStream(message: AssistantMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done", message };
    },
    async result() {
      return message;
    },
  };
}

describe("wrapStreamFnWithProviderUsageReceipts", () => {
  afterEach(() => {
    closeProviderUsageReceiptStore();
    vi.unstubAllEnvs();
  });

  it("persists a result-only call with unknown internal identity and provider evidence", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-provider-result-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      const message = finalMessage();
      const wrapped = wrapStreamFnWithProviderUsageReceipts(
        (_model: { provider: string; id: string }) => fakeStream(message),
      );

      const stream = await wrapped({ provider: "google", id: "gemini-3.6-flash" }, undefined);
      await expect(stream.result()).resolves.toBe(message);

      expect(exportProviderUsageReceipts().receipts).toMatchObject([
        {
          runId: null,
          turnId: null,
          requestId: null,
          sessionId: null,
          trigger: "unknown",
          status: "succeeded",
          configured: { provider: "google", model: "gemini-3.6-flash" },
          requested: { provider: "google", model: "gemini-3.6-flash" },
          actual: {
            provider: "google",
            model: "gemini-3.6-flash-001",
            responseId: "response-1",
            evidenceSource: "gemini_response.modelVersion",
          },
          usage: {
            inputTotal: 11,
            inputNonCached: 9,
            cacheRead: 2,
            outputCandidates: 5,
            reasoningThinking: 3,
            toolUsePrompt: 1,
            providerReportedTotal: 20,
          },
        },
      ]);
      expect(JSON.stringify(exportProviderUsageReceipts())).not.toContain(
        "content is never stored",
      );
    } finally {
      closeProviderUsageReceiptStore();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not duplicate a receipt when result and iterator both consume the stream", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-provider-once-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      const wrapped = wrapStreamFnWithProviderUsageReceipts(
        (_model: { provider: string; id: string }) => fakeStream(finalMessage()),
      );
      const stream = await wrapped({ provider: "google", id: "gemini-3.6-flash" }, undefined);

      await stream.result();
      for await (const event of stream) {
        void event;
        // drain
      }

      expect(exportProviderUsageReceipts().receipts).toHaveLength(1);
    } finally {
      closeProviderUsageReceiptStore();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
