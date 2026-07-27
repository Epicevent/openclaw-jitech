import { beforeEach, describe, expect, it, vi } from "vitest";

const loadProviderUsageLedgerSummary = vi.hoisted(() => vi.fn());

vi.mock("../../agents/provider-usage-ledger-summary.js", () => ({
  loadProviderUsageLedgerSummary,
}));

import { usageHandlers } from "./usage.js";

async function requestProviderLedger(params: Record<string, unknown>) {
  const respond = vi.fn();
  await usageHandlers["usage.providerLedger"]({
    params,
    respond,
  } as unknown as Parameters<(typeof usageHandlers)["usage.providerLedger"]>[0]);
  return respond;
}

describe("usage.providerLedger", () => {
  beforeEach(() => {
    loadProviderUsageLedgerSummary.mockReset();
  });

  it("returns the immutable receipt summary for the requested date range", async () => {
    const summary = { source: "immutable_provider_call_receipts", receiptCount: 2 };
    loadProviderUsageLedgerSummary.mockReturnValue(summary);

    const respond = await requestProviderLedger({
      startDate: "2026-07-27",
      endDate: "2026-07-27",
      mode: "utc",
    });

    expect(loadProviderUsageLedgerSummary).toHaveBeenCalledWith({
      startMs: Date.UTC(2026, 6, 27),
      endMs: Date.UTC(2026, 6, 28) - 1,
    });
    expect(respond).toHaveBeenCalledWith(true, summary, undefined);
  });

  it("fails closed when the receipt ledger cannot be read", async () => {
    loadProviderUsageLedgerSummary.mockImplementation(() => {
      throw new Error("ledger file is missing");
    });

    const respond = await requestProviderLedger({ range: "all" });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("ledger file is missing"),
      }),
    );
  });
});
