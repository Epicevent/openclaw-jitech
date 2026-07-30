import { chmodSync, existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { buildKwragP0TestHandoff } from "./kwrag-p0-handoff.fixture.js";
import {
  assertKwragP0HandoffReceipt,
  digestKwragP0CanonicalWithoutField,
  verifyOptionalKwragP0Handoff,
  type KwragP0HandoffReceipt,
} from "./kwrag-p0-handoff.js";
import { resolveKwragP0HandoffReceiptDbPath } from "./kwrag-p0-handoff.paths.js";
import {
  appendKwragP0HandoffReceipt,
  closeKwragP0HandoffReceiptStore,
  KwragP0HandoffReceiptConflictError,
  KwragP0HandoffReceiptLedgerCorruptError,
  readKwragP0HandoffLedgerSnapshot,
} from "./kwrag-p0-handoff.store.js";

const PRODUCT_SOURCE_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function buildReceipt(): KwragP0HandoffReceipt {
  const receipt = verifyOptionalKwragP0Handoff({
    input: buildKwragP0TestHandoff(),
    runId: "run-p0-1",
    sessionId: "session-p0-1",
    productSourceCommit: PRODUCT_SOURCE_COMMIT,
  });
  if (!receipt) {
    throw new Error("expected fixture receipt");
  }
  return receipt;
}

function buildSecondHandoffReceipt(): KwragP0HandoffReceipt {
  const receipt = verifyOptionalKwragP0Handoff({
    input: buildKwragP0TestHandoff((body) => {
      body.runId = "run-p0-2";
    }),
    runId: "run-p0-2",
    sessionId: "session-p0-2",
    productSourceCommit: PRODUCT_SOURCE_COMMIT,
  });
  if (!receipt) {
    throw new Error("expected second fixture receipt");
  }
  return receipt;
}

function mutateReceipt(
  receipt: KwragP0HandoffReceipt,
  mutate: (value: Record<string, unknown>) => void,
): KwragP0HandoffReceipt {
  const changed = structuredClone(receipt) as unknown as Record<string, unknown>;
  mutate(changed);
  changed.receiptDigest = digestKwragP0CanonicalWithoutField(changed, "receiptDigest");
  assertKwragP0HandoffReceipt(changed);
  return changed;
}

describe("KWRAG P0 handoff receipt store", () => {
  let stateDir: string;

  beforeEach(async () => {
    closeKwragP0HandoffReceiptStore();
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-kwrag-p0-store-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    closeKwragP0HandoffReceiptStore();
    vi.unstubAllEnvs();
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("persists one canonical content-free receipt and reopens it read-only", () => {
    const receipt = buildReceipt();
    const stored = appendKwragP0HandoffReceipt(receipt);

    expect(stored).toMatchObject({ ledgerSeq: 1, receipt });
    closeKwragP0HandoffReceiptStore();
    expect(readKwragP0HandoffLedgerSnapshot()).toEqual({
      ledgerAvailable: true,
      highWatermark: 1,
      latest: stored,
    });
  });

  it("accepts byte-identical replay but rejects a different receipt for the same handoff", () => {
    const receipt = buildReceipt();
    const first = appendKwragP0HandoffReceipt(receipt);
    const replay = appendKwragP0HandoffReceipt(receipt);
    expect(replay).toEqual(first);

    const rebound = mutateReceipt(receipt, (changed) => {
      changed.sessionId = "session-p0-rebound";
    });
    expect(() => appendKwragP0HandoffReceipt(rebound)).toThrow(KwragP0HandoffReceiptConflictError);
    expect(readKwragP0HandoffLedgerSnapshot().highWatermark).toBe(1);
  });

  it("rejects rebinding one consumption receipt to a different handoff", () => {
    appendKwragP0HandoffReceipt(buildReceipt());

    expect(() => appendKwragP0HandoffReceipt(buildSecondHandoffReceipt())).toThrow(
      KwragP0HandoffReceiptConflictError,
    );
    expect(readKwragP0HandoffLedgerSnapshot().highWatermark).toBe(1);
  });

  it("does not initialize a ledger when no caller-explicit handoff exists", () => {
    const dbPath = resolveKwragP0HandoffReceiptDbPath(process.env);
    expect(readKwragP0HandoffLedgerSnapshot()).toEqual({
      ledgerAvailable: false,
      highWatermark: null,
      latest: null,
    });
    expect(existsSync(dbPath)).toBe(false);
  });

  it("fails closed when persisted canonical bytes are corrupted", () => {
    const receipt = buildReceipt();
    appendKwragP0HandoffReceipt(receipt);
    closeKwragP0HandoffReceiptStore();

    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(resolveKwragP0HandoffReceiptDbPath(process.env));
    try {
      db.prepare(
        "UPDATE kwrag_p0_handoff_receipt SET receipt_json = ? WHERE handoff_digest = ?",
      ).run('{"corrupt":true}', receipt.handoffDigest);
    } finally {
      db.close();
    }

    expect(() => readKwragP0HandoffLedgerSnapshot()).toThrow(
      KwragP0HandoffReceiptLedgerCorruptError,
    );
  });

  it.skipIf(process.platform === "win32")("repairs restrictive ledger permissions", () => {
    appendKwragP0HandoffReceipt(buildReceipt());
    const dbPath = resolveKwragP0HandoffReceiptDbPath(process.env);
    chmodSync(dbPath, 0o644);
    appendKwragP0HandoffReceipt(buildReceipt());
    const mode = statSync(dbPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
