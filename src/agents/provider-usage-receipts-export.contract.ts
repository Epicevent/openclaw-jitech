import {
  assertProviderUsageCoverageManifest,
  type ProviderUsageCoverageManifest,
} from "./provider-usage-coverage.js";
import {
  assertProviderUsageCallReceipt,
  ProviderUsageWireContractError,
} from "./provider-usage-receipts.contract.js";
import {
  PROVIDER_USAGE_EXPORT_SCHEMA,
  type ProviderUsageCallReceipt,
} from "./provider-usage-receipts.types.js";

export const PROVIDER_USAGE_EXPORT_FIELDS = [
  "schema",
  "after",
  "nextCursor",
  "highWatermark",
  "count",
  "hasMore",
  "receipts",
  "coverageManifests",
] as const;

function fail(message: string): never {
  throw new ProviderUsageWireContractError(message);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("export must be an object");
  }
  return value as Record<string, unknown>;
}

function assertNonNegativeSafeInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`${path} must be a nonnegative safe integer`);
  }
}

function assertExactFields(record: Record<string, unknown>): void {
  const actual = Object.keys(record).toSorted();
  const expected = [...PROVIDER_USAGE_EXPORT_FIELDS].toSorted();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    fail(`export fields must be exactly ${expected.join(",")}`);
  }
}

function assertCoverageManifests(value: unknown, receipts: ProviderUsageCallReceipt[]): void {
  if (!Array.isArray(value)) {
    fail("coverageManifests must be an array");
  }
  for (const manifest of value) {
    try {
      assertProviderUsageCoverageManifest(manifest);
    } catch (error) {
      fail(
        `coverageManifests contains an invalid manifest: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const manifests = value as ProviderUsageCoverageManifest[];
  const manifestDigests = manifests.map((manifest) => manifest.manifestDigest);
  const sortedUniqueManifestDigests = [...new Set(manifestDigests)].toSorted();
  if (
    manifestDigests.length !== sortedUniqueManifestDigests.length ||
    manifestDigests.some((digest, index) => digest !== sortedUniqueManifestDigests[index])
  ) {
    fail("coverageManifests must be unique and ordered by manifestDigest ascending");
  }
  const referencedDigests = [
    ...new Set(receipts.map((receipt) => receipt.producerCoverageDigest)),
  ].toSorted();
  if (
    manifestDigests.length !== referencedDigests.length ||
    manifestDigests.some((digest, index) => digest !== referencedDigests[index])
  ) {
    fail("coverageManifests must exactly match receipt producerCoverageDigest values");
  }
}

export function assertProviderUsageExportSchema(value: unknown): void {
  const record = asRecord(value);
  assertExactFields(record);
  if (record.schema !== PROVIDER_USAGE_EXPORT_SCHEMA) {
    fail(`export schema must be ${PROVIDER_USAGE_EXPORT_SCHEMA}`);
  }
  assertNonNegativeSafeInteger(record.after, "after");
  assertNonNegativeSafeInteger(record.nextCursor, "nextCursor");
  assertNonNegativeSafeInteger(record.highWatermark, "highWatermark");
  assertNonNegativeSafeInteger(record.count, "count");
  if (typeof record.hasMore !== "boolean") {
    fail("hasMore must be a boolean");
  }
  if (record.highWatermark < record.after) {
    fail("highWatermark must not be less than after");
  }
  if (!Array.isArray(record.receipts)) {
    fail("receipts must be an array");
  }
  for (const receipt of record.receipts) {
    assertProviderUsageCallReceipt(receipt);
  }
  const receipts = record.receipts as ProviderUsageCallReceipt[];
  if (record.count !== receipts.length) {
    fail("count must equal receipts.length");
  }
  assertCoverageManifests(record.coverageManifests, receipts);

  const ledgerSequences = receipts.map((receipt) => receipt.ledgerSeq);
  for (let index = 0; index < ledgerSequences.length; index += 1) {
    const current = ledgerSequences[index];
    const previous = ledgerSequences[index - 1];
    if (current === undefined || current <= record.after) {
      fail("every receipt ledgerSeq must be greater than after");
    }
    if (previous !== undefined && current <= previous) {
      fail("receipts must be ordered by ledgerSeq ascending");
    }
    if (current > record.highWatermark) {
      fail("receipt ledgerSeq exceeds highWatermark");
    }
  }
  const expectedNextCursor = ledgerSequences.at(-1) ?? record.after;
  if (record.nextCursor !== expectedNextCursor) {
    fail("nextCursor must equal the last receipt ledgerSeq or after");
  }
  if (record.hasMore !== record.highWatermark > record.nextCursor) {
    fail("hasMore disagrees with the observed highWatermark boundary");
  }
  if (record.hasMore && ledgerSequences.length === 0) {
    fail("export must make cursor progress while hasMore is true");
  }
}
