import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProviderUsageReceiptDbPath } from "./provider-usage-receipts.paths.js";
import {
  appendProviderUsageReceipt,
  closeProviderUsageReceiptStore,
  exportProviderUsageReceipts,
  ProviderUsageReceiptConflictError,
  ProviderUsageReceiptLedgerUnavailableError,
} from "./provider-usage-receipts.store.js";
import {
  PROVIDER_USAGE_CALL_SCHEMA,
  PROVIDER_USAGE_EXPORT_SCHEMA,
  type ProviderUsageCallReceiptBody,
} from "./provider-usage-receipts.types.js";

const CALL_IDS = {
  first: "11111111-1111-4111-8111-111111111111",
  second: "22222222-2222-4222-8222-222222222222",
  replay: "33333333-3333-4333-8333-333333333333",
  persisted: "44444444-4444-4444-8444-444444444444",
} as const;

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
    fallbackIndex: 0,
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
      serviceTier: "standard",
      rawProviderUsage: {
        promptTokenCount: 12,
        cachedContentTokenCount: 2,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 3,
        toolUsePromptTokenCount: null,
        totalTokenCount: 19,
        serviceTier: "standard",
      },
    },
    usageCoverage: "partial",
    missingUsageFields: ["cacheWrite", "toolUsePrompt"],
    receiptCoverage: "partial",
    missingReceiptFields: ["usage.cacheWrite", "usage.toolUsePrompt"],
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
    const first = appendProviderUsageReceipt(buildReceipt(CALL_IDS.first));
    const second = appendProviderUsageReceipt(buildReceipt(CALL_IDS.second));

    expect(first.ledgerSeq).toBe(1);
    expect(second.ledgerSeq).toBeGreaterThan(first.ledgerSeq);

    const pageOne = exportProviderUsageReceipts({ after: 0, limit: 1 });
    expect(pageOne).toMatchObject({
      schema: PROVIDER_USAGE_EXPORT_SCHEMA,
      after: 0,
      nextCursor: first.ledgerSeq,
      highWatermark: second.ledgerSeq,
      count: 1,
      hasMore: true,
    });
    expect(pageOne.receipts.map((receipt) => receipt.callId)).toEqual([CALL_IDS.first]);

    const pageTwo = exportProviderUsageReceipts({ after: pageOne.nextCursor, limit: 1 });
    expect(pageTwo.hasMore).toBe(false);
    expect(pageTwo.highWatermark).toBe(second.ledgerSeq);
    expect(pageTwo.count).toBe(1);
    expect(pageTwo.receipts.map((receipt) => receipt.callId)).toEqual([CALL_IDS.second]);
  });

  it("accepts only byte-identical replay for an existing call id", () => {
    const body = buildReceipt(CALL_IDS.replay);
    const first = appendProviderUsageReceipt(body);
    const replay = appendProviderUsageReceipt(body);

    expect(replay.ledgerSeq).toBe(first.ledgerSeq);
    expect(replay.receiptDigest).toBe(first.receiptDigest);
    expect(exportProviderUsageReceipts().receipts).toHaveLength(1);

    expect(() =>
      appendProviderUsageReceipt(buildReceipt(CALL_IDS.replay, "2026-07-24T00:00:02.000Z")),
    ).toThrow(ProviderUsageReceiptConflictError);
    expect(exportProviderUsageReceipts().receipts).toHaveLength(1);
  });

  it("fails closed without creating state when the ledger is missing", () => {
    const emptyDir = path.join(stateDir, "unused");
    const dbPath = resolveProviderUsageReceiptDbPath({ OPENCLAW_STATE_DIR: emptyDir });

    expect(() => exportProviderUsageReceipts({ env: { OPENCLAW_STATE_DIR: emptyDir } })).toThrow(
      ProviderUsageReceiptLedgerUnavailableError,
    );
    expect(existsSync(dbPath)).toBe(false);
  });

  it("reopens persisted receipts read-only", () => {
    appendProviderUsageReceipt(buildReceipt(CALL_IDS.persisted));
    closeProviderUsageReceiptStore();
    const reopened = exportProviderUsageReceipts();

    expect(reopened.receipts).toHaveLength(1);
    expect(reopened.receipts[0]?.callId).toBe(CALL_IDS.persisted);
  });

  it("fails closed when the requested cursor is ahead of the ledger", () => {
    appendProviderUsageReceipt(buildReceipt(CALL_IDS.persisted));

    expect(() => exportProviderUsageReceipts({ after: 2 })).toThrow(/ledger moved backwards/u);
  });

  it("fails instead of treating a corrupt ledger as verified empty", async () => {
    const corruptDir = path.join(stateDir, "corrupt");
    const dbPath = resolveProviderUsageReceiptDbPath({ OPENCLAW_STATE_DIR: corruptDir });
    await mkdir(path.dirname(dbPath), { recursive: true });
    await writeFile(dbPath, "not a sqlite ledger", "utf8");

    expect(() =>
      exportProviderUsageReceipts({ env: { OPENCLAW_STATE_DIR: corruptDir } }),
    ).toThrow();
  });
});
