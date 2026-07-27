import { createHash } from "node:crypto";
import {
  PROVIDER_USAGE_CALL_SCHEMA,
  type ProviderUsageCallReceipt,
  type ProviderUsageCallReceiptBody,
  type ProviderUsageCallStatus,
  type ProviderUsageCoverage,
  type ProviderUsageDimensions,
} from "./provider-usage-receipts.types.js";
import { stableStringify } from "./stable-stringify.js";

export const PROVIDER_USAGE_CALL_FIELDS = [
  "schema",
  "ledgerSeq",
  "receiptDigest",
  "producerCoverageDigest",
  "callId",
  "runId",
  "turnId",
  "requestId",
  "sessionId",
  "trigger",
  "attempt",
  "retryOf",
  "fallbackParent",
  "fallbackIndex",
  "startedAt",
  "completedAt",
  "status",
  "configured",
  "requested",
  "actual",
  "usage",
  "usageCoverage",
  "missingUsageFields",
  "receiptCoverage",
  "missingReceiptFields",
  "finishReason",
  "errorCategory",
] as const;

export const PROVIDER_USAGE_DIMENSION_FIELDS = [
  "inputTotal",
  "inputNonCached",
  "cacheRead",
  "cacheWrite",
  "outputCandidates",
  "reasoningThinking",
  "toolUsePrompt",
  "providerReportedTotal",
  "serviceTier",
  "rawProviderUsage",
] as const;

const PROVIDER_USAGE_CALL_BODY_FIELDS = PROVIDER_USAGE_CALL_FIELDS.filter(
  (field) => field !== "ledgerSeq" && field !== "receiptDigest",
);
const MODEL_REF_FIELDS = ["provider", "model"] as const;
const ACTUAL_MODEL_FIELDS = ["provider", "model", "responseId", "evidenceSource"] as const;
const CALL_STATUSES = new Set(["succeeded", "failed", "interrupted", "cancelled"]);
const CALL_TRIGGERS = new Set([
  "user",
  "cron",
  "heartbeat",
  "manual",
  "memory",
  "overflow",
  "unknown",
]);
const COVERAGE_VALUES = new Set(["complete", "partial", "unavailable"]);
const RECEIPT_IDENTITY_FIELDS = ["runId", "turnId", "requestId", "sessionId"] as const;
const SUCCEEDED_RECEIPT_FIELDS = [
  "actual.provider",
  "actual.model",
  "actual.responseId",
  "actual.evidenceSource",
  "finishReason",
] as const;
const UUID_LIKE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

const MAX_RAW_PROVIDER_USAGE_BYTES = 64 * 1024;
const RAW_PROVIDER_USAGE_COUNT_KEYS = new Set([
  "promptTokenCount",
  "cachedContentTokenCount",
  "candidatesTokenCount",
  "thoughtsTokenCount",
  "toolUsePromptTokenCount",
  "totalTokenCount",
]);
const RAW_PROVIDER_USAGE_ENUM_KEYS = new Set(["serviceTier", "trafficType"]);
const RAW_PROVIDER_USAGE_DETAIL_KEYS = new Set([
  "promptTokensDetails",
  "cacheTokensDetails",
  "candidatesTokensDetails",
  "toolUsePromptTokensDetails",
]);
const RAW_PROVIDER_USAGE_KEYS = new Set([
  ...RAW_PROVIDER_USAGE_COUNT_KEYS,
  ...RAW_PROVIDER_USAGE_ENUM_KEYS,
  ...RAW_PROVIDER_USAGE_DETAIL_KEYS,
]);

export class ProviderUsageWireContractError extends Error {
  constructor(message: string) {
    super(`Provider usage wire contract violation: ${message}`);
    this.name = "ProviderUsageWireContractError";
  }
}

function fail(message: string): never {
  throw new ProviderUsageWireContractError(message);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  fields: readonly string[],
  path: string,
): void {
  const actual = Object.keys(record).toSorted();
  const expected = [...fields].toSorted();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    fail(`${path} fields must be exactly ${expected.join(",")}`);
  }
}

function assertNonEmptyString(
  value: unknown,
  path: string,
  maxLength = 512,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${path} must be a nonempty string`);
  }
  if (value.length > maxLength) {
    fail(`${path} must not exceed ${maxLength} characters`);
  }
}

function assertNullableString(value: unknown, path: string, maxLength = 512): void {
  if (value !== null) {
    assertNonEmptyString(value, path, maxLength);
  }
}

function assertNonNegativeSafeInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`${path} must be a nonnegative safe integer`);
  }
}

function assertNullableCount(value: unknown, path: string): void {
  if (value !== null) {
    assertNonNegativeSafeInteger(value, path);
  }
}

function assertStringArray(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    fail(`${path} must be an array`);
  }
  const seen = new Set<string>();
  for (const item of value) {
    assertNonEmptyString(item, `${path}[]`);
    if (seen.has(item)) {
      fail(`${path} must not contain duplicates`);
    }
    seen.add(item);
  }
}

function assertTimestamp(value: unknown, path: string): asserts value is string {
  assertNonEmptyString(value, path);
  if (!RFC3339_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(`${path} must be RFC3339 with a timezone`);
  }
}

function assertModelRef(value: unknown, path: string): void {
  const record = asRecord(value, path);
  assertExactKeys(record, MODEL_REF_FIELDS, path);
  assertNonEmptyString(record.provider, `${path}.provider`, 64);
  assertNonEmptyString(record.model, `${path}.model`, 191);
}

function assertActualModel(value: unknown): void {
  const record = asRecord(value, "actual");
  assertExactKeys(record, ACTUAL_MODEL_FIELDS, "actual");
  assertNullableString(record.provider, "actual.provider", 191);
  assertNullableString(record.model, "actual.model", 191);
  assertNullableString(record.responseId, "actual.responseId", 191);
  assertNullableString(record.evidenceSource, "actual.evidenceSource", 191);
}

function assertRawProviderUsage(value: unknown): void {
  const path = "usage.rawProviderUsage";
  const record = asRecord(value, path);
  if (Buffer.byteLength(stableStringify(record), "utf8") > MAX_RAW_PROVIDER_USAGE_BYTES) {
    fail(`${path} must not exceed ${MAX_RAW_PROVIDER_USAGE_BYTES} bytes`);
  }
  for (const key of Object.keys(record)) {
    if (!RAW_PROVIDER_USAGE_KEYS.has(key)) {
      fail(`${path}.${key} is not in the accounting allowlist`);
    }
  }
  for (const key of RAW_PROVIDER_USAGE_COUNT_KEYS) {
    if (key in record) {
      assertNullableCount(record[key], `${path}.${key}`);
    }
  }
  for (const key of RAW_PROVIDER_USAGE_ENUM_KEYS) {
    if (key in record) {
      assertNullableString(record[key], `${path}.${key}`, 64);
    }
  }
  for (const key of RAW_PROVIDER_USAGE_DETAIL_KEYS) {
    const details = record[key];
    if (details === undefined || details === null) {
      continue;
    }
    if (!Array.isArray(details)) {
      fail(`${path}.${key} must be an array`);
    }
    for (const [index, detailValue] of details.entries()) {
      const detailPath = `${path}.${key}[${index}]`;
      const detail = asRecord(detailValue, detailPath);
      assertExactKeys(detail, ["modality", "tokenCount"], detailPath);
      assertNonEmptyString(detail.modality, `${detailPath}.modality`, 64);
      assertNonNegativeSafeInteger(detail.tokenCount, `${detailPath}.tokenCount`);
    }
  }
}

function assertUsage(value: unknown): void {
  const record = asRecord(value, "usage");
  assertExactKeys(record, PROVIDER_USAGE_DIMENSION_FIELDS, "usage");
  for (const field of PROVIDER_USAGE_DIMENSION_FIELDS) {
    if (field === "serviceTier") {
      assertNullableString(record[field], `usage.${field}`, 64);
      continue;
    }
    if (field === "rawProviderUsage") {
      if (record[field] !== null) {
        assertRawProviderUsage(record[field]);
      }
      continue;
    }
    assertNullableCount(record[field], `usage.${field}`);
  }
}

function assertCoverage(value: unknown, path: string): void {
  if (typeof value !== "string" || !COVERAGE_VALUES.has(value)) {
    fail(`${path} must be complete, partial, or unavailable`);
  }
}

function coverageFromMissing(missing: string[], expectedCount: number): ProviderUsageCoverage {
  if (missing.length === 0) {
    return "complete";
  }
  return missing.length === expectedCount ? "unavailable" : "partial";
}

export function deriveProviderUsageCoverage(usage: ProviderUsageDimensions): {
  coverage: ProviderUsageCoverage;
  missing: string[];
} {
  const missing = PROVIDER_USAGE_DIMENSION_FIELDS.filter((field) => usage[field] === null);
  return {
    coverage: coverageFromMissing(missing, PROVIDER_USAGE_DIMENSION_FIELDS.length),
    missing,
  };
}

export function deriveProviderUsageReceiptCoverage(params: {
  runId: string | null;
  turnId: string | null;
  requestId: string | null;
  sessionId: string | null;
  trigger: ProviderUsageCallReceiptBody["trigger"];
  status: ProviderUsageCallStatus;
  actual: ProviderUsageCallReceiptBody["actual"];
  usage: ProviderUsageDimensions;
  finishReason: string | null;
  errorCategory: string | null;
}): { coverage: ProviderUsageCoverage; missing: string[] } {
  const missing: string[] = RECEIPT_IDENTITY_FIELDS.filter((field) => params[field] === null);
  if (params.trigger === "unknown") {
    missing.push("trigger");
  }
  let evidenceFieldCount: number;
  if (params.status === "succeeded") {
    evidenceFieldCount = SUCCEEDED_RECEIPT_FIELDS.length;
    const succeededValues = {
      "actual.provider": params.actual.provider,
      "actual.model": params.actual.model,
      "actual.responseId": params.actual.responseId,
      "actual.evidenceSource": params.actual.evidenceSource,
      finishReason: params.finishReason,
    };
    for (const field of SUCCEEDED_RECEIPT_FIELDS) {
      if (succeededValues[field] === null) {
        missing.push(field);
      }
    }
  } else {
    evidenceFieldCount = 1;
    if (params.errorCategory === null) {
      missing.push("errorCategory");
    }
  }
  const missingUsage = deriveProviderUsageCoverage(params.usage).missing;
  missing.push(...missingUsage.map((field) => `usage.${field}`));
  return {
    coverage: coverageFromMissing(
      missing,
      RECEIPT_IDENTITY_FIELDS.length +
        1 +
        evidenceFieldCount +
        PROVIDER_USAGE_DIMENSION_FIELDS.length,
    ),
    missing,
  };
}

function assertCoverageMatches(params: {
  actualCoverage: unknown;
  actualMissing: unknown;
  expectedCoverage: ProviderUsageCoverage;
  expectedMissing: string[];
  prefix: string;
}): void {
  if (params.actualCoverage !== params.expectedCoverage) {
    fail(`${params.prefix}Coverage disagrees with available evidence`);
  }
  if (
    !Array.isArray(params.actualMissing) ||
    params.actualMissing.length !== params.expectedMissing.length ||
    params.actualMissing.some((field, index) => field !== params.expectedMissing[index])
  ) {
    fail(
      `missing${params.prefix[0]?.toUpperCase()}${params.prefix.slice(1)}Fields is inconsistent`,
    );
  }
}

export function assertProviderUsageReceiptBody(
  value: unknown,
): asserts value is ProviderUsageCallReceiptBody {
  const record = asRecord(value, "receipt body");
  assertExactKeys(record, PROVIDER_USAGE_CALL_BODY_FIELDS, "receipt body");
  if (record.schema !== PROVIDER_USAGE_CALL_SCHEMA) {
    fail(`schema must be ${PROVIDER_USAGE_CALL_SCHEMA}`);
  }
  if (
    typeof record.producerCoverageDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.producerCoverageDigest)
  ) {
    fail("producerCoverageDigest must be a lowercase SHA-256 digest");
  }
  assertNonEmptyString(record.callId, "callId", 128);
  if (!UUID_LIKE_RE.test(record.callId)) {
    fail("callId must be UUID-like");
  }
  for (const field of ["runId", "turnId", "requestId", "sessionId"] as const) {
    assertNullableString(record[field], field, 128);
  }
  if (typeof record.trigger !== "string" || !CALL_TRIGGERS.has(record.trigger)) {
    fail("trigger has an unsupported value");
  }
  assertNonNegativeSafeInteger(record.attempt, "attempt");
  if (record.attempt === 0) {
    fail("attempt must be at least 1");
  }
  assertNullableString(record.retryOf, "retryOf", 128);
  assertNullableString(record.fallbackParent, "fallbackParent", 128);
  assertNonNegativeSafeInteger(record.fallbackIndex, "fallbackIndex");
  if (record.fallbackParent === null && record.fallbackIndex !== 0) {
    fail("fallbackIndex must be 0 when fallbackParent is null");
  }
  if (record.fallbackParent !== null && record.fallbackIndex === 0) {
    fail("fallbackIndex must be positive when fallbackParent is set");
  }
  assertTimestamp(record.startedAt, "startedAt");
  assertTimestamp(record.completedAt, "completedAt");
  if (Date.parse(record.completedAt) < Date.parse(record.startedAt)) {
    fail("completedAt must not precede startedAt");
  }
  if (typeof record.status !== "string" || !CALL_STATUSES.has(record.status)) {
    fail("status has an unsupported value");
  }
  assertModelRef(record.configured, "configured");
  assertModelRef(record.requested, "requested");
  assertActualModel(record.actual);
  assertUsage(record.usage);
  assertCoverage(record.usageCoverage, "usageCoverage");
  assertStringArray(record.missingUsageFields, "missingUsageFields");
  assertCoverage(record.receiptCoverage, "receiptCoverage");
  assertStringArray(record.missingReceiptFields, "missingReceiptFields");
  assertNullableString(record.finishReason, "finishReason", 128);
  assertNullableString(record.errorCategory, "errorCategory", 128);
  const body = record as unknown as ProviderUsageCallReceiptBody;
  const usageCoverage = deriveProviderUsageCoverage(body.usage);
  assertCoverageMatches({
    actualCoverage: body.usageCoverage,
    actualMissing: body.missingUsageFields,
    expectedCoverage: usageCoverage.coverage,
    expectedMissing: usageCoverage.missing,
    prefix: "usage",
  });
  const receiptCoverage = deriveProviderUsageReceiptCoverage(body);
  assertCoverageMatches({
    actualCoverage: body.receiptCoverage,
    actualMissing: body.missingReceiptFields,
    expectedCoverage: receiptCoverage.coverage,
    expectedMissing: receiptCoverage.missing,
    prefix: "receipt",
  });
}

export function canonicalizeProviderUsageReceiptBody(body: ProviderUsageCallReceiptBody): string {
  assertProviderUsageReceiptBody(body);
  return stableStringify(body);
}

export function digestProviderUsageReceiptBody(body: ProviderUsageCallReceiptBody): string {
  const canonical = canonicalizeProviderUsageReceiptBody(body);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function assertProviderUsageCallReceipt(
  value: unknown,
): asserts value is ProviderUsageCallReceipt {
  const record = asRecord(value, "receipt");
  assertExactKeys(record, PROVIDER_USAGE_CALL_FIELDS, "receipt");
  assertNonNegativeSafeInteger(record.ledgerSeq, "ledgerSeq");
  if (record.ledgerSeq === 0) {
    fail("ledgerSeq must be at least 1");
  }
  if (
    typeof record.receiptDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.receiptDigest)
  ) {
    fail("receiptDigest must be a lowercase SHA-256 digest");
  }
  const { ledgerSeq: _ledgerSeq, receiptDigest, ...body } = record;
  assertProviderUsageReceiptBody(body);
  if (digestProviderUsageReceiptBody(body) !== receiptDigest) {
    fail("receiptDigest does not match canonical receipt bytes");
  }
}
