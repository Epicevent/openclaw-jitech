import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildKwragP0TestHandoff } from "../agents/kwrag-p0-handoff.fixture.js";
import { verifyOptionalKwragP0Handoff } from "../agents/kwrag-p0-handoff.js";
import { resolveKwragP0HandoffReceiptDbPath } from "../agents/kwrag-p0-handoff.paths.js";
import {
  appendKwragP0HandoffReceipt,
  closeKwragP0HandoffReceiptStore,
} from "../agents/kwrag-p0-handoff.store.js";
import { registerKwragP0Cli } from "./kwrag-p0-cli.js";

const PRODUCT_SOURCE_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  return { writes, restore: () => spy.mockRestore() };
}

describe("kwrag-p0 status CLI", () => {
  let stateDir: string;

  beforeEach(async () => {
    closeKwragP0HandoffReceiptStore();
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-kwrag-p0-cli-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    closeKwragP0HandoffReceiptStore();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("reports exact default-off runtime truth without initializing the ledger", async () => {
    const output = captureStdout();
    const program = new Command();
    program.exitOverride();
    registerKwragP0Cli(program);

    await program.parseAsync(["node", "openclaw", "kwrag-p0", "status", "--json"]);

    const payload = JSON.parse(output.writes.join("")) as Record<string, unknown>;
    expect(Object.keys(payload).toSorted()).toEqual(
      [
        "schema",
        "invocationMode",
        "defaultEnabled",
        "currentProductSourceCommit",
        "ledgerAvailable",
        "highWatermark",
        "latest",
        "p1Identity",
      ].toSorted(),
    );
    expect(payload).toMatchObject({
      schema: "jitech-openclaw-kwrag-p0-status/v1",
      invocationMode: "caller_explicit",
      defaultEnabled: false,
      ledgerAvailable: false,
      highWatermark: null,
      latest: null,
    });
    expect(payload.currentProductSourceCommit).toMatch(/^[0-9a-f]{40}$/u);
    expect(existsSync(resolveKwragP0HandoffReceiptDbPath(process.env))).toBe(false);
    output.restore();
  });

  it("returns the latest receipt with its generation-time product source binding", async () => {
    const receipt = verifyOptionalKwragP0Handoff({
      input: buildKwragP0TestHandoff(),
      runId: "run-p0-1",
      sessionId: "session-p0-1",
      productSourceCommit: PRODUCT_SOURCE_COMMIT,
    });
    if (!receipt) {
      throw new Error("expected fixture receipt");
    }
    appendKwragP0HandoffReceipt(receipt);

    const output = captureStdout();
    const program = new Command();
    program.exitOverride();
    registerKwragP0Cli(program);
    await program.parseAsync(["node", "openclaw", "kwrag-p0", "status", "--json"]);

    const payload = JSON.parse(output.writes.join("")) as {
      highWatermark: number;
      latest: { ledgerSeq: number; receipt: { productSourceCommit: string } };
    };
    expect(payload.highWatermark).toBe(1);
    expect(payload.latest).toMatchObject({
      ledgerSeq: 1,
      receipt: { productSourceCommit: PRODUCT_SOURCE_COMMIT },
    });
    output.restore();
  });
});
