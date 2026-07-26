import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertProviderUsageExportSchema,
  assertProviderUsageCallReceipt,
  assertProviderUsageReceiptBody,
  digestProviderUsageReceiptBody,
  PROVIDER_USAGE_CALL_FIELDS,
  PROVIDER_USAGE_DIMENSION_FIELDS,
  PROVIDER_USAGE_EXPORT_FIELDS,
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
    const first = appendProviderUsageReceipt(receiptBody(fixture));
    appendProviderUsageReceipt({
      ...receiptBody(fixture),
      callId: "244dbbc8-cc51-44c0-8ba7-25b9d30da3fa",
      completedAt: "2026-07-26T01:00:02.000Z",
    });

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
});
