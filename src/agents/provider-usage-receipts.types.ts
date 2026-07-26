import type { ProviderUsageCoverageManifest } from "./provider-usage-coverage.js";

export const PROVIDER_USAGE_CALL_SCHEMA = "jitech-provider-usage-call/v1" as const;
export const PROVIDER_USAGE_EXPORT_SCHEMA = "jitech-provider-usage-export/v1" as const;

export type ProviderUsageCallStatus = "succeeded" | "failed" | "interrupted" | "cancelled";
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

export type ProviderUsageRawValue =
  | number
  | string
  | null
  | ProviderUsageRawValue[]
  | { [key: string]: ProviderUsageRawValue };

export type ProviderUsageDimensions = {
  inputTotal: number | null;
  inputNonCached: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  outputCandidates: number | null;
  reasoningThinking: number | null;
  toolUsePrompt: number | null;
  providerReportedTotal: number | null;
  serviceTier: string | null;
  rawProviderUsage: Record<string, ProviderUsageRawValue> | null;
};

export type ProviderUsageCallReceiptBody = {
  schema: typeof PROVIDER_USAGE_CALL_SCHEMA;
  producerCoverageDigest: string;
  callId: string;
  runId: string | null;
  turnId: string | null;
  requestId: string | null;
  sessionId: string | null;
  trigger: ProviderUsageCallTrigger;
  attempt: number;
  retryOf: string | null;
  fallbackParent: string | null;
  fallbackIndex: number;
  startedAt: string;
  completedAt: string;
  status: ProviderUsageCallStatus;
  configured: ProviderUsageModelRef;
  requested: ProviderUsageModelRef;
  actual: ProviderUsageActualModel;
  usage: ProviderUsageDimensions;
  usageCoverage: ProviderUsageCoverage;
  missingUsageFields: string[];
  receiptCoverage: ProviderUsageCoverage;
  missingReceiptFields: string[];
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
  nextCursor: number;
  highWatermark: number;
  count: number;
  hasMore: boolean;
  receipts: ProviderUsageCallReceipt[];
  coverageManifests: ProviderUsageCoverageManifest[];
};
