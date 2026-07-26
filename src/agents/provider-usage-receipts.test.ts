import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProviderUsageRunContext,
  observeProviderUsageCallChunk,
  persistProviderUsageCall,
} from "./provider-usage-receipts.js";
import {
  closeProviderUsageReceiptStore,
  exportProviderUsageReceipts,
} from "./provider-usage-receipts.store.js";

describe("provider usage call receipts", () => {
  let stateDir: string;

  beforeEach(async () => {
    closeProviderUsageReceiptStore();
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-provider-call-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    closeProviderUsageReceiptStore();
    vi.unstubAllEnvs();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("keeps tool-loop calls separate and links retries and fallback calls", () => {
    const run = createProviderUsageRunContext({
      runId: "run-1",
      turnId: "turn-1",
      requestId: "request-1",
      sessionId: "session-1",
      trigger: "user",
      configuredProvider: "google",
      configuredModel: "gemini-3.6-flash",
    });
    const first = run.beginCall({
      requestedProvider: "google",
      requestedModel: "gemini-3.6-flash",
      embeddedAttempt: 1,
    });
    const toolLoop = run.beginCall({
      requestedProvider: "google",
      requestedModel: "gemini-3.6-flash",
      embeddedAttempt: 1,
    });
    const retry = run.beginCall({
      requestedProvider: "google",
      requestedModel: "gemini-3.6-flash",
      embeddedAttempt: 2,
    });
    const fallback = run.beginCall({
      requestedProvider: "anthropic",
      requestedModel: "claude-sonnet-4-6",
      embeddedAttempt: 1,
    });

    expect([first.attempt, toolLoop.attempt, retry.attempt, fallback.attempt]).toEqual([
      1, 2, 3, 4,
    ]);
    expect(first.trigger).toBe("user");
    expect(first.retryOf).toBeNull();
    expect(toolLoop.retryOf).toBeNull();
    expect(retry.retryOf).toBe(toolLoop.callId);
    expect(retry.fallbackParent).toBeNull();
    expect(fallback.retryOf).toBeNull();
    expect(fallback.fallbackParent).toBe(retry.callId);
    expect(fallback.configured).toEqual({ provider: "google", model: "gemini-3.6-flash" });

    const primaryCycleRetry = run.beginCall({
      requestedProvider: "google",
      requestedModel: "gemini-3.6-flash",
      embeddedAttempt: 1,
    });
    expect(primaryCycleRetry.retryOf).toBe(retry.callId);
    expect(primaryCycleRetry.fallbackParent).toBe(fallback.callId);
  });

  it("preserves Google raw usage and provider model evidence without content", () => {
    const run = createProviderUsageRunContext({
      runId: "run-2",
      configuredProvider: "google",
      configuredModel: "gemini-3.6-flash",
    });
    const handle = run.beginCall({
      requestedProvider: "google",
      requestedModel: "gemini-3.6-flash",
      embeddedAttempt: 1,
      startedAtMs: 1,
    });
    const observation = observeProviderUsageCallChunk(undefined, {
      type: "done",
      message: {
        responseId: "response-2",
        responseModel: "gemini-3.6-flash-001",
        responseModelEvidenceSource: "gemini_response.modelVersion",
        providerFinishReason: "STOP",
        providerUsage: {
          source: "gemini_response.usageMetadata",
          promptTokenCount: 100,
          cachedContentTokenCount: 20,
          candidatesTokenCount: 15,
          thoughtsTokenCount: 5,
          toolUsePromptTokenCount: 3,
          totalTokenCount: 123,
        },
        content: "secret prompt and response must never be stored",
      },
    });
    const receipt = persistProviderUsageCall({
      handle,
      completedAtMs: 2,
      status: "succeeded",
      observation,
    });

    expect(receipt.actual).toEqual({
      provider: "google",
      model: "gemini-3.6-flash-001",
      responseId: "response-2",
      evidenceSource: "gemini_response.modelVersion",
    });
    expect(receipt.usage).toMatchObject({
      inputTotal: 100,
      inputNonCached: 80,
      cacheRead: 20,
      cacheWrite: null,
      outputCandidates: 15,
      reasoningThinking: 5,
      toolUsePrompt: 3,
      providerReportedTotal: 123,
    });
    expect(receipt.usageCoverage).toBe("partial");
    expect(receipt.missingUsageFields).toEqual(["cacheWrite"]);
    expect(JSON.stringify(exportProviderUsageReceipts())).not.toContain("secret prompt");
  });

  it("represents unavailable usage as null instead of zero", () => {
    const run = createProviderUsageRunContext({
      runId: "run-3",
      configuredProvider: "google",
      configuredModel: "gemini-3.6-flash",
    });
    const receipt = persistProviderUsageCall({
      handle: run.beginCall({
        requestedProvider: "google",
        requestedModel: "gemini-3.6-flash",
        embeddedAttempt: 1,
      }),
      status: "failed",
      errorCategory: "timeout",
    });

    expect(receipt.usageCoverage).toBe("unavailable");
    expect(receipt.usage.inputTotal).toBeNull();
    expect(receipt.usage.outputCandidates).toBeNull();
    expect(receipt.actual.model).toBeNull();
    expect(receipt.errorCategory).toBe("timeout");
  });

  it("does not promote an unevidenced selected response model to actual truth", () => {
    const observation = observeProviderUsageCallChunk(undefined, {
      type: "done",
      message: {
        provider: "google",
        model: "gemini-3.6-flash",
        responseModel: "gemini-3.6-flash",
        usage: { input: 1, output: 1 },
      },
    });

    expect(observation.responseModel).toBeNull();
    expect(observation.responseModelEvidenceSource).toBeNull();
  });
});
