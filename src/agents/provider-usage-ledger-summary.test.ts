import { beforeEach, describe, expect, it, vi } from "vitest";
import coverageFixture from "./provider-usage-coverage.fixture.json" with { type: "json" };
import type { ProviderUsageCoverageManifest } from "./provider-usage-coverage.js";
import receiptFixture from "./provider-usage-receipts.fixture.json" with { type: "json" };
import type {
  ProviderUsageCallReceipt,
  ProviderUsageReceiptExport,
} from "./provider-usage-receipts.types.js";

const exportProviderUsageReceipts = vi.hoisted(() => vi.fn());

vi.mock("./provider-usage-receipts.store.js", () => ({
  exportProviderUsageReceipts,
}));

import { loadProviderUsageLedgerSummary } from "./provider-usage-ledger-summary.js";

const firstReceipt = receiptFixture as ProviderUsageCallReceipt;
const manifest = coverageFixture as ProviderUsageCoverageManifest;

function exportPage(receipts: ProviderUsageCallReceipt[]): ProviderUsageReceiptExport {
  return {
    schema: "jitech-provider-usage-export/v1",
    after: 0,
    nextCursor: receipts.at(-1)?.ledgerSeq ?? 0,
    highWatermark: receipts.at(-1)?.ledgerSeq ?? 0,
    count: receipts.length,
    hasMore: false,
    receipts,
    coverageManifests: receipts.length > 0 ? [manifest] : [],
  };
}

describe("loadProviderUsageLedgerSummary", () => {
  beforeEach(() => {
    exportProviderUsageReceipts.mockReset();
  });

  it("preserves unavailable dimensions instead of turning missing values into zero", () => {
    const secondReceipt: ProviderUsageCallReceipt = {
      ...firstReceipt,
      ledgerSeq: 2,
      receiptDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      callId: "00000000-0000-4000-8000-000000000102",
      completedAt: "1970-01-01T00:00:03.000Z",
      actual: {
        provider: null,
        model: null,
        responseId: null,
        evidenceSource: null,
      },
      usage: {
        ...firstReceipt.usage,
        cacheWrite: 6,
      },
    };
    exportProviderUsageReceipts.mockReturnValue(exportPage([firstReceipt, secondReceipt]));

    const summary = loadProviderUsageLedgerSummary({ startMs: 0, endMs: 10_000 });

    expect(summary.source).toBe("immutable_provider_call_receipts");
    expect(summary.receiptCount).toBe(2);
    expect(summary.usage.inputTotal).toEqual({
      total: 200,
      knownSubtotal: 200,
      knownReceipts: 2,
      receiptCount: 2,
      coverage: "complete",
    });
    expect(summary.usage.cacheWrite).toEqual({
      total: null,
      knownSubtotal: 6,
      knownReceipts: 1,
      receiptCount: 2,
      coverage: "partial",
    });
    expect(summary.actualModelCoverage).toBe("partial");
    expect(summary.cost).toEqual({
      status: "unavailable",
      amountUsd: null,
      reason: "pricing_not_in_provider_receipt_ledger",
    });
  });

  it("filters immutable receipts by the requested time range", () => {
    exportProviderUsageReceipts.mockReturnValue(exportPage([firstReceipt]));
    const summary = loadProviderUsageLedgerSummary({ startMs: 3_000, endMs: 4_000 });
    expect(summary.receiptCount).toBe(0);
    expect(summary.usage.inputTotal.total).toBeNull();
    expect(summary.usage.inputTotal.knownSubtotal).toBeNull();
    expect(summary.producerCoverage).toBe("unavailable");
  });
});
