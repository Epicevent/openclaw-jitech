export const PROVIDER_USAGE_CALL_SCHEMA = "jitech-provider-usage-call/v1" as const;
export const PROVIDER_USAGE_EXPORT_SCHEMA = "jitech-provider-usage-export/v1" as const;

export type ProviderUsageCallStatus = "succeeded" | "failed" | "cancelled";
export type ProviderUsageCoverage = "complete" | "partial" | "unavailable";
export type ProviderUsageCallTrigger =
  | "cron"
  | "heartbeat"
  | "manual"
  | "memory"
  | "overflow"
  | "user"
  | "unknown";

export type ProviderUsageModelRef = {
  provider: string;
  model: string;
};

export type ProviderUsageActualModel = {
  provider: string | null;
  model: string | null;
  responseId: string | null;
  evidenceSource: string | null;
};

export type ProviderUsageDimensions = {
  inputTotal: number | null;
  inputNonCached: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  outputCandidates: number | null;
  reasoningThinking: number | null;
  toolUsePrompt: number | null;
  providerReportedTotal: number | null;
  rawProviderUsage: Record<string, number | string | null> | null;
};

export type ProviderUsageCallReceiptBody = {
  schema: typeof PROVIDER_USAGE_CALL_SCHEMA;
  callId: string;
  runId: string | null;
  turnId: string | null;
  requestId: string | null;
  sessionId: string | null;
  trigger: ProviderUsageCallTrigger;
  attempt: number;
  retryOf: string | null;
  fallbackParent: string | null;
  startedAt: string;
  completedAt: string;
  status: ProviderUsageCallStatus;
  configured: ProviderUsageModelRef;
  requested: ProviderUsageModelRef;
  actual: ProviderUsageActualModel;
  usage: ProviderUsageDimensions;
  usageCoverage: ProviderUsageCoverage;
  missingUsageFields: string[];
  finishReason: string | null;
  errorCategory: string | null;
};

export type ProviderUsageCallReceipt = ProviderUsageCallReceiptBody & {
  ledgerSeq: number;
  receiptDigest: string;
};

export type ProviderUsageReceiptExport = {
  schema: typeof PROVIDER_USAGE_EXPORT_SCHEMA;
  after: number;
  nextAfter: number;
  hasMore: boolean;
  receipts: ProviderUsageCallReceipt[];
};
