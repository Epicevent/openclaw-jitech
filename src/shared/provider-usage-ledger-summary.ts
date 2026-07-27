export const PROVIDER_USAGE_LEDGER_SUMMARY_SOURCE = "immutable_provider_call_receipts" as const;

export type ProviderUsageLedgerDimension = {
  total: number | null;
  knownSubtotal: number | null;
  knownReceipts: number;
  receiptCount: number;
  coverage: "complete" | "partial" | "unavailable";
};

export type ProviderUsageLedgerSummary = {
  source: typeof PROVIDER_USAGE_LEDGER_SUMMARY_SOURCE;
  startAt: string;
  endAt: string;
  highWatermark: number;
  receiptCount: number;
  lastReceiptAt: string | null;
  statusCounts: {
    succeeded: number;
    failed: number;
    interrupted: number;
    cancelled: number;
  };
  actualModels: Array<{
    provider: string | null;
    model: string | null;
    callCount: number;
  }>;
  actualModelCoverage: "complete" | "partial" | "unavailable";
  usage: {
    inputTotal: ProviderUsageLedgerDimension;
    inputNonCached: ProviderUsageLedgerDimension;
    cacheRead: ProviderUsageLedgerDimension;
    cacheWrite: ProviderUsageLedgerDimension;
    outputCandidates: ProviderUsageLedgerDimension;
    reasoningThinking: ProviderUsageLedgerDimension;
    toolUsePrompt: ProviderUsageLedgerDimension;
    providerReportedTotal: ProviderUsageLedgerDimension;
  };
  receiptCoverage: {
    complete: number;
    partial: number;
    unavailable: number;
  };
  usageCoverage: {
    complete: number;
    partial: number;
    unavailable: number;
  };
  producerCoverage: "complete" | "partial" | "unavailable";
  producerCoverageDigests: string[];
  cost: {
    status: "unavailable";
    amountUsd: null;
    reason: "pricing_not_in_provider_receipt_ledger";
  };
};
