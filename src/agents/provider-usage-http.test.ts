import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeProviderUsageReceiptStore,
  exportProviderUsageReceipts,
} from "./provider-usage-receipts.store.js";
import { createProviderUsageHttpAttemptRunner } from "./provider-usage-http.js";

describe("createProviderUsageHttpAttemptRunner", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-provider-http-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    closeProviderUsageReceiptStore();
    vi.unstubAllEnvs();
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records physical submit attempts while leaving unavailable usage null", async () => {
    const runner = createProviderUsageHttpAttemptRunner({
      surfaceCode: "test.submit",
      provider: "test-provider",
      model: "test-model",
    });
    const release = vi.fn(async () => {});

    await runner.run(async () => ({
      response: new Response("retry", {
        status: 503,
        headers: { "x-request-id": "request-first" },
      }),
      release,
    }));
    await runner.run(async () => ({
      response: new Response("ok", {
        status: 200,
        headers: { "x-request-id": "request-second" },
      }),
      release,
    }));

    const receipts = exportProviderUsageReceipts().receipts;
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({
      attempt: 1,
      retryOf: null,
      status: "failed",
      actual: {
        provider: null,
        model: null,
        responseId: "request-first",
        evidenceSource: null,
      },
      usageCoverage: "unavailable",
      errorCategory: "http_503",
    });
    expect(receipts[0]?.usage).toEqual({
      inputTotal: null,
      inputNonCached: null,
      cacheRead: null,
      cacheWrite: null,
      outputCandidates: null,
      reasoningThinking: null,
      toolUsePrompt: null,
      providerReportedTotal: null,
      serviceTier: null,
      rawProviderUsage: null,
    });
    expect(receipts[1]).toMatchObject({
      attempt: 2,
      retryOf: receipts[0]?.callId,
      status: "succeeded",
      actual: {
        provider: null,
        model: null,
        responseId: "request-second",
        evidenceSource: null,
      },
      usageCoverage: "unavailable",
    });
  });

  it("does not count an uninstrumented status poll as a provider usage call", async () => {
    const runner = createProviderUsageHttpAttemptRunner({
      surfaceCode: "test.submit",
      provider: "test-provider",
      model: "test-model",
    });
    await runner.run(async () => ({
      response: new Response("accepted", { status: 202 }),
      release: async () => {},
    }));

    const poll = await Promise.resolve(new Response("running", { status: 200 }));
    expect(poll.status).toBe(200);
    expect(exportProviderUsageReceipts().receipts).toHaveLength(1);
  });
});
