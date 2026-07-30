import { chmodSync, existsSync, mkdirSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  assertKwragP0HandoffReceipt,
  serializeKwragP0HandoffReceipt,
  type KwragP0HandoffReceipt,
} from "./kwrag-p0-handoff.js";
import {
  resolveKwragP0HandoffReceiptDbPath,
  resolveKwragP0HandoffReceiptDir,
} from "./kwrag-p0-handoff.paths.js";

const RECEIPT_DIR_MODE = 0o700;
const RECEIPT_FILE_MODE = 0o600;

type ReceiptRow = {
  ledger_seq: number | bigint;
  handoff_digest: string;
  receipt_digest: string;
  product_source_commit: string;
  receipt_json: string;
};

type ReceiptStatements = {
  insertReceipt: StatementSync;
  selectByHandoffDigest: StatementSync;
};

type ReceiptDatabase = {
  db: DatabaseSync;
  path: string;
  statements: ReceiptStatements;
};

export type StoredKwragP0HandoffReceipt = Readonly<{
  ledgerSeq: number;
  receipt: KwragP0HandoffReceipt;
}>;

export type KwragP0HandoffLedgerSnapshot = Readonly<{
  ledgerAvailable: boolean;
  highWatermark: number | null;
  latest: StoredKwragP0HandoffReceipt | null;
}>;

let cachedDatabase: ReceiptDatabase | null = null;

export class KwragP0HandoffReceiptConflictError extends Error {
  readonly handoffDigest: string;

  constructor(handoffDigest: string, cause?: unknown) {
    super(`KWRAG P0 handoff receipt conflict for handoffDigest=${handoffDigest}`, { cause });
    this.name = "KwragP0HandoffReceiptConflictError";
    this.handoffDigest = handoffDigest;
  }
}

export class KwragP0HandoffReceiptLedgerCorruptError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`KWRAG P0 handoff receipt ledger is corrupt: ${message}`, { cause });
    this.name = "KwragP0HandoffReceiptLedgerCorruptError";
  }
}

function normalizeLedgerSeq(value: number | bigint): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new KwragP0HandoffReceiptLedgerCorruptError(`invalid ledger sequence ${String(value)}`);
  }
  return normalized;
}

function ensureReceiptPermissions(pathname: string): void {
  const dir = resolveKwragP0HandoffReceiptDir(process.env);
  mkdirSync(dir, { recursive: true, mode: RECEIPT_DIR_MODE });
  chmodSync(dir, RECEIPT_DIR_MODE);
  if (existsSync(pathname)) {
    chmodSync(pathname, RECEIPT_FILE_MODE);
  }
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kwrag_p0_handoff_receipt (
      ledger_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      handoff_digest TEXT NOT NULL UNIQUE,
      receipt_digest TEXT NOT NULL,
      consumption_receipt_digest TEXT NOT NULL UNIQUE,
      product_source_commit TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_kwrag_p0_handoff_digest
      ON kwrag_p0_handoff_receipt(handoff_digest);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_kwrag_p0_consumption_receipt_digest
      ON kwrag_p0_handoff_receipt(consumption_receipt_digest);
  `);
}

function createStatements(db: DatabaseSync): ReceiptStatements {
  return {
    insertReceipt: db.prepare(`
      INSERT INTO kwrag_p0_handoff_receipt (
        handoff_digest,
        receipt_digest,
        consumption_receipt_digest,
        product_source_commit,
        receipt_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(handoff_digest) DO NOTHING
    `),
    selectByHandoffDigest: db.prepare(`
      SELECT ledger_seq, handoff_digest, receipt_digest, product_source_commit, receipt_json
      FROM kwrag_p0_handoff_receipt
      WHERE handoff_digest = ?
    `),
  };
}

function openReceiptDatabase(): ReceiptDatabase {
  const pathname = resolveKwragP0HandoffReceiptDbPath(process.env);
  if (cachedDatabase?.path === pathname) {
    return cachedDatabase;
  }
  closeKwragP0HandoffReceiptStore();
  ensureReceiptPermissions(pathname);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname);
  db.exec("PRAGMA journal_mode = DELETE;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  ensureSchema(db);
  ensureReceiptPermissions(pathname);
  cachedDatabase = { db, path: pathname, statements: createStatements(db) };
  return cachedDatabase;
}

function parseReceiptRow(row: ReceiptRow): StoredKwragP0HandoffReceipt {
  try {
    const parsed: unknown = JSON.parse(row.receipt_json);
    assertKwragP0HandoffReceipt(parsed);
    const serialized = serializeKwragP0HandoffReceipt(parsed);
    if (serialized !== row.receipt_json) {
      throw new Error("stored receipt bytes are not canonical");
    }
    if (parsed.handoffDigest !== row.handoff_digest) {
      throw new Error("stored handoffDigest disagrees with its index");
    }
    if (parsed.receiptDigest !== row.receipt_digest) {
      throw new Error("stored receiptDigest disagrees with its index");
    }
    if (parsed.productSourceCommit !== row.product_source_commit) {
      throw new Error("stored productSourceCommit disagrees with its index");
    }
    const immutableReceipt = Object.freeze({
      ...parsed,
      p1Identity: Object.freeze(parsed.p1Identity),
    });
    return Object.freeze({
      ledgerSeq: normalizeLedgerSeq(row.ledger_seq),
      receipt: immutableReceipt,
    });
  } catch (error) {
    if (error instanceof KwragP0HandoffReceiptLedgerCorruptError) {
      throw error;
    }
    throw new KwragP0HandoffReceiptLedgerCorruptError(
      `invalid row for handoffDigest=${row.handoff_digest}`,
      error,
    );
  }
}

export function appendKwragP0HandoffReceipt(
  receipt: KwragP0HandoffReceipt,
): StoredKwragP0HandoffReceipt {
  const serialized = serializeKwragP0HandoffReceipt(receipt);
  const store = openReceiptDatabase();
  store.db.exec("BEGIN IMMEDIATE");
  try {
    try {
      store.statements.insertReceipt.run(
        receipt.handoffDigest,
        receipt.receiptDigest,
        receipt.consumptionReceiptDigest,
        receipt.productSourceCommit,
        serialized,
      );
    } catch (error) {
      throw new KwragP0HandoffReceiptConflictError(receipt.handoffDigest, error);
    }
    const existing = store.statements.selectByHandoffDigest.get(receipt.handoffDigest) as
      | ReceiptRow
      | undefined;
    if (!existing) {
      throw new Error(
        `KWRAG P0 receipt insert disappeared for handoffDigest=${receipt.handoffDigest}`,
      );
    }
    if (existing.receipt_digest !== receipt.receiptDigest || existing.receipt_json !== serialized) {
      throw new KwragP0HandoffReceiptConflictError(receipt.handoffDigest);
    }
    store.db.exec("COMMIT");
    ensureReceiptPermissions(store.path);
    return parseReceiptRow(existing);
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

function readSnapshotFromDatabase(db: DatabaseSync): KwragP0HandoffLedgerSnapshot {
  db.exec("BEGIN");
  try {
    const boundary = db
      .prepare(
        "SELECT COALESCE(MAX(ledger_seq), 0) AS high_watermark FROM kwrag_p0_handoff_receipt",
      )
      .get() as { high_watermark: number | bigint } | undefined;
    if (!boundary) {
      throw new KwragP0HandoffReceiptLedgerCorruptError("high-watermark query returned no row");
    }
    const highWatermarkRaw =
      typeof boundary.high_watermark === "bigint"
        ? Number(boundary.high_watermark)
        : boundary.high_watermark;
    if (!Number.isSafeInteger(highWatermarkRaw) || highWatermarkRaw < 0) {
      throw new KwragP0HandoffReceiptLedgerCorruptError("invalid high watermark");
    }
    const row = db
      .prepare(`
        SELECT ledger_seq, handoff_digest, receipt_digest, product_source_commit, receipt_json
        FROM kwrag_p0_handoff_receipt
        ORDER BY ledger_seq DESC
        LIMIT 1
      `)
      .get() as ReceiptRow | undefined;
    const latest = row ? parseReceiptRow(row) : null;
    if ((latest?.ledgerSeq ?? 0) !== highWatermarkRaw) {
      throw new KwragP0HandoffReceiptLedgerCorruptError(
        "latest receipt does not match the ledger high watermark",
      );
    }
    db.exec("COMMIT");
    return Object.freeze({
      ledgerAvailable: true,
      highWatermark: highWatermarkRaw,
      latest,
    });
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function readKwragP0HandoffLedgerSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): KwragP0HandoffLedgerSnapshot {
  const pathname = resolveKwragP0HandoffReceiptDbPath(env);
  if (!existsSync(pathname)) {
    return Object.freeze({ ledgerAvailable: false, highWatermark: null, latest: null });
  }
  const cached = cachedDatabase?.path === pathname ? cachedDatabase.db : null;
  if (cached) {
    return readSnapshotFromDatabase(cached);
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    return readSnapshotFromDatabase(db);
  } finally {
    db.close();
  }
}

export function closeKwragP0HandoffReceiptStore(): void {
  cachedDatabase?.db.close();
  cachedDatabase = null;
}
