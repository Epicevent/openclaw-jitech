import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";

export const KAKAOWORK_PERIODS = ["rolling_7d", "previous_calendar_week"] as const;
export type KakaoworkPeriod = (typeof KAKAOWORK_PERIODS)[number];

const SEOUL_OFFSET_SECONDS = 9 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const REQUIRED_MESSAGE_COLUMNS = [
  "conversation_id",
  "message_id",
  "room_name",
  "request_id",
  "user_id",
  "user_name",
  "sent_time",
  "text_kind",
  "plain_text",
  "decrypt_status",
] as const;
const REQUIRED_ATTACHMENT_COLUMNS = [
  "conversation_id",
  "message_id",
  "block_index",
  "block_type",
  "file_name",
  "mime_type",
  "nas_path",
] as const;

type PeriodWindow = {
  kind: KakaoworkPeriod;
  timezone: "Asia/Seoul";
  start_epoch: number;
  end_epoch: number;
  start_iso: string;
  end_iso: string;
};

type SourceMessage = {
  conversationId: string;
  messageId: string;
  roomName: string;
  requestId: string | null;
  userId: string | null;
  userName: string | null;
  sentTime: number;
  textKind: string;
  plainText: string;
  decryptStatus: string | null;
  textBytes: number;
  localDate: string;
  evidenceId: string;
};

type SourceAttachment = {
  conversationId: string;
  messageId: string;
  blockIndex: number;
  blockType: string | null;
  fileName: string | null;
  mimeType: string | null;
  reference: string | null;
  referenceSafe: boolean;
};

type Batch = {
  batchId: string;
  roomId: string;
  roomName: string;
  localDate: string;
  messages: SourceMessage[];
  textCharacters: number;
  textBytes: number;
  decryptFailureCount: number;
  coverageDigest: string;
};

type SnapshotPayload = {
  version: 1;
  period: PeriodWindow;
  databaseDigest: string;
  databaseModifiedAtEpoch: number;
  membershipDigest: string;
  batchMessageLimit: number;
  batchByteLimit: number;
  pageMessageLimit: number;
};

type CursorPayload = {
  version: 1;
  snapshotDigest: string;
  batchId: string;
  offset: number;
};

export type BatchCoverage = {
  batchId: string;
  coverageDigest: string;
};

type PackageData = {
  membershipDigest: string;
  databaseDigest: string;
  databaseModifiedAtEpoch: number;
  membershipRoomCount: number;
  messages: SourceMessage[];
  attachments: SourceAttachment[];
  maximumSourceSentTime: number | null;
};

export type KakaoworkPeriodRecordsOptions = {
  packageDir: string;
  nowMs?: () => number;
  snapshotSecret?: Uint8Array;
  batchMessageLimit?: number;
  batchByteLimit?: number;
  pageMessageLimit?: number;
};

export type ManifestRequest = {
  operation: "manifest";
  period: KakaoworkPeriod;
};

export type ReadBatchRequest = {
  operation: "read_batch";
  snapshotToken: string;
  batchId: string;
  cursor?: string;
};

export type ReconcileRequest = {
  operation: "reconcile";
  snapshotToken: string;
  coverage: BatchCoverage[];
};

export type KakaoworkPeriodRecordsRequest = ManifestRequest | ReadBatchRequest | ReconcileRequest;

class PackageContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function prefixedSha256(value: string | Uint8Array): string {
  return `sha256:${sha256(value)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestFile(pathname: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(256 * 1024);
  const fd = openSync(pathname, "r");
  try {
    for (;;) {
      const size = readSync(fd, buffer, 0, buffer.length, null);
      if (size === 0) {
        break;
      }
      hash.update(buffer.subarray(0, size));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function utf8ByteCount(value: string | null): number {
  return value ? Buffer.byteLength(value, "utf8") : 0;
}

function unicodeCharacterCount(value: string | null): number {
  return value ? [...value].length : 0;
}

function stableEvidenceId(conversationId: string, messageId: string): string {
  return prefixedSha256(canonicalJson([conversationId, messageId]));
}

function toSeoulIso(epochSeconds: number): string {
  const shifted = new Date((epochSeconds + SEOUL_OFFSET_SECONDS) * 1000)
    .toISOString()
    .replace("Z", "+09:00");
  return shifted;
}

function seoulDate(epochSeconds: number): string {
  return new Date((epochSeconds + SEOUL_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
}

export function resolveKakaoworkPeriod(kind: KakaoworkPeriod, nowMs: number): PeriodWindow {
  const nowSeconds = Math.floor(nowMs / 1000);
  let startEpoch: number;
  let endEpoch: number;
  if (kind === "rolling_7d") {
    startEpoch = nowSeconds - 7 * DAY_SECONDS;
    endEpoch = nowSeconds;
  } else {
    const localNow = new Date((nowSeconds + SEOUL_OFFSET_SECONDS) * 1000);
    const dayFromMonday = (localNow.getUTCDay() + 6) % 7;
    const localMondaySeconds =
      Date.UTC(
        localNow.getUTCFullYear(),
        localNow.getUTCMonth(),
        localNow.getUTCDate() - dayFromMonday,
      ) / 1000;
    endEpoch = localMondaySeconds - SEOUL_OFFSET_SECONDS;
    startEpoch = endEpoch - 7 * DAY_SECONDS;
  }
  return {
    kind,
    timezone: "Asia/Seoul",
    start_epoch: startEpoch,
    end_epoch: endEpoch,
    start_iso: toSeoulIso(startEpoch),
    end_iso: toSeoulIso(endEpoch),
  };
}

function requirePlainObject(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageContractError(code, code);
  }
  return value as Record<string, unknown>;
}

function readMembership(pathname: string): { digest: string; rooms: Set<string> } {
  const bytes = readFileSync(pathname);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PackageContractError("membership_invalid", "membership_invalid");
  }
  const data = requirePlainObject(parsed, "membership_invalid");
  if (!Array.isArray(data.conversation_ids)) {
    throw new PackageContractError("membership_invalid", "membership_invalid");
  }
  const rooms = new Set<string>();
  for (const candidate of data.conversation_ids) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new PackageContractError("membership_invalid", "membership_invalid");
    }
    if (rooms.has(candidate)) {
      throw new PackageContractError("membership_invalid", "membership_invalid");
    }
    rooms.add(candidate);
  }
  return { digest: sha256(bytes), rooms };
}

function requireTableContract(
  db: DatabaseSync,
  table: string,
  required: readonly string[],
  primaryKey: readonly string[],
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
  const columns = new Set(rows.map((row) => String(row.name)));
  const actualPrimaryKey = rows
    .filter((row) => Number(row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((row) => String(row.name));
  if (
    columns.size === 0 ||
    required.some((column) => !columns.has(column)) ||
    canonicalJson(actualPrimaryKey) !== canonicalJson(primaryKey)
  ) {
    throw new PackageContractError("schema_invalid", "schema_invalid");
  }
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : value === null ? null : String(value);
}

function isSafeAttachmentReference(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function decryptFailed(message: SourceMessage): boolean {
  return !["ok", "success", "plain", "plaintext"].includes(
    (message.decryptStatus ?? "").trim().toLowerCase(),
  );
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function loadDatabase(
  databasePath: string,
  allowedRooms: Set<string>,
  window: PeriodWindow,
): Pick<PackageData, "messages" | "attachments" | "maximumSourceSentTime"> {
  const { DatabaseSync } = requireNodeSqlite();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    db.exec("PRAGMA query_only=ON");
    const check = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    if (!check || Object.values(check)[0] !== "ok") {
      throw new PackageContractError("database_corrupt", "database_corrupt");
    }
    requireTableContract(db, "messages", REQUIRED_MESSAGE_COLUMNS, [
      "conversation_id",
      "message_id",
    ]);
    requireTableContract(db, "attachments", REQUIRED_ATTACHMENT_COLUMNS, [
      "conversation_id",
      "message_id",
      "block_index",
    ]);

    const authorizedRooms = [...allowedRooms].sort();
    const allRows: Record<string, unknown>[] = [];
    for (const roomChunk of chunks(authorizedRooms, 900)) {
      const placeholders = roomChunk.map(() => "?").join(",");
      allRows.push(
        ...(db
          .prepare(
            "SELECT conversation_id, message_id, room_name, request_id, user_id, user_name, " +
              "sent_time, text_kind, plain_text, decrypt_status FROM messages " +
              `WHERE conversation_id IN (${placeholders}) AND sent_time >= ? AND sent_time < ?`,
          )
          .all(...roomChunk, window.start_epoch, window.end_epoch) as Record<string, unknown>[]),
      );
    }
    allRows.sort(
      (left, right) =>
        String(left.conversation_id).localeCompare(String(right.conversation_id)) ||
        Number(left.sent_time) - Number(right.sent_time) ||
        String(left.message_id).localeCompare(String(right.message_id)),
    );
    const messages = allRows.map((row): SourceMessage => {
      const conversationId = String(row.conversation_id);
      const messageId = String(row.message_id);
      const sentTime = Number(row.sent_time);
      if (!Number.isSafeInteger(sentTime) || !messageId) {
        throw new PackageContractError("schema_invalid", "schema_invalid");
      }
      const plainText = asNullableString(row.plain_text) ?? "";
      return {
        conversationId,
        messageId,
        roomName: asNullableString(row.room_name) ?? conversationId,
        requestId: asNullableString(row.request_id),
        userId: asNullableString(row.user_id),
        userName: asNullableString(row.user_name),
        sentTime,
        textKind: asNullableString(row.text_kind) ?? "",
        plainText,
        decryptStatus: asNullableString(row.decrypt_status),
        textBytes: utf8ByteCount(plainText),
        localDate: seoulDate(sentTime),
        evidenceId: stableEvidenceId(conversationId, messageId),
      };
    });

    const messageKeys = new Set(messages.map((message) => message.evidenceId));
    const attachmentRows: Record<string, unknown>[] = [];
    for (const roomChunk of chunks(authorizedRooms, 900)) {
      const placeholders = roomChunk.map(() => "?").join(",");
      attachmentRows.push(
        ...(db
          .prepare(
            "SELECT a.conversation_id, a.message_id, a.block_index, a.block_type, a.file_name, " +
              "a.mime_type, a.nas_path FROM attachments a JOIN messages m " +
              "ON m.conversation_id = a.conversation_id AND m.message_id = a.message_id " +
              `WHERE m.conversation_id IN (${placeholders}) AND m.sent_time >= ? AND m.sent_time < ? ` +
              "ORDER BY a.conversation_id, a.message_id, a.block_index",
          )
          .all(...roomChunk, window.start_epoch, window.end_epoch) as Record<string, unknown>[]),
      );
    }
    const attachments = attachmentRows
      .filter((row) => {
        const evidenceId = stableEvidenceId(String(row.conversation_id), String(row.message_id));
        return messageKeys.has(evidenceId);
      })
      .map((row): SourceAttachment => {
        const conversationId = String(row.conversation_id);
        const messageId = String(row.message_id);
        const blockIndex = Number(row.block_index);
        const rawReference = asNullableString(row.nas_path);
        if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) {
          throw new PackageContractError("schema_invalid", "schema_invalid");
        }
        const referenceSafe = rawReference !== null && isSafeAttachmentReference(rawReference);
        return {
          conversationId,
          messageId,
          blockIndex,
          blockType: asNullableString(row.block_type),
          fileName: asNullableString(row.file_name),
          mimeType: asNullableString(row.mime_type),
          reference: referenceSafe ? rawReference : null,
          referenceSafe,
        };
      });

    let maximumSourceSentTime: number | undefined;
    for (const roomChunk of chunks(authorizedRooms, 900)) {
      const placeholders = roomChunk.map(() => "?").join(",");
      const row = db
        .prepare(
          `SELECT MAX(sent_time) AS maximum FROM messages WHERE conversation_id IN (${placeholders})`,
        )
        .get(...roomChunk) as Record<string, unknown> | undefined;
      if (row?.maximum === null || row?.maximum === undefined) {
        continue;
      }
      const candidate = Number(row.maximum);
      if (
        Number.isSafeInteger(candidate) &&
        (maximumSourceSentTime === undefined || candidate > maximumSourceSentTime)
      ) {
        maximumSourceSentTime = candidate;
      }
    }
    return {
      messages,
      attachments,
      maximumSourceSentTime: maximumSourceSentTime ?? null,
    };
  } catch (error) {
    if (error instanceof PackageContractError) {
      throw error;
    }
    throw new PackageContractError("database_corrupt", "database_corrupt");
  } finally {
    db?.close();
  }
}

function ensureRegularFile(pathname: string, missingCode: string): void {
  let stat;
  try {
    stat = lstatSync(pathname);
  } catch {
    throw new PackageContractError(missingCode, missingCode);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new PackageContractError(missingCode, missingCode);
  }
}

function loadPackage(packageDir: string, window: PeriodWindow): PackageData {
  let packageStat;
  try {
    packageStat = lstatSync(packageDir);
  } catch {
    throw new PackageContractError("package_missing", "package_missing");
  }
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) {
    throw new PackageContractError("package_invalid", "package_invalid");
  }
  const membershipPath = `${packageDir}/membership.json`;
  const databasePath = `${packageDir}/messages.sqlite`;
  ensureRegularFile(membershipPath, "membership_missing");
  ensureRegularFile(databasePath, "database_missing");
  const membership = readMembership(membershipPath);
  const databaseDigest = digestFile(databasePath);
  const databaseModifiedAtEpoch = Math.floor(statSync(databasePath).mtimeMs / 1000);
  const loaded = loadDatabase(databasePath, membership.rooms, window);
  const databaseDigestAfterRead = digestFile(databasePath);
  const membershipDigestAfterRead = digestFile(membershipPath);
  if (
    databaseDigest !== databaseDigestAfterRead ||
    membership.digest !== membershipDigestAfterRead
  ) {
    throw new PackageContractError("snapshot_changed", "snapshot_changed");
  }
  return {
    membershipDigest: membership.digest,
    databaseDigest,
    databaseModifiedAtEpoch,
    membershipRoomCount: membership.rooms.size,
    ...loaded,
  };
}

function createBatches(
  data: PackageData,
  batchMessageLimit: number,
  batchByteLimit: number,
): Batch[] {
  const batches: Batch[] = [];
  let current: SourceMessage[] = [];
  let currentKey = "";
  let currentBytes = 0;
  let segment = 1;

  const flush = () => {
    const first = current[0];
    if (!first) {
      return;
    }
    const messageIds = current.map((message) => message.evidenceId);
    const identity = {
      conversation_id: first.conversationId,
      local_date: first.localDate,
      piece: segment,
      first: messageIds[0],
      last: messageIds.at(-1),
      count: messageIds.length,
    };
    const suffix = sha256(canonicalJson(identity)).slice(0, 16);
    const batchId = `batch-${String(batches.length + 1).padStart(4, "0")}-${suffix}`;
    batches.push({
      batchId,
      roomId: first.conversationId,
      roomName: first.roomName,
      localDate: first.localDate,
      messages: current,
      textCharacters: current.reduce(
        (total, message) => total + unicodeCharacterCount(message.plainText),
        0,
      ),
      textBytes: currentBytes,
      decryptFailureCount: current.filter(decryptFailed).length,
      coverageDigest: prefixedSha256(canonicalJson(messageIds)),
    });
    current = [];
    currentBytes = 0;
  };

  for (const message of data.messages) {
    const key = `${message.conversationId}\0${message.localDate}`;
    if (key !== currentKey) {
      flush();
      currentKey = key;
      segment = 1;
    }
    const wouldExceedCount = current.length >= batchMessageLimit;
    const wouldExceedBytes =
      current.length > 0 && currentBytes + message.textBytes > batchByteLimit;
    if (wouldExceedCount || wouldExceedBytes) {
      flush();
      segment += 1;
    }
    current.push(message);
    currentBytes += message.textBytes;
  }
  flush();
  return batches;
}

function countBatchPages(batch: Batch, messageLimit: number): number {
  return Math.ceil(batch.messages.length / messageLimit);
}

function encodeSigned(payload: unknown, secret: Uint8Array): string {
  const body = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function decodeSigned<T>(token: string, secret: Uint8Array, code: string): T {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) {
    throw new PackageContractError(code, code);
  }
  const expected = createHmac("sha256", secret).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    throw new PackageContractError(code, code);
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new PackageContractError(code, code);
  }
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    throw new PackageContractError(code, code);
  }
}

function snapshotDigest(payload: SnapshotPayload): string {
  return sha256(canonicalJson(payload));
}

function freshness(data: PackageData, period: PeriodWindow) {
  const latest = data.maximumSourceSentTime;
  const effectiveEpoch = Math.max(latest ?? 0, data.databaseModifiedAtEpoch);
  const toleranceSeconds = 48 * 60 * 60;
  const lag = Math.max(0, period.end_epoch - effectiveEpoch);
  const stale = lag > toleranceSeconds;
  return {
    status: stale ? "stale" : "fresh",
    stale,
    tolerance_seconds: toleranceSeconds,
    latest_observed_at: effectiveEpoch,
    lag_to_period_end_seconds: lag,
    activity_lag_to_period_end_seconds:
      latest === null ? null : Math.max(0, period.end_epoch - latest),
    database_lag_to_period_end_seconds: Math.max(
      0,
      period.end_epoch - data.databaseModifiedAtEpoch,
    ),
    max_source_sent_at: latest,
    database_modified_at: data.databaseModifiedAtEpoch,
  };
}

function periodResult(period: PeriodWindow) {
  return {
    preset: period.kind,
    start: period.start_epoch,
    end: period.end_epoch,
    timezone: period.timezone,
    end_exclusive: true,
  };
}

function unavailable(operation: string, error: unknown) {
  const code = error instanceof PackageContractError ? error.code : "package_unavailable";
  return {
    schema_version: "jitech-kakaowork-period-records-v1",
    operation,
    status: [
      "package_missing",
      "package_invalid",
      "membership_missing",
      "membership_invalid",
      "database_missing",
      "database_unavailable",
      "database_corrupt",
      "schema_invalid",
    ].includes(code)
      ? "unavailable"
      : "error",
    complete: false,
    error: { code, message: code },
    connection: {
      status: "unavailable",
      read_only: true,
      diagnostic: code,
    },
  };
}

export class KakaoworkPeriodRecords {
  readonly #packageDir: string;
  readonly #nowMs: () => number;
  readonly #secret: Uint8Array;
  readonly #batchMessageLimit: number;
  readonly #batchByteLimit: number;
  readonly #pageMessageLimit: number;

  constructor(options: KakaoworkPeriodRecordsOptions) {
    this.#packageDir = options.packageDir;
    this.#nowMs = options.nowMs ?? Date.now;
    this.#secret = options.snapshotSecret ?? randomBytes(32);
    this.#batchMessageLimit = options.batchMessageLimit ?? 200;
    this.#batchByteLimit = options.batchByteLimit ?? 32_768;
    this.#pageMessageLimit = options.pageMessageLimit ?? 50;
  }

  execute(request: KakaoworkPeriodRecordsRequest): Record<string, unknown> {
    try {
      if (request.operation === "manifest") {
        return this.#manifest(request.period);
      }
      if (request.operation === "read_batch") {
        return this.#readBatch(request.snapshotToken, request.batchId, request.cursor);
      }
      return this.#reconcile(request.snapshotToken, request.coverage);
    } catch (error) {
      return unavailable(request.operation, error);
    }
  }

  #manifest(kind: KakaoworkPeriod): Record<string, unknown> {
    const period = resolveKakaoworkPeriod(kind, this.#nowMs());
    let data: PackageData | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        data = loadPackage(this.#packageDir, period);
        break;
      } catch (error) {
        lastError = error;
        if (!(error instanceof PackageContractError) || error.code !== "snapshot_changed") {
          throw error;
        }
      }
    }
    if (!data) {
      throw lastError;
    }
    const batches = createBatches(data, this.#batchMessageLimit, this.#batchByteLimit);
    const payload: SnapshotPayload = {
      version: 1,
      period,
      databaseDigest: data.databaseDigest,
      databaseModifiedAtEpoch: data.databaseModifiedAtEpoch,
      membershipDigest: data.membershipDigest,
      batchMessageLimit: this.#batchMessageLimit,
      batchByteLimit: this.#batchByteLimit,
      pageMessageLimit: this.#pageMessageLimit,
    };
    const snapshotToken = encodeSigned(payload, this.#secret);
    const decryptFailureCount = data.messages.filter(decryptFailed).length;
    const textCharacters = data.messages.reduce(
      (total, message) => total + unicodeCharacterCount(message.plainText),
      0,
    );
    const textBytes = data.messages.reduce((total, message) => total + message.textBytes, 0);
    const unsafeAttachmentCount = data.attachments.filter(
      (attachment) => !attachment.referenceSafe,
    ).length;
    return {
      schema_version: "jitech-kakaowork-period-records-v1",
      operation: "manifest",
      status: "ready",
      period: periodResult(period),
      connection: {
        status: "connected",
        read_only: true,
        membership_room_count: data.membershipRoomCount,
        database_digest: data.databaseDigest,
        membership_digest: data.membershipDigest,
      },
      freshness: freshness(data, period),
      totals: {
        rooms: new Set(data.messages.map((message) => message.conversationId)).size,
        messages: data.messages.length,
        attachments: data.attachments.length,
        text_characters: textCharacters,
        text_utf8_bytes: textBytes,
        decrypt_failures: decryptFailureCount,
        unsafe_attachment_references: unsafeAttachmentCount,
      },
      batch_limits: {
        messages: this.#batchMessageLimit,
        text_utf8_bytes: this.#batchByteLimit,
        page_messages: this.#pageMessageLimit,
      },
      batches: batches.map((batch) => ({
        batch_id: batch.batchId,
        conversation_id: batch.roomId,
        room_name: batch.roomName,
        local_date: batch.localDate,
        message_count: batch.messages.length,
        text_characters: batch.textCharacters,
        text_utf8_bytes: batch.textBytes,
        page_count: countBatchPages(batch, this.#pageMessageLimit),
        decrypt_failures: batch.decryptFailureCount,
      })),
      snapshot_token: snapshotToken,
    };
  }

  #loadSnapshot(token: string): {
    payload: SnapshotPayload;
    data: PackageData;
    batches: Batch[];
  } {
    const payload = decodeSigned<SnapshotPayload>(token, this.#secret, "invalid_token");
    if (
      payload.version !== 1 ||
      !KAKAOWORK_PERIODS.includes(payload.period?.kind) ||
      payload.period.timezone !== "Asia/Seoul"
    ) {
      throw new PackageContractError("invalid_token", "invalid_token");
    }
    let data: PackageData;
    try {
      data = loadPackage(this.#packageDir, payload.period);
    } catch (error) {
      if (error instanceof PackageContractError && error.code === "snapshot_changed") {
        throw new PackageContractError("snapshot_mismatch", "snapshot_mismatch");
      }
      throw error;
    }
    if (
      data.databaseDigest !== payload.databaseDigest ||
      data.databaseModifiedAtEpoch !== payload.databaseModifiedAtEpoch ||
      data.membershipDigest !== payload.membershipDigest
    ) {
      throw new PackageContractError("snapshot_mismatch", "snapshot_mismatch");
    }
    return {
      payload,
      data,
      batches: createBatches(data, payload.batchMessageLimit, payload.batchByteLimit),
    };
  }

  #readBatch(token: string, batchId: string, cursor?: string): Record<string, unknown> {
    const snapshot = this.#loadSnapshot(token);
    const batch = snapshot.batches.find((candidate) => candidate.batchId === batchId);
    if (!batch) {
      throw new PackageContractError("invalid_batch", "invalid_batch");
    }
    let offset = 0;
    if (cursor !== undefined) {
      const cursorPayload = decodeSigned<CursorPayload>(cursor, this.#secret, "invalid_cursor");
      if (
        cursorPayload.version !== 1 ||
        cursorPayload.snapshotDigest !== snapshotDigest(snapshot.payload) ||
        cursorPayload.batchId !== batchId ||
        !Number.isSafeInteger(cursorPayload.offset) ||
        cursorPayload.offset <= 0
      ) {
        throw new PackageContractError("invalid_cursor", "invalid_cursor");
      }
      offset = cursorPayload.offset;
    }
    if (offset >= batch.messages.length) {
      throw new PackageContractError("invalid_cursor", "invalid_cursor");
    }
    const page = batch.messages.slice(offset, offset + snapshot.payload.pageMessageLimit);
    const nextOffset = offset + page.length;
    const nextCursor =
      nextOffset < batch.messages.length
        ? encodeSigned(
            {
              version: 1,
              snapshotDigest: snapshotDigest(snapshot.payload),
              batchId,
              offset: nextOffset,
            } satisfies CursorPayload,
            this.#secret,
          )
        : null;
    const attachmentsByMessage = new Map<string, SourceAttachment[]>();
    for (const attachment of snapshot.data.attachments) {
      const key = stableEvidenceId(attachment.conversationId, attachment.messageId);
      const current = attachmentsByMessage.get(key) ?? [];
      current.push(attachment);
      attachmentsByMessage.set(key, current);
    }
    const result: Record<string, unknown> = {
      schema_version: "jitech-kakaowork-period-records-v1",
      operation: "read_batch",
      status: "ready",
      batch_id: batchId,
      cursor: cursor ?? null,
      next_cursor: nextCursor,
      returned_count: page.length,
      batch_total_count: batch.messages.length,
      records: page.map((message) => ({
        conversation_id: message.conversationId,
        message_id: message.messageId,
        stable_message_id: message.evidenceId,
        room_name: message.roomName,
        request_id: message.requestId,
        sender: { user_id: message.userId, user_name: message.userName },
        sent_time: message.sentTime,
        local_time: toSeoulIso(message.sentTime),
        text_kind: message.textKind,
        plain_text: message.plainText,
        decrypt_status: message.decryptStatus,
        attachments: (attachmentsByMessage.get(message.evidenceId) ?? []).map((attachment) => ({
          block_index: attachment.blockIndex,
          block_type: attachment.blockType,
          file_name: attachment.fileName,
          mime_type: attachment.mimeType,
          reference_status: attachment.referenceSafe ? "available" : "invalid",
          ...(attachment.referenceSafe && attachment.reference !== null
            ? { nas_reference: attachment.reference }
            : {}),
        })),
      })),
    };
    if (nextCursor === null) {
      result.batch_coverage_digest = batch.coverageDigest;
    }
    return result;
  }

  #reconcile(token: string, coverage: BatchCoverage[]): Record<string, unknown> {
    const snapshot = this.#loadSnapshot(token);
    const expected = new Map(snapshot.batches.map((batch) => [batch.batchId, batch]));
    const counts = new Map<string, number>();
    for (const item of coverage) {
      counts.set(item.batchId, (counts.get(item.batchId) ?? 0) + 1);
    }
    const duplicateBatchIds = [...counts]
      .filter(([, count]) => count > 1)
      .map(([batchId]) => batchId)
      .sort();
    const unknownBatchIds = [...counts.keys()].filter((batchId) => !expected.has(batchId)).sort();
    const supplied = new Map(
      coverage
        .filter((item) => expected.has(item.batchId))
        .map((item) => [item.batchId, item.coverageDigest]),
    );
    const missingBatchIds = [...expected.keys()].filter((batchId) => !supplied.has(batchId)).sort();
    const digestMismatchBatchIds = [...supplied]
      .filter(([batchId, digest]) => expected.get(batchId)?.coverageDigest !== digest)
      .map(([batchId]) => batchId)
      .sort();
    const validBatchIds = new Set(
      [...supplied]
        .filter(
          ([batchId, digest]) =>
            counts.get(batchId) === 1 && expected.get(batchId)?.coverageDigest === digest,
        )
        .map(([batchId]) => batchId),
    );
    const coveredMessages = [...validBatchIds].reduce(
      (total, batchId) => total + expected.get(batchId)!.messages.length,
      0,
    );
    const failedMessages = [...validBatchIds].reduce(
      (total, batchId) => total + expected.get(batchId)!.decryptFailureCount,
      0,
    );
    const processedMessages = coveredMessages - failedMessages;
    const uncoveredMessages = snapshot.data.messages.length - coveredMessages;
    const unsafeAttachmentReferences = snapshot.data.attachments.filter(
      (attachment) => !attachment.referenceSafe,
    ).length;
    const sourceDecryptFailures = snapshot.data.messages.filter(decryptFailed).length;
    const snapshotFreshness = freshness(snapshot.data, snapshot.payload.period);
    const complete =
      duplicateBatchIds.length === 0 &&
      unknownBatchIds.length === 0 &&
      missingBatchIds.length === 0 &&
      digestMismatchBatchIds.length === 0 &&
      uncoveredMessages === 0 &&
      failedMessages === 0 &&
      unsafeAttachmentReferences === 0 &&
      !snapshotFreshness.stale;
    return {
      schema_version: "jitech-kakaowork-period-records-v1",
      operation: "reconcile",
      status: complete ? "complete" : "incomplete",
      complete,
      period: periodResult(snapshot.payload.period),
      freshness: snapshotFreshness,
      source_total_messages: snapshot.data.messages.length,
      covered_messages: coveredMessages,
      processed_messages: processedMessages,
      failed_messages: failedMessages,
      uncovered_messages: uncoveredMessages,
      source_total_attachments: snapshot.data.attachments.length,
      unsafe_attachment_references: unsafeAttachmentReferences,
      source_decrypt_failures: sourceDecryptFailures,
      missing_batch_ids: missingBatchIds,
      duplicate_batch_ids: duplicateBatchIds,
      unknown_batch_ids: unknownBatchIds,
      digest_mismatch_batch_ids: digestMismatchBatchIds,
    };
  }
}

export function defaultKakaoworkPackageDir(): string {
  return process.env.JITECH_KAKAOWORK_PACKAGE_DIR ?? "/home/node/nas_docs/kw/package";
}
