import {
  PROVIDER_USAGE_LEDGER_SUMMARY_SOURCE,
  type ProviderUsageLedgerDimension,
  type ProviderUsageLedgerSummary,
} from "../shared/provider-usage-ledger-summary.js";
import type { ProviderUsageCoverageManifest } from "./provider-usage-coverage.js";
import { exportProviderUsageReceipts } from "./provider-usage-receipts.store.js";
import type {
  ProviderUsageCallReceipt,
  ProviderUsageCoverage,
  ProviderUsageDimensions,
} from "./provider-usage-receipts.types.js";

const DIMENSION_KEYS = [
  "inputTotal",
  "inputNonCached",
  "cacheRead",
  "cacheWrite",
  "outputCandidates",
  "reasoningThinking",
  "toolUsePrompt",
  "providerReportedTotal",
] as const satisfies ReadonlyArray<keyof ProviderUsageDimensions>;

type NumericDimensionKey = (typeof DIMENSION_KEYS)[number];

function coverageForKnown(known: number, total: number): ProviderUsageCoverage {
  if (total > 0 && known === total) {
    return "complete";
  }
  if (known === 0) {
    return "unavailable";
  }
  return "partial";
}

function summarizeDimension(
  receipts: ProviderUsageCallReceipt[],
  key: NumericDimensionKey,
): ProviderUsageLedgerDimension {
  let knownSubtotal = 0;
  let knownReceipts = 0;
  for (const receipt of receipts) {
    const value = receipt.usage[key];
    if (typeof value === "number") {
      knownSubtotal += value;
      knownReceipts += 1;
    }
  }
  return {
    total: knownReceipts === receipts.length && receipts.length > 0 ? knownSubtotal : null,
    knownSubtotal: knownReceipts > 0 ? knownSubtotal : null,
    knownReceipts,
    receiptCount: receipts.length,
    coverage: coverageForKnown(knownReceipts, receipts.length),
  };
}

function countCoverage(
  receipts: ProviderUsageCallReceipt[],
  key: "receiptCoverage" | "usageCoverage",
) {
  const counts = { complete: 0, partial: 0, unavailable: 0 };
  for (const receipt of receipts) {
    counts[receipt[key]] += 1;
  }
  return counts;
}

function summarizeActualModels(receipts: ProviderUsageCallReceipt[]) {
  const counts = new Map<
    string,
    { provider: string | null; model: string | null; callCount: number }
  >();
  let known = 0;
  for (const receipt of receipts) {
    const provider = receipt.actual.provider;
    const model = receipt.actual.model;
    if (provider && model) {
      known += 1;
    }
    const key = `${provider ?? "\u0000"}\u0001${model ?? "\u0000"}`;
    const row = counts.get(key) ?? { provider, model, callCount: 0 };
    row.callCount += 1;
    counts.set(key, row);
  }
  return {
    models: [...counts.values()].toSorted((left, right) => {
      const byProvider = (left.provider ?? "").localeCompare(right.provider ?? "");
      return byProvider || (left.model ?? "").localeCompare(right.model ?? "");
    }),
    coverage: coverageForKnown(known, receipts.length),
  };
}

function loadReceiptSnapshot(): {
  receipts: ProviderUsageCallReceipt[];
  manifests: Map<string, ProviderUsageCoverageManifest>;
  highWatermark: number;
} {
  const first = exportProviderUsageReceipts({ after: 0 });
  const highWatermark = first.highWatermark;
  const receipts = first.receipts.filter((receipt) => receipt.ledgerSeq <= highWatermark);
  const manifests = new Map(
    first.coverageManifests.map((manifest) => [manifest.manifestDigest, manifest]),
  );
  let cursor = first.nextCursor;
  while (cursor < highWatermark) {
    const page = exportProviderUsageReceipts({ after: cursor });
    const pageReceipts = page.receipts.filter((receipt) => receipt.ledgerSeq <= highWatermark);
    receipts.push(...pageReceipts);
    for (const manifest of page.coverageManifests) {
      manifests.set(manifest.manifestDigest, manifest);
    }
    const nextCursor = pageReceipts.at(-1)?.ledgerSeq ?? cursor;
    if (nextCursor <= cursor) {
      throw new Error(`Provider usage receipt export cursor did not advance from ${cursor}`);
    }
    cursor = nextCursor;
  }
  return { receipts, manifests, highWatermark };
}

export function loadProviderUsageLedgerSummary(params: {
  startMs: number;
  endMs: number;
}): ProviderUsageLedgerSummary {
  const snapshot = loadReceiptSnapshot();
  const receipts = snapshot.receipts.filter((receipt) => {
    const completedMs = Date.parse(receipt.completedAt);
    return completedMs >= params.startMs && completedMs <= params.endMs;
  });
  const actualModels = summarizeActualModels(receipts);
  const producerCoverageDigests = [
    ...new Set(receipts.map((receipt) => receipt.producerCoverageDigest)),
  ].toSorted();
  const producerManifests = producerCoverageDigests.map((digest) => snapshot.manifests.get(digest));
  if (producerManifests.some((manifest) => !manifest)) {
    throw new Error("Provider usage receipt summary is missing a historical coverage manifest");
  }
  const producerCoverage =
    producerManifests.length === 0
      ? "unavailable"
      : producerManifests.every((manifest) => manifest?.coverageStatus === "complete")
        ? "complete"
        : "partial";

  return {
    source: PROVIDER_USAGE_LEDGER_SUMMARY_SOURCE,
    startAt: new Date(params.startMs).toISOString(),
    endAt: new Date(params.endMs).toISOString(),
    highWatermark: snapshot.highWatermark,
    receiptCount: receipts.length,
    lastReceiptAt: receipts.at(-1)?.completedAt ?? null,
    statusCounts: {
      succeeded: receipts.filter((receipt) => receipt.status === "succeeded").length,
      failed: receipts.filter((receipt) => receipt.status === "failed").length,
      interrupted: receipts.filter((receipt) => receipt.status === "interrupted").length,
      cancelled: receipts.filter((receipt) => receipt.status === "cancelled").length,
    },
    actualModels: actualModels.models,
    actualModelCoverage: actualModels.coverage,
    usage: Object.fromEntries(
      DIMENSION_KEYS.map((key) => [key, summarizeDimension(receipts, key)]),
    ) as ProviderUsageLedgerSummary["usage"],
    receiptCoverage: countCoverage(receipts, "receiptCoverage"),
    usageCoverage: countCoverage(receipts, "usageCoverage"),
    producerCoverage,
    producerCoverageDigests,
    cost: {
      status: "unavailable",
      amountUsd: null,
      reason: "pricing_not_in_provider_receipt_ledger",
    },
  };
}
