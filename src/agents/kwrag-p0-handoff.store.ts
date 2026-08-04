import { chmodSync, existsSync, mkdirSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  assertKwragP0HandoffReceipt,
  digestKwragP0Canonical,
  serializeKwragP0HandoffReceipt,
  type KwragP0HandoffReceipt,
} from "./kwrag-p0-handoff.js";
import {
  resolveKwragP0HandoffReceiptDbPath,
  resolveKwragP0HandoffReceiptDir,
} from "./kwrag-p0-handoff.paths.js";
import { stableStringify } from "./stable-stringify.js";

const RECEIPT_DIR_MODE = 0o700;
const RECEIPT_FILE_MODE = 0o600;
export const KWRAG_P0_MAX_LEDGER_RECEIPTS = 64;
const KWRAG_P0_MAX_EVIDENCE_EVENTS = KWRAG_P0_MAX_LEDGER_RECEIPTS * 16 * 2;

type ReceiptRow = {
  ledger_seq: number | bigint;
  handoff_digest: string;
  receipt_digest: string;
  consumption_receipt_digest: string;
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
  receiptCount: number;
  latest: StoredKwragP0HandoffReceipt | null;
  latestEvidenceEvents?: ReadonlyArray<Readonly<Record<string, unknown>>>;
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

export class KwragP0HandoffReceiptCapacityError extends Error {
  constructor() {
    super(`KWRAG P0 handoff receipt ledger reached its ${KWRAG_P0_MAX_LEDGER_RECEIPTS}-row cap`);
    this.name = "KwragP0HandoffReceiptCapacityError";
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
    CREATE TABLE IF NOT EXISTS kwrag_p0_evidence_event (
      p0_ledger_seq INTEGER NOT NULL,
      attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 16),
      stage TEXT NOT NULL CHECK(stage IN ('evidence_dispatch_handoff_committed', 'response_observed')),
      receipt_digest TEXT NOT NULL UNIQUE,
      receipt_json TEXT NOT NULL,
      PRIMARY KEY(p0_ledger_seq, attempt, stage),
      FOREIGN KEY(p0_ledger_seq) REFERENCES kwrag_p0_handoff_receipt(ledger_seq)
    );
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
      SELECT ledger_seq, handoff_digest, receipt_digest, consumption_receipt_digest,
             product_source_commit, receipt_json
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
  db.exec("PRAGMA foreign_keys = ON;");
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
    if (parsed.consumptionReceiptDigest !== row.consumption_receipt_digest) {
      throw new Error("stored consumptionReceiptDigest disagrees with its index");
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

function readCanonicalReceiptRows(db: DatabaseSync): StoredKwragP0HandoffReceipt[] {
  const countRow = db.prepare("SELECT COUNT(*) AS count FROM kwrag_p0_handoff_receipt").get() as
    | { count: number | bigint }
    | undefined;
  const countRaw = countRow?.count;
  const count = typeof countRaw === "bigint" ? Number(countRaw) : countRaw;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new KwragP0HandoffReceiptLedgerCorruptError("invalid receipt count");
  }
  if (count > KWRAG_P0_MAX_LEDGER_RECEIPTS) {
    throw new KwragP0HandoffReceiptLedgerCorruptError(
      `receipt count exceeds the ${KWRAG_P0_MAX_LEDGER_RECEIPTS}-row P0 cap`,
    );
  }
  const rows = db
    .prepare(`
      SELECT ledger_seq, handoff_digest, receipt_digest, consumption_receipt_digest,
             product_source_commit, receipt_json
      FROM kwrag_p0_handoff_receipt
      ORDER BY ledger_seq ASC
    `)
    .all() as unknown as ReceiptRow[];
  if (rows.length !== count) {
    throw new KwragP0HandoffReceiptLedgerCorruptError("receipt count changed within snapshot");
  }
  const sequenceRows = db
    .prepare(`
      SELECT seq, typeof(seq) AS storage_class
      FROM sqlite_sequence
      WHERE name = 'kwrag_p0_handoff_receipt'
      LIMIT 2
    `)
    .all() as unknown as Array<{ seq: unknown; storage_class: unknown }>;
  if (count === 0 && sequenceRows.length === 0) {
    return [];
  }
  if (sequenceRows.length !== 1) {
    throw new KwragP0HandoffReceiptLedgerCorruptError(
      "monotonic sequence anchor cardinality is invalid",
    );
  }
  const sequenceRow = sequenceRows[0];
  if (sequenceRow?.storage_class !== "integer") {
    throw new KwragP0HandoffReceiptLedgerCorruptError(
      "monotonic sequence anchor storage class is invalid",
    );
  }
  const sequenceRaw = sequenceRow.seq;
  const sequence = typeof sequenceRaw === "bigint" ? Number(sequenceRaw) : sequenceRaw;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new KwragP0HandoffReceiptLedgerCorruptError("invalid monotonic sequence anchor");
  }
  if (sequence !== count) {
    throw new KwragP0HandoffReceiptLedgerCorruptError(
      "receipt count disagrees with the monotonic sequence anchor",
    );
  }
  const receipts = rows.map((row) => parseReceiptRow(row));
  for (const [index, receipt] of receipts.entries()) {
    if (receipt.ledgerSeq !== index + 1) {
      throw new KwragP0HandoffReceiptLedgerCorruptError(
        `ledger sequence is not contiguous at position ${index + 1}`,
      );
    }
  }
  return receipts;
}

function assertIdenticalReplay(
  existing: StoredKwragP0HandoffReceipt,
  receipt: KwragP0HandoffReceipt,
  serialized: string,
): void {
  if (
    existing.receipt.receiptDigest !== receipt.receiptDigest ||
    existing.receipt.consumptionReceiptDigest !== receipt.consumptionReceiptDigest ||
    serializeKwragP0HandoffReceipt(existing.receipt) !== serialized
  ) {
    throw new KwragP0HandoffReceiptConflictError(receipt.handoffDigest);
  }
}

export function appendKwragP0HandoffReceipt(
  receipt: KwragP0HandoffReceipt,
): StoredKwragP0HandoffReceipt {
  const serialized = serializeKwragP0HandoffReceipt(receipt);
  const store = openReceiptDatabase();
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const canonicalRows = readCanonicalReceiptRows(store.db);
    const replay = canonicalRows.find(
      (stored) => stored.receipt.handoffDigest === receipt.handoffDigest,
    );
    if (replay) {
      assertIdenticalReplay(replay, receipt, serialized);
      store.db.exec("COMMIT");
      ensureReceiptPermissions(store.path);
      return replay;
    }
    if (canonicalRows.length >= KWRAG_P0_MAX_LEDGER_RECEIPTS) {
      throw new KwragP0HandoffReceiptCapacityError();
    }
    let insertedLedgerSeq: number;
    try {
      const insertResult = store.statements.insertReceipt.run(
        receipt.handoffDigest,
        receipt.receiptDigest,
        receipt.consumptionReceiptDigest,
        receipt.productSourceCommit,
        serialized,
      );
      const changes =
        typeof insertResult.changes === "bigint"
          ? Number(insertResult.changes)
          : insertResult.changes;
      insertedLedgerSeq = normalizeLedgerSeq(insertResult.lastInsertRowid);
      if (changes !== 1 || insertedLedgerSeq !== canonicalRows.length + 1) {
        throw new KwragP0HandoffReceiptLedgerCorruptError(
          "insert result disagrees with the monotonic sequence anchor",
        );
      }
    } catch (error) {
      if (error instanceof KwragP0HandoffReceiptLedgerCorruptError) {
        throw error;
      }
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
    if (normalizeLedgerSeq(existing.ledger_seq) !== insertedLedgerSeq) {
      throw new KwragP0HandoffReceiptLedgerCorruptError(
        "inserted row disagrees with the returned ledger sequence",
      );
    }
    if (
      existing.receipt_digest !== receipt.receiptDigest ||
      existing.consumption_receipt_digest !== receipt.consumptionReceiptDigest ||
      existing.receipt_json !== serialized
    ) {
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

export function appendKwragP0EvidenceEvent(event: {
  p0LedgerSeq: number;
  p0ReceiptDigest: string;
  attempt: number;
  stage: "evidence_dispatch_handoff_committed" | "response_observed";
  receiptDigest: string;
  receiptJson: string;
}): void {
  const parsed = JSON.parse(event.receiptJson) as Record<string, unknown>;
  const { receiptDigest, ...body } = parsed;
  if (
    stableStringify(parsed) !== event.receiptJson ||
    receiptDigest !== event.receiptDigest ||
    digestKwragP0Canonical(body) !== receiptDigest ||
    parsed.p0LedgerSeq !== event.p0LedgerSeq ||
    parsed.p0ReceiptDigest !== event.p0ReceiptDigest ||
    parsed.attempt !== event.attempt ||
    parsed.stage !== event.stage
  ) {
    throw new KwragP0HandoffReceiptLedgerCorruptError("invalid linked evidence event");
  }
  const store = openReceiptDatabase();
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const parent = readCanonicalReceiptRows(store.db).find(
      (row) => row.ledgerSeq === event.p0LedgerSeq,
    );
    if (!parent || parent.receipt.receiptDigest !== event.p0ReceiptDigest) {
      throw new KwragP0HandoffReceiptLedgerCorruptError("evidence event has no P0 receipt");
    }
    const select = store.db.prepare(`
      SELECT receipt_digest, receipt_json FROM kwrag_p0_evidence_event
      WHERE p0_ledger_seq = ? AND attempt = ? AND stage = ?
    `);
    const existing = select.get(event.p0LedgerSeq, event.attempt, event.stage) as
      | { receipt_digest: string; receipt_json: string }
      | undefined;
    if (existing) {
      if (
        existing.receipt_digest !== event.receiptDigest ||
        existing.receipt_json !== event.receiptJson
      ) {
        throw new KwragP0HandoffReceiptConflictError(event.receiptDigest);
      }
    } else {
      store.db
        .prepare(`
          INSERT INTO kwrag_p0_evidence_event
            (p0_ledger_seq, attempt, stage, receipt_digest, receipt_json)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(event.p0LedgerSeq, event.attempt, event.stage, event.receiptDigest, event.receiptJson);
    }
    store.db.exec("COMMIT");
    ensureReceiptPermissions(store.path);
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

function readEvidenceEvents(db: DatabaseSync, receipts: StoredKwragP0HandoffReceipt[]) {
  const rows = db
    .prepare(`SELECT p0_ledger_seq, attempt, stage, receipt_digest, receipt_json
      FROM kwrag_p0_evidence_event ORDER BY p0_ledger_seq, attempt, stage LIMIT ?`)
    .all(KWRAG_P0_MAX_EVIDENCE_EVENTS + 1) as Array<Record<string, unknown>>;
  if (rows.length > KWRAG_P0_MAX_EVIDENCE_EVENTS) {
    throw new KwragP0HandoffReceiptLedgerCorruptError("too many linked evidence events");
  }
  const parents = new Map(receipts.map((value) => [value.ledgerSeq, value.receipt.receiptDigest]));
  return rows.map((row) => {
    const parsed = JSON.parse(String(row.receipt_json)) as Record<string, unknown>;
    const { receiptDigest, ...body } = parsed;
    if (
      stableStringify(parsed) !== row.receipt_json ||
      receiptDigest !== row.receipt_digest ||
      digestKwragP0Canonical(body) !== receiptDigest ||
      parsed.p0LedgerSeq !== row.p0_ledger_seq ||
      parsed.attempt !== row.attempt ||
      parsed.stage !== row.stage ||
      parsed.p0ReceiptDigest !== parents.get(Number(row.p0_ledger_seq))
    ) {
      throw new KwragP0HandoffReceiptLedgerCorruptError("invalid linked evidence event");
    }
    return Object.freeze(parsed);
  });
}

function readSnapshotFromDatabase(db: DatabaseSync): KwragP0HandoffLedgerSnapshot {
  db.exec("BEGIN");
  try {
    const receipts = readCanonicalReceiptRows(db);
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
    const latest = receipts.at(-1) ?? null;
    if ((latest?.ledgerSeq ?? 0) !== highWatermarkRaw) {
      throw new KwragP0HandoffReceiptLedgerCorruptError(
        "latest receipt does not match the ledger high watermark",
      );
    }
    const hasEventTable = db.prepare("PRAGMA table_info(kwrag_p0_evidence_event)").all().length;
    const events = hasEventTable ? readEvidenceEvents(db, receipts) : [];
    const latestEvents = events.filter((event) => event.p0LedgerSeq === highWatermarkRaw);
    db.exec("COMMIT");
    return Object.freeze({
      ledgerAvailable: true,
      highWatermark: highWatermarkRaw,
      receiptCount: receipts.length,
      latest,
      ...(latestEvents.length > 0 ? { latestEvidenceEvents: latestEvents } : {}),
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
    return Object.freeze({
      ledgerAvailable: false,
      highWatermark: null,
      receiptCount: 0,
      latest: null,
    });
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
