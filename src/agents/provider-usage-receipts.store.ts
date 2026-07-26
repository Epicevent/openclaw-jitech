import { chmodSync, existsSync, mkdirSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  canonicalizeProviderUsageReceiptBody,
  digestProviderUsageReceiptBody,
  ProviderUsageWireContractError,
} from "./provider-usage-receipts.contract.js";
import {
  resolveProviderUsageReceiptDbPath,
  resolveProviderUsageReceiptDir,
} from "./provider-usage-receipts.paths.js";
import {
  PROVIDER_USAGE_EXPORT_SCHEMA,
  type ProviderUsageCallReceipt,
  type ProviderUsageCallReceiptBody,
  type ProviderUsageReceiptExport,
} from "./provider-usage-receipts.types.js";

const RECEIPT_DIR_MODE = 0o700;
const RECEIPT_FILE_MODE = 0o600;
export const MAX_PROVIDER_USAGE_EXPORT_LIMIT = 500;

type ReceiptRow = {
  ledger_seq: number | bigint;
  call_id: string;
  receipt_digest: string;
  receipt_json: string;
};

type HighWatermarkRow = {
  high_watermark: number | bigint;
};

type ReceiptExportSnapshot = {
  highWatermark: number;
  rows: ReceiptRow[];
};

type ReceiptStatements = {
  insert: StatementSync;
  selectByCallId: StatementSync;
};

type ReceiptDatabase = {
  db: DatabaseSync;
  path: string;
  statements: ReceiptStatements;
};

let cachedDatabase: ReceiptDatabase | null = null;

export class ProviderUsageReceiptConflictError extends Error {
  readonly callId: string;

  constructor(callId: string) {
    super(`Provider usage receipt conflict for callId=${callId}`);
    this.name = "ProviderUsageReceiptConflictError";
    this.callId = callId;
  }
}

export class ProviderUsageReceiptLedgerUnavailableError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Provider usage receipt ledger is unavailable: ${path}`);
    this.name = "ProviderUsageReceiptLedgerUnavailableError";
    this.path = path;
  }
}

export class ProviderUsageReceiptLedgerCorruptError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`Provider usage receipt ledger is corrupt: ${message}`, { cause });
    this.name = "ProviderUsageReceiptLedgerCorruptError";
  }
}

function normalizeInteger(value: number | bigint): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new ProviderUsageReceiptLedgerCorruptError(`invalid ledger integer ${String(value)}`);
  }
  return normalized;
}

function ensureReceiptPermissions(pathname: string): void {
  const dir = resolveProviderUsageReceiptDir(process.env);
  mkdirSync(dir, { recursive: true, mode: RECEIPT_DIR_MODE });
  chmodSync(dir, RECEIPT_DIR_MODE);
  if (existsSync(pathname)) {
    chmodSync(pathname, RECEIPT_FILE_MODE);
  }
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_usage_call (
      ledger_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT NOT NULL UNIQUE,
      receipt_digest TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_usage_call_id
      ON provider_usage_call(call_id);
  `);
}

function createStatements(db: DatabaseSync): ReceiptStatements {
  return {
    insert: db.prepare(`
      INSERT INTO provider_usage_call (
        call_id,
        receipt_digest,
        receipt_json,
        created_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(call_id) DO NOTHING
    `),
    selectByCallId: db.prepare(`
      SELECT ledger_seq, call_id, receipt_digest, receipt_json
      FROM provider_usage_call
      WHERE call_id = ?
    `),
  };
}

function openReceiptDatabase(): ReceiptDatabase {
  const pathname = resolveProviderUsageReceiptDbPath(process.env);
  if (cachedDatabase?.path === pathname) {
    return cachedDatabase;
  }
  closeProviderUsageReceiptStore();
  ensureReceiptPermissions(pathname);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname);
  db.exec(`PRAGMA journal_mode = DELETE;`);
  db.exec(`PRAGMA synchronous = FULL;`);
  db.exec(`PRAGMA busy_timeout = 5000;`);
  ensureSchema(db);
  ensureReceiptPermissions(pathname);
  cachedDatabase = {
    db,
    path: pathname,
    statements: createStatements(db),
  };
  return cachedDatabase;
}

function parseReceiptRow(row: ReceiptRow): ProviderUsageCallReceipt {
  try {
    const parsed: unknown = JSON.parse(row.receipt_json);
    const body = parsed as ProviderUsageCallReceiptBody;
    const canonical = canonicalizeProviderUsageReceiptBody(body);
    const digest = digestProviderUsageReceiptBody(body);
    if (canonical !== row.receipt_json) {
      throw new ProviderUsageWireContractError("stored receipt bytes are not canonical");
    }
    if (body.callId !== row.call_id) {
      throw new ProviderUsageWireContractError("stored callId disagrees with its index");
    }
    if (digest !== row.receipt_digest) {
      throw new ProviderUsageWireContractError(
        "stored receiptDigest does not match canonical bytes",
      );
    }
    return {
      schema: body.schema,
      ledgerSeq: normalizeInteger(row.ledger_seq),
      receiptDigest: row.receipt_digest,
      callId: body.callId,
      runId: body.runId,
      turnId: body.turnId,
      requestId: body.requestId,
      sessionId: body.sessionId,
      trigger: body.trigger,
      attempt: body.attempt,
      retryOf: body.retryOf,
      fallbackParent: body.fallbackParent,
      fallbackIndex: body.fallbackIndex,
      startedAt: body.startedAt,
      completedAt: body.completedAt,
      status: body.status,
      configured: body.configured,
      requested: body.requested,
      actual: body.actual,
      usage: body.usage,
      usageCoverage: body.usageCoverage,
      missingUsageFields: body.missingUsageFields,
      receiptCoverage: body.receiptCoverage,
      missingReceiptFields: body.missingReceiptFields,
      finishReason: body.finishReason,
      errorCategory: body.errorCategory,
    };
  } catch (error) {
    if (error instanceof ProviderUsageReceiptLedgerCorruptError) {
      throw error;
    }
    throw new ProviderUsageReceiptLedgerCorruptError(
      `invalid row for callId=${row.call_id}`,
      error,
    );
  }
}

export function appendProviderUsageReceipt(
  body: ProviderUsageCallReceiptBody,
): ProviderUsageCallReceipt {
  const serialized = canonicalizeProviderUsageReceiptBody(body);
  const digest = digestProviderUsageReceiptBody(body);
  const store = openReceiptDatabase();
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.statements.insert.run(body.callId, digest, serialized, body.completedAt);
    const existing = store.statements.selectByCallId.get(body.callId) as ReceiptRow | undefined;
    if (!existing) {
      throw new Error(`Provider usage receipt insert disappeared for callId=${body.callId}`);
    }
    if (existing.receipt_digest !== digest || existing.receipt_json !== serialized) {
      throw new ProviderUsageReceiptConflictError(body.callId);
    }
    store.db.exec("COMMIT");
    ensureReceiptPermissions(store.path);
    return parseReceiptRow(existing);
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

function normalizeCursor(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return MAX_PROVIDER_USAGE_EXPORT_LIMIT;
  }
  return Math.min(value, MAX_PROVIDER_USAGE_EXPORT_LIMIT);
}

function readSnapshotFromDatabase(params: {
  db: DatabaseSync;
  after: number;
  limit: number;
}): ReceiptExportSnapshot {
  params.db.exec("BEGIN");
  try {
    const boundary = params.db
      .prepare(
        `SELECT COALESCE(MAX(ledger_seq), 0) AS high_watermark
         FROM provider_usage_call`,
      )
      .get() as HighWatermarkRow | undefined;
    if (!boundary) {
      throw new ProviderUsageReceiptLedgerCorruptError("high-watermark query returned no row");
    }
    const highWatermark = normalizeInteger(boundary.high_watermark);
    const rows = params.db
      .prepare(
        `SELECT ledger_seq, call_id, receipt_digest, receipt_json
         FROM provider_usage_call
         WHERE ledger_seq > ? AND ledger_seq <= ?
         ORDER BY ledger_seq ASC
         LIMIT ?`,
      )
      .all(params.after, highWatermark, params.limit + 1) as ReceiptRow[];
    params.db.exec("COMMIT");
    return { highWatermark, rows };
  } catch (error) {
    params.db.exec("ROLLBACK");
    throw error;
  }
}

function readExportSnapshot(params: {
  pathname: string;
  after: number;
  limit: number;
}): ReceiptExportSnapshot {
  const cached = cachedDatabase?.path === params.pathname ? cachedDatabase.db : null;
  if (cached) {
    return readSnapshotFromDatabase({ db: cached, after: params.after, limit: params.limit });
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(params.pathname, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = 5000;`);
    return readSnapshotFromDatabase({ db, after: params.after, limit: params.limit });
  } finally {
    db.close();
  }
}

export function exportProviderUsageReceipts(
  params: {
    after?: number;
    limit?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): ProviderUsageReceiptExport {
  const after = normalizeCursor(params.after);
  const limit = normalizeLimit(params.limit);
  const pathname = resolveProviderUsageReceiptDbPath(params.env ?? process.env);
  if (!existsSync(pathname)) {
    throw new ProviderUsageReceiptLedgerUnavailableError(pathname);
  }
  const snapshot = readExportSnapshot({ pathname, after, limit });
  if (snapshot.highWatermark < after) {
    throw new ProviderUsageReceiptLedgerCorruptError(
      `ledger moved backwards: after=${after} highWatermark=${snapshot.highWatermark}`,
    );
  }
  const hasMore = snapshot.rows.length > limit;
  const receipts = snapshot.rows.slice(0, limit).map(parseReceiptRow);
  return {
    schema: PROVIDER_USAGE_EXPORT_SCHEMA,
    after,
    nextCursor: receipts.at(-1)?.ledgerSeq ?? after,
    highWatermark: snapshot.highWatermark,
    count: receipts.length,
    hasMore,
    receipts,
  };
}

export function closeProviderUsageReceiptStore(): void {
  cachedDatabase?.db.close();
  cachedDatabase = null;
}
