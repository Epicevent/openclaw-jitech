import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readProviderUsageCoverageManifest } from "./provider-usage-coverage.js";
import {
  assertProviderUsageExportSchema,
  PROVIDER_USAGE_EXPORT_FIELDS,
} from "./provider-usage-receipts-export.contract.js";
import {
  assertProviderUsageCallReceipt,
  assertProviderUsageReceiptBody,
  digestProviderUsageReceiptBody,
  PROVIDER_USAGE_CALL_FIELDS,
  PROVIDER_USAGE_DIMENSION_FIELDS,
} from "./provider-usage-receipts.contract.js";
import {
  appendProviderUsageReceipt,
  closeProviderUsageReceiptStore,
  exportProviderUsageReceipts,
} from "./provider-usage-receipts.store.js";
import type {
  ProviderUsageCallReceipt,
  ProviderUsageCallReceiptBody,
} from "./provider-usage-receipts.types.js";

const fixtureUrl = new URL("./provider-usage-receipts.fixture.json", import.meta.url);

function loadFixture(): ProviderUsageCallReceipt {
  return JSON.parse(readFileSync(fixtureUrl, "utf8")) as ProviderUsageCallReceipt;
}

function receiptBody(receipt: ProviderUsageCallReceipt): ProviderUsageCallReceiptBody {
  const { ledgerSeq: _ledgerSeq, receiptDigest: _receiptDigest, ...body } = receipt;
  return body;
}

describe("provider usage v1 wire contract", () => {
  let stateDir: string;

  beforeEach(async () => {
    closeProviderUsageReceiptStore();
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-provider-wire-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    closeProviderUsageReceiptStore();
    vi.unstubAllEnvs();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("keeps the shared call fixture exact and canonically digestible", () => {
    const fixture = loadFixture();
    const body = receiptBody(fixture);

    expect(Object.keys(fixture)).toEqual(PROVIDER_USAGE_CALL_FIELDS);
    expect(Object.keys(fixture.configured)).toEqual(["provider", "model"]);
    expect(Object.keys(fixture.requested)).toEqual(["provider", "model"]);
    expect(Object.keys(fixture.actual)).toEqual([
      "provider",
      "model",
      "responseId",
      "evidenceSource",
    ]);
    expect(Object.keys(fixture.usage)).toEqual(PROVIDER_USAGE_DIMENSION_FIELDS);
    expect(() => assertProviderUsageCallReceipt(fixture)).not.toThrow();
    expect(() => assertProviderUsageReceiptBody(body)).not.toThrow();
    expect(digestProviderUsageReceiptBody(body)).toBe(fixture.receiptDigest);
    expect(
      digestProviderUsageReceiptBody(
        receiptBody({ ...fixture, ledgerSeq: fixture.ledgerSeq + 100 }),
      ),
    ).toBe(fixture.receiptDigest);
  });

  it("exports the exact shared envelope with a fixed read boundary", () => {
    const fixture = loadFixture();
    const manifest = readProviderUsageCoverageManifest();
    const first = appendProviderUsageReceipt(receiptBody(fixture), manifest);
    appendProviderUsageReceipt(
      {
        ...receiptBody(fixture),
        callId: "244dbbc8-cc51-44c0-8ba7-25b9d30da3fa",
        completedAt: "2026-07-26T01:00:02.000Z",
      },
      manifest,
    );

    const exported = exportProviderUsageReceipts({ after: 0, limit: 1 });

    expect(Object.keys(exported)).toEqual(PROVIDER_USAGE_EXPORT_FIELDS);
    expect(() => assertProviderUsageExportSchema(exported)).not.toThrow();
    expect(exported).toMatchObject({
      after: 0,
      nextCursor: first.ledgerSeq,
      highWatermark: 2,
      count: 1,
      hasMore: true,
    });
    expect(exported.receipts.every((receipt) => receipt.ledgerSeq > exported.after)).toBe(true);
    expect(Object.keys(exported.receipts[0] ?? {})).toEqual(PROVIDER_USAGE_CALL_FIELDS);
    expect(exported.coverageManifests).toEqual([manifest]);
  });

  it("requires the exact historical manifest set referenced by a page", () => {
    const manifest = readProviderUsageCoverageManifest();
    const fixture = loadFixture();
    appendProviderUsageReceipt(receiptBody(fixture), manifest);
    const exported = exportProviderUsageReceipts({ after: 0, limit: 1 });

    expect(() => assertProviderUsageExportSchema({ ...exported, coverageManifests: [] })).toThrow(
      /must exactly match/u,
    );
    expect(() =>
      assertProviderUsageExportSchema({
        ...exported,
        coverageManifests: [manifest, manifest],
      }),
    ).toThrow(/unique and ordered/u);
    expect(() =>
      assertProviderUsageExportSchema({
        ...exported,
        receipts: [],
        count: 0,
        nextCursor: 0,
      }),
    ).toThrow(/must exactly match/u);
  });

  it("rejects non-accounting raw provider fields", () => {
    const body = receiptBody(loadFixture());
    const invalid = {
      ...body,
      usage: {
        ...body.usage,
        rawProviderUsage: {
          message: "must not cross the wire",
        },
      },
    };

    expect(() => assertProviderUsageReceiptBody(invalid)).toThrow(
      /not in the accounting allowlist/u,
    );

    const withModalityDetails = {
      ...body,
      usage: {
        ...body.usage,
        rawProviderUsage: {
          ...body.usage.rawProviderUsage,
          promptTokensDetails: [{ modality: "TEXT", tokenCount: 100 }],
        },
      },
    };
    expect(() => assertProviderUsageReceiptBody(withModalityDetails)).not.toThrow();

    const invalidModalityDetails = {
      ...withModalityDetails,
      usage: {
        ...withModalityDetails.usage,
        rawProviderUsage: {
          ...withModalityDetails.usage.rawProviderUsage,
          promptTokensDetails: [{ modality: "TEXT", tokenCount: 100, text: "secret" }],
        },
      },
    };
    expect(() => assertProviderUsageReceiptBody(invalidModalityDetails)).toThrow(
      /fields must be exactly/u,
    );
  });

  it("fails closed on missing usage paths, bogus paths, and field-order drift", () => {
    const body = receiptBody(loadFixture());
    const withMissingInput = {
      ...body,
      usage: { ...body.usage, inputNonCached: null },
      missingUsageFields: ["inputNonCached", "cacheWrite"],
    };

    expect(() =>
      assertProviderUsageReceiptBody({
        ...withMissingInput,
        missingReceiptFields: ["usage.cacheWrite"],
      }),
    ).toThrow(/missingReceiptFields is inconsistent/u);
    expect(() =>
      assertProviderUsageReceiptBody({
        ...withMissingInput,
        missingUsageFields: ["cacheWrite", "inputNonCached"],
        missingReceiptFields: ["usage.inputNonCached", "usage.cacheWrite"],
      }),
    ).toThrow(/missingUsageFields is inconsistent/u);
    expect(() =>
      assertProviderUsageReceiptBody({
        ...body,
        missingReceiptFields: ["usage.bogus"],
      }),
    ).toThrow(/missingReceiptFields is inconsistent/u);
  });

  it("counts an unknown trigger as missing receipt evidence", () => {
    const body = receiptBody(loadFixture());
    const unknownTrigger = { ...body, trigger: "unknown" as const };

    expect(() => assertProviderUsageReceiptBody(unknownTrigger)).toThrow(
      /missingReceiptFields is inconsistent/u,
    );
    expect(() =>
      assertProviderUsageReceiptBody({
        ...unknownTrigger,
        missingReceiptFields: ["trigger", "usage.cacheWrite"],
      }),
    ).not.toThrow();
  });

  it.each([
    ["configured", "provider"],
    ["configured", "model"],
    ["requested", "provider"],
    ["requested", "model"],
  ] as const)("keeps %s.%s non-empty instead of treating it as missing", (ref, field) => {
    const body = receiptBody(loadFixture());

    expect(() =>
      assertProviderUsageReceiptBody({
        ...body,
        [ref]: { ...body[ref], [field]: "" },
      }),
    ).toThrow(/must be a nonempty string/u);
  });

  it.each(["interrupted", "cancelled"] as const)(
    "requires errorCategory evidence for %s calls",
    (status) => {
      const body = receiptBody(loadFixture());
      const terminal = { ...body, status, errorCategory: null };

      expect(() => assertProviderUsageReceiptBody(terminal)).toThrow(
        /missingReceiptFields is inconsistent/u,
      );
      expect(() =>
        assertProviderUsageReceiptBody({
          ...terminal,
          missingReceiptFields: ["errorCategory", "usage.cacheWrite"],
        }),
      ).not.toThrow();
    },
  );

  it("marks receipt coverage unavailable only when every applicable field is missing", () => {
    const body = receiptBody(loadFixture());
    const usage = Object.fromEntries(PROVIDER_USAGE_DIMENSION_FIELDS.map((field) => [field, null]));
    const usageFields = [...PROVIDER_USAGE_DIMENSION_FIELDS];
    const usagePaths = usageFields.map((field) => `usage.${field}`);
    const allCommonMissing = ["runId", "turnId", "requestId", "sessionId", "trigger"];
    const unavailable = {
      ...body,
      runId: null,
      turnId: null,
      requestId: null,
      sessionId: null,
      trigger: "unknown" as const,
      usage,
      usageCoverage: "unavailable" as const,
      missingUsageFields: usageFields,
      receiptCoverage: "unavailable" as const,
      finishReason: null,
      errorCategory: null,
    };

    expect(() =>
      assertProviderUsageReceiptBody({
        ...unavailable,
        actual: { provider: null, model: null, responseId: null, evidenceSource: null },
        status: "succeeded",
        missingReceiptFields: [
          ...allCommonMissing,
          "actual.provider",
          "actual.model",
          "actual.responseId",
          "actual.evidenceSource",
          "finishReason",
          ...usagePaths,
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertProviderUsageReceiptBody({
        ...unavailable,
        status: "interrupted",
        missingReceiptFields: [...allCommonMissing, "errorCategory", ...usagePaths],
      }),
    ).not.toThrow();
  });
});
