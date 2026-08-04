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
  appendKwragP0EvidenceEvent,
  appendKwragP0HandoffReceipt,
  closeKwragP0HandoffReceiptStore,
  KWRAG_P0_MAX_LEDGER_RECEIPTS,
  KwragP0HandoffReceiptCapacityError,
  KwragP0HandoffReceiptConflictError,
  KwragP0HandoffReceiptLedgerCorruptError,
  readKwragP0HandoffLedgerSnapshot,
} from "./kwrag-p0-handoff.store.js";
import { stableStringify } from "./stable-stringify.js";

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

function buildIndexedReceipt(index: number): KwragP0HandoffReceipt {
  return mutateReceipt(buildReceipt(), (changed) => {
    const suffix = index.toString(16).padStart(64, "0");
    changed.handoffDigest = `sha256:${suffix}`;
    changed.consumptionReceiptDigest = `sha256:${suffix}`;
    changed.runId = `run-p0-index-${index}`;
    changed.sessionId = `session-p0-index-${index}`;
  });
}

function buildEvidenceEvent(
  stored: ReturnType<typeof appendKwragP0HandoffReceipt>,
  overrides: Record<string, unknown> = {},
) {
  const body = {
    schema: "jitech-openclaw-kwrag-evidence-event/v1",
    stage: "evidence_dispatch_handoff_committed",
    p0LedgerSeq: stored.ledgerSeq,
    p0ReceiptDigest: stored.receipt.receiptDigest,
    runId: stored.receipt.runId,
    sessionId: stored.receipt.sessionId,
    attempt: 1,
    p1IdentityDigest: `sha256:${"1".repeat(64)}`,
    resultReceiptDigest: stored.receipt.resultReceiptDigest,
    contextDigest: `sha256:${"2".repeat(64)}`,
    contextBytes: 1,
    resultCount: 1,
    consumptionStatus: "consumed",
    promptProjectionApplied: true,
    previousReceiptDigest: null,
    provider: "google",
    model: "gemini-test",
    finishReason: null,
    ...overrides,
  };
  const receipt = {
    ...body,
    receiptDigest: digestKwragP0CanonicalWithoutField(
      { ...body, receiptDigest: "ignored" },
      "receiptDigest",
    ),
  };
  return {
    p0LedgerSeq: receipt.p0LedgerSeq,
    p0ReceiptDigest: receipt.p0ReceiptDigest as string,
    attempt: receipt.attempt,
    stage: receipt.stage as "evidence_dispatch_handoff_committed" | "response_observed",
    receiptDigest: receipt.receiptDigest,
    receiptJson: stableStringify(receipt),
  };
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
      receiptCount: 1,
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

  it("binds evidence events to one canonical P0 row and rejects altered replay", () => {
    const stored = appendKwragP0HandoffReceipt(buildReceipt());
    const event = buildEvidenceEvent(stored);
    appendKwragP0EvidenceEvent(event);
    appendKwragP0EvidenceEvent(event);

    expect(() =>
      appendKwragP0EvidenceEvent(buildEvidenceEvent(stored, { model: "changed-model" })),
    ).toThrow(KwragP0HandoffReceiptConflictError);
    closeKwragP0HandoffReceiptStore();
    expect(readKwragP0HandoffLedgerSnapshot().latestEvidenceEvents).toEqual([
      JSON.parse(event.receiptJson),
    ]);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(resolveKwragP0HandoffReceiptDbPath(process.env), {
      readOnly: true,
    });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM kwrag_p0_evidence_event").get()).toEqual({
        count: 1,
      });
      expect(db.prepare("SELECT receipt_json FROM kwrag_p0_evidence_event").get()).toEqual({
        receipt_json: event.receiptJson,
      });
    } finally {
      db.close();
    }
  });

  it("accepts the embedded runner attempt ceiling and rejects the next attempt", () => {
    const stored = appendKwragP0HandoffReceipt(buildReceipt());
    appendKwragP0EvidenceEvent(buildEvidenceEvent(stored, { attempt: 160 }));

    expect(() =>
      appendKwragP0EvidenceEvent(buildEvidenceEvent(stored, { attempt: 161 })),
    ).toThrow();
    expect(readKwragP0HandoffLedgerSnapshot().latestEvidenceEvents).toHaveLength(1);
  });

  it("selects the exact run receipt chain instead of the mutable global latest", () => {
    const first = appendKwragP0HandoffReceipt(buildReceipt());
    const firstEvent = buildEvidenceEvent(first);
    appendKwragP0EvidenceEvent(firstEvent);
    const second = appendKwragP0HandoffReceipt(buildIndexedReceipt(2));
    appendKwragP0EvidenceEvent(buildEvidenceEvent(second));
    closeKwragP0HandoffReceiptStore();

    const selected = readKwragP0HandoffLedgerSnapshot(process.env, first.receipt.runId);
    expect(selected.latest).toEqual(first);
    expect(selected.latestEvidenceEvents).toEqual([JSON.parse(firstEvent.receiptJson)]);
    expect(selected.highWatermark).toBe(second.ledgerSeq);
  });

  it("rejects evidence events with no exact P0 parent or invalid canonical bytes", () => {
    const stored = appendKwragP0HandoffReceipt(buildReceipt());
    const event = buildEvidenceEvent(stored);
    expect(() =>
      appendKwragP0EvidenceEvent({ ...event, p0LedgerSeq: stored.ledgerSeq + 1 }),
    ).toThrow(KwragP0HandoffReceiptLedgerCorruptError);
    expect(() =>
      appendKwragP0EvidenceEvent({
        ...event,
        p0ReceiptDigest: `sha256:${"f".repeat(64)}`,
      }),
    ).toThrow(KwragP0HandoffReceiptLedgerCorruptError);
    expect(() =>
      appendKwragP0EvidenceEvent({ ...event, receiptJson: `${event.receiptJson} ` }),
    ).toThrow(KwragP0HandoffReceiptLedgerCorruptError);
    closeKwragP0HandoffReceiptStore();
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(resolveKwragP0HandoffReceiptDbPath(process.env), {
      readOnly: true,
    });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM kwrag_p0_evidence_event").get()).toEqual({
        count: 0,
      });
    } finally {
      db.close();
    }
  });

  it("fails closed when linked evidence bytes drift on disk", () => {
    const stored = appendKwragP0HandoffReceipt(buildReceipt());
    appendKwragP0EvidenceEvent(buildEvidenceEvent(stored));
    closeKwragP0HandoffReceiptStore();
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(resolveKwragP0HandoffReceiptDbPath(process.env));
    try {
      db.prepare("UPDATE kwrag_p0_evidence_event SET receipt_json = ?").run('{"drift":true}');
    } finally {
      db.close();
    }
    expect(() => readKwragP0HandoffLedgerSnapshot()).toThrow(
      KwragP0HandoffReceiptLedgerCorruptError,
    );
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
      receiptCount: 0,
      latest: null,
    });
    expect(existsSync(dbPath)).toBe(false);
  });

  it("keeps a pre-evidence P0 ledger readable without migrating it", () => {
    const stored = appendKwragP0HandoffReceipt(buildReceipt());
    closeKwragP0HandoffReceiptStore();
    const { DatabaseSync } = requireNodeSqlite();
    const dbPath = resolveKwragP0HandoffReceiptDbPath(process.env);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("DROP TABLE kwrag_p0_evidence_event");
    } finally {
      db.close();
    }

    expect(readKwragP0HandoffLedgerSnapshot()).toEqual({
      ledgerAvailable: true,
      highWatermark: 1,
      receiptCount: 1,
      latest: stored,
    });
    const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        verifyDb.prepare("SELECT 1 FROM sqlite_master WHERE name='kwrag_p0_evidence_event'").get(),
      ).toBeUndefined();
    } finally {
      verifyDb.close();
    }
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

  it("fails closed when the consumption receipt index disagrees with canonical bytes", () => {
    const receipt = buildReceipt();
    appendKwragP0HandoffReceipt(receipt);
    closeKwragP0HandoffReceiptStore();

    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(resolveKwragP0HandoffReceiptDbPath(process.env));
    try {
      db.prepare(
        "UPDATE kwrag_p0_handoff_receipt SET consumption_receipt_digest = ? WHERE handoff_digest = ?",
      ).run(`sha256:${"f".repeat(64)}`, receipt.handoffDigest);
    } finally {
      db.close();
    }

    expect(() => appendKwragP0HandoffReceipt(buildSecondHandoffReceipt())).toThrow(
      KwragP0HandoffReceiptLedgerCorruptError,
    );
    closeKwragP0HandoffReceiptStore();
    const verifyDb = new DatabaseSync(resolveKwragP0HandoffReceiptDbPath(process.env), {
      readOnly: true,
    });
    try {
      expect(
        verifyDb.prepare("SELECT COUNT(*) AS count FROM kwrag_p0_handoff_receipt").get(),
      ).toEqual({ count: 1 });
    } finally {
      verifyDb.close();
    }
    expect(() => readKwragP0HandoffLedgerSnapshot()).toThrow(
      KwragP0HandoffReceiptLedgerCorruptError,
    );
  });

  it("keeps integrity work bounded and permits only identical replay at the row cap", () => {
    const receipts = Array.from({ length: KWRAG_P0_MAX_LEDGER_RECEIPTS }, (_, index) =>
      buildIndexedReceipt(index + 1),
    );
    for (const receipt of receipts) {
      appendKwragP0HandoffReceipt(receipt);
    }

    expect(appendKwragP0HandoffReceipt(receipts[0])).toEqual({
      ledgerSeq: 1,
      receipt: receipts[0],
    });
    const overflow = buildIndexedReceipt(KWRAG_P0_MAX_LEDGER_RECEIPTS + 1);
    expect(() => appendKwragP0HandoffReceipt(overflow)).toThrow(KwragP0HandoffReceiptCapacityError);
    expect(readKwragP0HandoffLedgerSnapshot().highWatermark).toBe(KWRAG_P0_MAX_LEDGER_RECEIPTS);
  });

  it("fails closed when a canonical middle row is deleted", () => {
    for (let index = 1; index <= 3; index += 1) {
      appendKwragP0HandoffReceipt(buildIndexedReceipt(index));
    }
    closeKwragP0HandoffReceiptStore();

    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(resolveKwragP0HandoffReceiptDbPath(process.env));
    try {
      db.prepare("DELETE FROM kwrag_p0_handoff_receipt WHERE ledger_seq = 2").run();
    } finally {
      db.close();
    }

    expect(() => appendKwragP0HandoffReceipt(buildIndexedReceipt(4))).toThrow(
      KwragP0HandoffReceiptLedgerCorruptError,
    );
    closeKwragP0HandoffReceiptStore();
    const verifyDb = new DatabaseSync(resolveKwragP0HandoffReceiptDbPath(process.env), {
      readOnly: true,
    });
    try {
      expect(
        verifyDb.prepare("SELECT COUNT(*) AS count FROM kwrag_p0_handoff_receipt").get(),
      ).toEqual({ count: 2 });
    } finally {
      verifyDb.close();
    }
    expect(() => readKwragP0HandoffLedgerSnapshot()).toThrow(
      KwragP0HandoffReceiptLedgerCorruptError,
    );
  });

  it.each([
    { label: "tail", deleteSql: "DELETE FROM kwrag_p0_handoff_receipt WHERE ledger_seq = 3" },
    { label: "all", deleteSql: "DELETE FROM kwrag_p0_handoff_receipt" },
  ])("fails closed when canonical $label rows are deleted", ({ deleteSql }) => {
    for (let index = 1; index <= 3; index += 1) {
      appendKwragP0HandoffReceipt(buildIndexedReceipt(index));
    }
    closeKwragP0HandoffReceiptStore();

    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(resolveKwragP0HandoffReceiptDbPath(process.env));
    let countAfterDelete = 0;
    try {
      db.exec(deleteSql);
      const row = db.prepare("SELECT COUNT(*) AS count FROM kwrag_p0_handoff_receipt").get() as {
        count: number;
      };
      countAfterDelete = row.count;
    } finally {
      db.close();
    }

    expect(() => readKwragP0HandoffLedgerSnapshot()).toThrow(
      KwragP0HandoffReceiptLedgerCorruptError,
    );
    expect(() => appendKwragP0HandoffReceipt(buildIndexedReceipt(4))).toThrow(
      KwragP0HandoffReceiptLedgerCorruptError,
    );
    closeKwragP0HandoffReceiptStore();
    const verifyDb = new DatabaseSync(resolveKwragP0HandoffReceiptDbPath(process.env), {
      readOnly: true,
    });
    try {
      const countRow = verifyDb
        .prepare("SELECT COUNT(*) AS count FROM kwrag_p0_handoff_receipt")
        .get();
      const sequenceRow = verifyDb
        .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'kwrag_p0_handoff_receipt'")
        .get();
      expect(countRow).toEqual({ count: countAfterDelete });
      expect(sequenceRow).toEqual({ seq: 3 });
    } finally {
      verifyDb.close();
    }
  });

  it.each([
    {
      label: "many-duplicate",
      seedCount: 3,
      expectedCount: 3,
      mutationSql:
        "WITH RECURSIVE duplicate_anchor(value) AS (VALUES (1) UNION ALL SELECT value + 1 FROM duplicate_anchor WHERE value < 128) INSERT INTO sqlite_sequence(name, seq) SELECT 'kwrag_p0_handoff_receipt', 3 FROM duplicate_anchor",
    },
    {
      label: "NULL",
      seedCount: 1,
      expectedCount: 0,
      mutationSql:
        "DELETE FROM kwrag_p0_handoff_receipt; UPDATE sqlite_sequence SET seq = NULL WHERE name = 'kwrag_p0_handoff_receipt'",
    },
    {
      label: "empty-ledger",
      seedCount: 1,
      expectedCount: 0,
      mutationSql:
        "DELETE FROM kwrag_p0_handoff_receipt; UPDATE sqlite_sequence SET seq = 0 WHERE name = 'kwrag_p0_handoff_receipt'",
    },
    {
      label: "REAL",
      seedCount: 1,
      expectedCount: 1,
      mutationSql:
        "UPDATE sqlite_sequence SET seq = CAST(1 AS REAL) WHERE name = 'kwrag_p0_handoff_receipt'",
    },
    {
      label: "TEXT",
      seedCount: 1,
      expectedCount: 1,
      mutationSql:
        "UPDATE sqlite_sequence SET seq = CAST(1 AS TEXT) WHERE name = 'kwrag_p0_handoff_receipt'",
    },
  ])(
    "fails closed for a malformed $label sequence anchor",
    ({ seedCount, expectedCount, mutationSql }) => {
      for (let index = 1; index <= seedCount; index += 1) {
        appendKwragP0HandoffReceipt(buildIndexedReceipt(index));
      }
      closeKwragP0HandoffReceiptStore();

      const { DatabaseSync } = requireNodeSqlite();
      const dbPath = resolveKwragP0HandoffReceiptDbPath(process.env);
      const db = new DatabaseSync(dbPath);
      let sequenceRowsBefore: unknown[] = [];
      try {
        db.exec(mutationSql);
        sequenceRowsBefore = db
          .prepare(
            "SELECT name, seq, typeof(seq) AS storage_class, quote(seq) AS quoted FROM sqlite_sequence ORDER BY rowid ASC",
          )
          .all();
      } finally {
        db.close();
      }

      expect(() => readKwragP0HandoffLedgerSnapshot()).toThrow(
        KwragP0HandoffReceiptLedgerCorruptError,
      );
      expect(() => appendKwragP0HandoffReceipt(buildIndexedReceipt(seedCount + 1))).toThrow(
        KwragP0HandoffReceiptLedgerCorruptError,
      );
      closeKwragP0HandoffReceiptStore();
      const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(
          verifyDb.prepare("SELECT COUNT(*) AS count FROM kwrag_p0_handoff_receipt").get(),
        ).toEqual({ count: expectedCount });
        expect(
          verifyDb
            .prepare(
              "SELECT name, seq, typeof(seq) AS storage_class, quote(seq) AS quoted FROM sqlite_sequence ORDER BY rowid ASC",
            )
            .all(),
        ).toEqual(sequenceRowsBefore);
      } finally {
        verifyDb.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")("repairs restrictive ledger permissions", () => {
    appendKwragP0HandoffReceipt(buildReceipt());
    const dbPath = resolveKwragP0HandoffReceiptDbPath(process.env);
    chmodSync(dbPath, 0o644);
    appendKwragP0HandoffReceipt(buildReceipt());
    const mode = statSync(dbPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
