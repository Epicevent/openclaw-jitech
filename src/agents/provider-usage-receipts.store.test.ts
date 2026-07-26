import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendProviderUsageReceipt,
  closeProviderUsageReceiptStore,
  exportProviderUsageReceipts,
  ProviderUsageReceiptConflictError,
} from "./provider-usage-receipts.store.js";
import {
  PROVIDER_USAGE_CALL_SCHEMA,
  PROVIDER_USAGE_EXPORT_SCHEMA,
  type ProviderUsageCallReceiptBody,
} from "./provider-usage-receipts.types.js";

function buildReceipt(callId: string, completedAt = "2026-07-24T00:00:01.000Z") {
  return {
    schema: PROVIDER_USAGE_CALL_SCHEMA,
    callId,
    runId: "run-1",
    turnId: "turn-1",
    requestId: "request-1",
    sessionId: "session-1",
    trigger: "user",
    attempt: 1,
    retryOf: null,
    fallbackParent: null,
    startedAt: "2026-07-24T00:00:00.000Z",
    completedAt,
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
      inputTotal: 12,
      inputNonCached: 10,
      cacheRead: 2,
      cacheWrite: null,
      outputCandidates: 4,
      reasoningThinking: 3,
      toolUsePrompt: null,
      providerReportedTotal: 19,
      rawProviderUsage: {
        source: "gemini_response.usageMetadata",
        promptTokenCount: 12,
        cachedContentTokenCount: 2,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 3,
        toolUsePromptTokenCount: null,
        totalTokenCount: 19,
      },
    },
    usageCoverage: "partial",
    missingUsageFields: ["cacheWrite", "toolUsePrompt"],
    finishReason: "STOP",
    errorCategory: null,
  } satisfies ProviderUsageCallReceiptBody;
}

describe("provider usage receipt store", () => {
  let stateDir: string;

  beforeEach(async () => {
    closeProviderUsageReceiptStore();
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-provider-usage-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    closeProviderUsageReceiptStore();
    vi.unstubAllEnvs();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("assigns a monotonic ledger sequence and exports incrementally", () => {
    const first = appendProviderUsageReceipt(buildReceipt("call-1"));
    const second = appendProviderUsageReceipt(buildReceipt("call-2"));

    expect(first.ledgerSeq).toBe(1);
    expect(second.ledgerSeq).toBeGreaterThan(first.ledgerSeq);

    const pageOne = exportProviderUsageReceipts({ after: 0, limit: 1 });
    expect(pageOne).toMatchObject({
      schema: PROVIDER_USAGE_EXPORT_SCHEMA,
      after: 0,
      nextAfter: first.ledgerSeq,
      hasMore: true,
    });
    expect(pageOne.receipts.map((receipt) => receipt.callId)).toEqual(["call-1"]);

    const pageTwo = exportProviderUsageReceipts({ after: pageOne.nextAfter, limit: 1 });
    expect(pageTwo.hasMore).toBe(false);
    expect(pageTwo.receipts.map((receipt) => receipt.callId)).toEqual(["call-2"]);
  });

  it("accepts only byte-identical replay for an existing call id", () => {
    const body = buildReceipt("call-replay");
    const first = appendProviderUsageReceipt(body);
    const replay = appendProviderUsageReceipt(body);

    expect(replay.ledgerSeq).toBe(first.ledgerSeq);
    expect(replay.receiptDigest).toBe(first.receiptDigest);
    expect(exportProviderUsageReceipts().receipts).toHaveLength(1);

    expect(() =>
      appendProviderUsageReceipt(buildReceipt("call-replay", "2026-07-24T00:00:02.000Z")),
    ).toThrow(ProviderUsageReceiptConflictError);
    expect(exportProviderUsageReceipts().receipts).toHaveLength(1);
  });

  it("reopens persisted receipts without creating state during an empty read", () => {
    const emptyDir = path.join(stateDir, "unused");
    const empty = exportProviderUsageReceipts({ env: { OPENCLAW_STATE_DIR: emptyDir } });
    expect(empty.receipts).toEqual([]);

    appendProviderUsageReceipt(buildReceipt("call-persisted"));
    closeProviderUsageReceiptStore();
    const reopened = exportProviderUsageReceipts();

    expect(reopened.receipts).toHaveLength(1);
    expect(reopened.receipts[0]?.callId).toBe("call-persisted");
  });
});
