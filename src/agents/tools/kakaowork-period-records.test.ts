import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkillsFromDirSafe } from "../skills/local-loader.js";
import { createKakaoworkPeriodRecordsTool } from "./kakaowork-period-records-tool.js";
import { KakaoworkPeriodRecords, resolveKakaoworkPeriod } from "./kakaowork-period-records.js";

const NOW_MS = Date.parse("2026-08-20T12:00:00.000Z");
const PARITY_NOW_MS = Date.parse("2026-08-20T03:00:00.000Z");
const PACKAGE_UPDATED_AT = "2026-08-20T11:55:00+00:00";
const PARITY_BATCH_IDS = [
  "batch-0001-cfa9dd7d41697ad2",
  "batch-0002-17475dfc0a4d9a62",
  "batch-0003-4ce32e9fb856128a",
  "batch-0004-3cb2dc222b83dc1a",
  "batch-0005-911d23943c2fefec",
  "batch-0006-aae62f8e5ae119ba",
];
const PARITY_COVERAGE_DIGESTS = [
  "sha256:85f8deccbea3013193ea0429cbb0b04d177bb6e788009dece2a8cf1c24f6956d",
  "sha256:8d2472f588961ba8b988c630f6255205537a509e716844df936f995d0f756d09",
  "sha256:c0299b81ee97956d2b2f5d49af7a6f0a367764dc5f004c86b5bd92af533e7f00",
  "sha256:8edc19cb79670da5e7495e26ab86b06405fede6195309347081019e53443e7bb",
  "sha256:d9ea92ddf65c9c964ca042925a3af362b860d3530b406c0a99da70f9ef06d53f",
  "sha256:2491084d35cfab52af6f2357ebb142c4afb9d1e3a2e931d8cd583e89bf2ab8d1",
];
const PARITY_FIRST_STABLE_ID =
  "sha256:5d5e8cd6cc6224b143fa03ae5c8aaa332e022e32486f181569c41cd8ef223598";
const MESSAGE_DDL = `
CREATE TABLE messages (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  room_name TEXT,
  request_id TEXT,
  user_id TEXT,
  user_name TEXT,
  sent_time INTEGER,
  text_kind TEXT NOT NULL,
  plain_text TEXT,
  decrypt_status TEXT,
  PRIMARY KEY (conversation_id, message_id)
);
CREATE TABLE attachments (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  block_type TEXT,
  file_name TEXT,
  mime_type TEXT,
  nas_path TEXT,
  PRIMARY KEY (conversation_id, message_id, block_index)
);`;

const temporaryRoots: string[] = [];

type FixtureOptions = {
  messageCount?: number;
  oldMessages?: boolean;
  includeOutsideRoom?: boolean;
  decryptFailureAt?: number;
  databaseModifiedAt?: string;
  unsafeAttachment?: boolean;
};

function fixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-kakao-period-"));
  temporaryRoots.push(root);
  const packageDir = join(root, "package");
  mkdirSync(packageDir);
  writeFileSync(
    join(packageDir, "membership.json"),
    JSON.stringify({
      schema: "kw-user/1",
      user_id: "customer-1",
      conversation_ids: ["room-a", "room-b"],
      updated_at: PACKAGE_UPDATED_AT,
    }),
  );
  const databasePath = join(packageDir, "messages.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(MESSAGE_DDL);
  const insert = db.prepare(
    "INSERT INTO messages (conversation_id, message_id, room_name, request_id, user_id, " +
      "user_name, sent_time, text_kind, plain_text, decrypt_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const messageCount = options.messageCount ?? 1_001;
  const start = options.oldMessages
    ? Math.floor(Date.parse("2026-07-10T00:00:00.000Z") / 1000)
    : Math.floor(Date.parse("2026-08-18T00:00:00.000Z") / 1000);
  for (let index = 0; index < messageCount; index += 1) {
    insert.run(
      "room-a",
      `m-${String(index).padStart(4, "0")}`,
      "영업방",
      `request-${index}`,
      `u-${index % 3}`,
      `사용자 ${index % 3}`,
      start + index,
      "text",
      `메시지 ${index} 😀`,
      options.decryptFailureAt === index ? "no_key" : "ok",
    );
  }
  if (options.includeOutsideRoom) {
    insert.run(
      "outside-room",
      "secret-message",
      "권한밖",
      "secret-request",
      "secret-user",
      "외부인",
      start + 10,
      "text",
      "노출되면 안 됨",
      "ok",
    );
  }
  if (messageCount > 0) {
    db.prepare(
      "INSERT INTO attachments (conversation_id, message_id, block_index, block_type, " +
        "file_name, mime_type, nas_path) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "room-a",
      "m-0000",
      0,
      "file",
      "report.pdf",
      "application/pdf",
      options.unsafeAttachment ? "../../secret" : "media/room-a/report.pdf",
    );
  }
  db.close();
  const databaseModifiedAt = new Date(options.databaseModifiedAt ?? "2026-08-20T11:50:00.000Z");
  utimesSync(databasePath, databaseModifiedAt, databaseModifiedAt);
  return { packageDir, databasePath };
}

function createRecords(packageDir: string) {
  return new KakaoworkPeriodRecords({
    packageDir,
    nowMs: () => NOW_MS,
    snapshotSecret: Buffer.alloc(32, 7),
    batchMessageLimit: 200,
    batchByteLimit: 32_768,
    pageMessageLimit: 50,
  });
}

function parityFixture() {
  const root = mkdtempSync(join(tmpdir(), "openclaw-kakao-parity-"));
  temporaryRoots.push(root);
  const packageDir = join(root, "package");
  mkdirSync(packageDir);
  writeFileSync(
    join(packageDir, "membership.json"),
    JSON.stringify({
      schema: "kw-user-membership/1",
      user_id: "7519030",
      conversation_ids: ["room-a"],
    }),
  );
  const databasePath = join(packageDir, "messages.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(MESSAGE_DDL);
  const insert = db.prepare(
    "INSERT INTO messages (conversation_id, message_id, room_name, request_id, user_id, " +
      "user_name, sent_time, text_kind, plain_text, decrypt_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const end = Math.floor(PARITY_NOW_MS / 1000);
  for (let index = 0; index < 1_001; index += 1) {
    insert.run(
      "room-a",
      `message-${String(index).padStart(4, "0")}`,
      "대용량방",
      `request-${index}`,
      "sender-1",
      "발신자",
      end - 10_000 + index,
      "text",
      "가",
      "ok",
    );
  }
  db.prepare(
    "INSERT INTO attachments (conversation_id, message_id, block_index, block_type, " +
      "file_name, mime_type, nas_path) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "room-a",
    "message-0000",
    0,
    "file",
    "evidence.pdf",
    "application/pdf",
    "attachments/room-a/message-0000/evidence.pdf",
  );
  db.close();
  const fresh = new Date(PARITY_NOW_MS - 60_000);
  utimesSync(databasePath, fresh, fresh);
  return packageDir;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error("expected array");
  }
  return value.map(record);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("expected string");
  }
  return value;
}

function evidenceId(conversationId: string, messageId: string): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([conversationId, messageId]))
    .digest("hex")}`;
}

function readAll(records: KakaoworkPeriodRecords, manifest: Record<string, unknown>) {
  const snapshotToken = requiredString(manifest.snapshot_token);
  const coverage: Array<{ batchId: string; coverageDigest: string }> = [];
  const returnedRecords: Record<string, unknown>[] = [];
  for (const batch of array(manifest.batches)) {
    const batchId = requiredString(batch.batch_id);
    let cursor: string | undefined;
    for (;;) {
      const result = records.execute({
        operation: "read_batch",
        snapshotToken,
        batchId,
        cursor,
      });
      expect(result.status).toBe("ready");
      expect(result.batch_id).toBe(batchId);
      expect(result.returned_count).toBeLessThanOrEqual(50);
      returnedRecords.push(...array(result.records));
      if (result.next_cursor === null) {
        coverage.push({
          batchId,
          coverageDigest: requiredString(result.batch_coverage_digest),
        });
        break;
      }
      expect(result).not.toHaveProperty("batch_coverage_digest");
      cursor = requiredString(result.next_cursor);
      expect(cursor).not.toMatch(/^\d+$/u);
    }
  }
  return { snapshotToken, coverage, returnedRecords };
}

afterEach(() => {
  delete process.env.JITECH_KWRAG_RUNTIME_PROFILE;
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("KakaoworkPeriodRecords", () => {
  it("matches the cross-product 1001-record parity vector", () => {
    const packageDir = parityFixture();
    const records = new KakaoworkPeriodRecords({
      packageDir,
      nowMs: () => PARITY_NOW_MS,
      snapshotSecret: Buffer.alloc(32, 7),
    });
    const manifest = records.execute({ operation: "manifest", period: "rolling_7d" });
    expect(manifest.totals).toEqual({
      rooms: 1,
      messages: 1_001,
      attachments: 1,
      text_characters: 1_001,
      text_utf8_bytes: 3_003,
      decrypt_failures: 0,
      unsafe_attachment_references: 0,
    });
    expect(array(manifest.batches).map((batch) => batch.batch_id)).toEqual(PARITY_BATCH_IDS);
    const { snapshotToken, coverage, returnedRecords } = readAll(records, manifest);
    expect(returnedRecords[0]?.stable_message_id).toBe(PARITY_FIRST_STABLE_ID);
    expect(coverage.map((item) => item.coverageDigest)).toEqual(PARITY_COVERAGE_DIGESTS);
    expect(records.execute({ operation: "reconcile", snapshotToken, coverage })).toMatchObject({
      complete: true,
      source_total_messages: 1_001,
      processed_messages: 1_001,
      failed_messages: 0,
      uncovered_messages: 0,
    });
  });

  it("resolves rolling and previous calendar week in Asia/Seoul", () => {
    expect(resolveKakaoworkPeriod("rolling_7d", NOW_MS)).toMatchObject({
      start_iso: "2026-08-13T21:00:00.000+09:00",
      end_iso: "2026-08-20T21:00:00.000+09:00",
    });
    expect(resolveKakaoworkPeriod("previous_calendar_week", NOW_MS)).toMatchObject({
      start_iso: "2026-08-10T00:00:00.000+09:00",
      end_iso: "2026-08-17T00:00:00.000+09:00",
    });
  });

  it("manifests 1001 authorized messages as deterministic multi-page batches", () => {
    const { packageDir } = fixture({ includeOutsideRoom: true });
    const records = createRecords(packageDir);
    const manifest = records.execute({ operation: "manifest", period: "rolling_7d" });

    expect(manifest.status).toBe("ready");
    expect(record(manifest.connection)).toMatchObject({
      status: "connected",
      read_only: true,
    });
    expect(record(manifest.totals)).toEqual({
      rooms: 1,
      messages: 1_001,
      attachments: 1,
      text_characters: 8_900,
      text_utf8_bytes: 17_909,
      decrypt_failures: 0,
      unsafe_attachment_references: 0,
    });
    expect(array(manifest.batches)).toHaveLength(6);
    expect(array(manifest.batches).map((batch) => batch.message_count)).toEqual([
      200, 200, 200, 200, 200, 1,
    ]);
    expect(requiredString(record(manifest.connection).database_digest)).toHaveLength(64);
    expect(requiredString(record(manifest.connection).membership_digest)).toHaveLength(64);
    expect(record(manifest.period)).toMatchObject({
      preset: "rolling_7d",
      timezone: "Asia/Seoul",
      end_exclusive: true,
    });
  });

  it("reads every page with stable evidence and reconciles exact completeness", () => {
    const { packageDir } = fixture();
    const records = createRecords(packageDir);
    const manifest = records.execute({ operation: "manifest", period: "rolling_7d" });
    const { snapshotToken, coverage, returnedRecords } = readAll(records, manifest);

    expect(returnedRecords).toHaveLength(1_001);
    expect(returnedRecords[0]).toMatchObject({
      stable_message_id: evidenceId("room-a", "m-0000"),
      conversation_id: "room-a",
      message_id: "m-0000",
      sender: { user_id: "u-0", user_name: "사용자 0" },
      local_time: "2026-08-18T09:00:00.000+09:00",
    });
    expect(array(returnedRecords[0]?.attachments)[0]).toEqual({
      block_index: 0,
      block_type: "file",
      file_name: "report.pdf",
      mime_type: "application/pdf",
      reference_status: "available",
      nas_reference: "media/room-a/report.pdf",
    });

    const reconciliation = records.execute({
      operation: "reconcile",
      snapshotToken,
      coverage,
    });
    expect(reconciliation).toMatchObject({
      status: "complete",
      complete: true,
      source_total_messages: 1_001,
      covered_messages: 1_001,
      processed_messages: 1_001,
      failed_messages: 0,
      uncovered_messages: 0,
      missing_batch_ids: [],
      duplicate_batch_ids: [],
      unknown_batch_ids: [],
      digest_mismatch_batch_ids: [],
    });
  });

  it("reports exact missing and duplicate coverage", () => {
    const { packageDir } = fixture({ messageCount: 205 });
    const records = createRecords(packageDir);
    const manifest = records.execute({ operation: "manifest", period: "rolling_7d" });
    const { snapshotToken, coverage } = readAll(records, manifest);

    const incomplete = records.execute({
      operation: "reconcile",
      snapshotToken,
      coverage: [coverage[0]!, coverage[0]!],
    });
    expect(incomplete).toMatchObject({
      status: "incomplete",
      complete: false,
      source_total_messages: 205,
      covered_messages: 0,
      processed_messages: 0,
      uncovered_messages: 205,
      duplicate_batch_ids: [coverage[0]!.batchId],
      missing_batch_ids: [requiredString(array(manifest.batches)[1]?.batch_id)],
    });
  });

  it("reports unknown and digest-mismatched batches without counting them as covered", () => {
    const { packageDir } = fixture({ messageCount: 205 });
    const records = createRecords(packageDir);
    const manifest = records.execute({ operation: "manifest", period: "rolling_7d" });
    const { snapshotToken, coverage } = readAll(records, manifest);
    const firstBatchId = coverage[0]!.batchId;
    const secondBatchId = coverage[1]!.batchId;

    const incomplete = records.execute({
      operation: "reconcile",
      snapshotToken,
      coverage: [
        { batchId: firstBatchId, coverageDigest: "sha256:wrong" },
        { batchId: "batch-unknown", coverageDigest: "sha256:unknown" },
        coverage[1]!,
      ],
    });
    expect(incomplete).toMatchObject({
      complete: false,
      covered_messages: 5,
      processed_messages: 5,
      uncovered_messages: 200,
      missing_batch_ids: [],
      duplicate_batch_ids: [],
      unknown_batch_ids: ["batch-unknown"],
      digest_mismatch_batch_ids: [firstBatchId],
    });
    expect(secondBatchId).not.toBe(firstBatchId);
  });

  it("binds opaque cursors to their snapshot and batch", () => {
    const { packageDir } = fixture({ messageCount: 205 });
    const records = createRecords(packageDir);
    const manifest = records.execute({ operation: "manifest", period: "rolling_7d" });
    const snapshotToken = requiredString(manifest.snapshot_token);
    const batches = array(manifest.batches);
    const first = records.execute({
      operation: "read_batch",
      snapshotToken,
      batchId: requiredString(batches[0]?.batch_id),
    });
    const cursor = requiredString(first.next_cursor);
    expect(cursor).not.toMatch(/^\d+$/u);
    expect(first).not.toHaveProperty("batch_coverage_digest");

    const wrongBatch = records.execute({
      operation: "read_batch",
      snapshotToken,
      batchId: requiredString(batches[1]?.batch_id),
      cursor,
    });
    expect(wrongBatch).toMatchObject({
      status: "error",
      complete: false,
      error: { code: "invalid_cursor" },
    });
  });

  it("never marks decrypt failures complete", () => {
    const { packageDir } = fixture({ messageCount: 3, decryptFailureAt: 1 });
    const records = createRecords(packageDir);
    const manifest = records.execute({ operation: "manifest", period: "rolling_7d" });
    const { snapshotToken, coverage } = readAll(records, manifest);
    const reconciliation = records.execute({
      operation: "reconcile",
      snapshotToken,
      coverage,
    });
    expect(reconciliation).toMatchObject({
      complete: false,
      source_decrypt_failures: 1,
      failed_messages: 1,
      processed_messages: 2,
    });
  });

  it("treats a freshly republished database as current even when activity is old", () => {
    const { packageDir } = fixture({ messageCount: 5, oldMessages: true });
    const records = createRecords(packageDir);
    const manifest = records.execute({ operation: "manifest", period: "rolling_7d" });
    expect(manifest.status).toBe("ready");
    expect(record(manifest.totals)).toMatchObject({ messages: 0 });
    expect(record(manifest.freshness)).toMatchObject({
      status: "fresh",
      max_source_sent_at: Math.floor(Date.parse("2026-07-10T00:00:04.000Z") / 1000),
      database_modified_at: Math.floor(Date.parse("2026-08-20T11:50:00.000Z") / 1000),
    });
  });

  it("reconciles a connected current package with zero source records as complete", () => {
    const { packageDir } = fixture({ messageCount: 0 });
    const records = createRecords(packageDir);
    const manifest = records.execute({ operation: "manifest", period: "rolling_7d" });
    expect(manifest).toMatchObject({ status: "ready" });
    expect(record(manifest.freshness)).toMatchObject({ status: "fresh" });
    expect(
      records.execute({
        operation: "reconcile",
        snapshotToken: requiredString(manifest.snapshot_token),
        coverage: [],
      }),
    ).toMatchObject({ complete: true, source_total_messages: 0 });
  });

  it("marks completeness false when both activity and database publication are stale", () => {
    const { packageDir } = fixture({
      messageCount: 5,
      oldMessages: true,
      databaseModifiedAt: "2026-07-10T00:10:00.000Z",
    });
    const records = createRecords(packageDir);
    const manifest = records.execute({ operation: "manifest", period: "rolling_7d" });
    expect(record(manifest.freshness)).toMatchObject({ status: "stale" });
    expect(
      records.execute({
        operation: "reconcile",
        snapshotToken: requiredString(manifest.snapshot_token),
        coverage: [],
      }),
    ).toMatchObject({ complete: false, freshness: { stale: true } });
  });

  it("withholds unsafe attachment paths and marks completeness false", () => {
    const { packageDir } = fixture({ messageCount: 1, unsafeAttachment: true });
    const records = createRecords(packageDir);
    const manifest = records.execute({ operation: "manifest", period: "rolling_7d" });
    expect(record(manifest.totals)).toMatchObject({ unsafe_attachment_references: 1 });
    const { snapshotToken, coverage, returnedRecords } = readAll(records, manifest);
    expect(array(returnedRecords[0]?.attachments)[0]).toMatchObject({
      reference_status: "invalid",
    });
    expect(array(returnedRecords[0]?.attachments)[0]).not.toHaveProperty("nas_reference");
    expect(records.execute({ operation: "reconcile", snapshotToken, coverage })).toMatchObject({
      complete: false,
      unsafe_attachment_references: 1,
    });
  });

  it("invalidates a snapshot when the package database changes", () => {
    const { packageDir, databasePath } = fixture({ messageCount: 2 });
    const records = createRecords(packageDir);
    const manifest = records.execute({ operation: "manifest", period: "rolling_7d" });
    const db = new DatabaseSync(databasePath);
    db.prepare(
      "INSERT INTO messages (conversation_id, message_id, sent_time, text_kind, decrypt_status) " +
        "VALUES (?, ?, ?, ?, ?)",
    ).run("room-a", "new-message", Math.floor(NOW_MS / 1000) - 1, "text", "ok");
    db.close();

    const result = records.execute({
      operation: "read_batch",
      snapshotToken: requiredString(manifest.snapshot_token),
      batchId: requiredString(array(manifest.batches)[0]?.batch_id),
    });
    expect(result).toMatchObject({
      status: "error",
      complete: false,
      error: { code: "snapshot_mismatch" },
    });
  });

  it("invalidates a snapshot when membership changes", () => {
    const { packageDir } = fixture({ messageCount: 2 });
    const records = createRecords(packageDir);
    const manifest = records.execute({ operation: "manifest", period: "rolling_7d" });
    writeFileSync(
      join(packageDir, "membership.json"),
      JSON.stringify({ conversation_ids: ["room-b"], updated_at: PACKAGE_UPDATED_AT }),
    );
    const result = records.execute({
      operation: "read_batch",
      snapshotToken: requiredString(manifest.snapshot_token),
      batchId: requiredString(array(manifest.batches)[0]?.batch_id),
    });
    expect(result).toMatchObject({ status: "error", error: { code: "snapshot_mismatch" } });
  });

  it.each([
    ["missing package", "package_missing"],
    ["missing database", "database_missing"],
  ])("returns a connection diagnostic for %s", (_label, reason) => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-kakao-missing-"));
    temporaryRoots.push(root);
    const packageDir = join(root, "package");
    if (reason === "database_missing") {
      mkdirSync(packageDir);
      writeFileSync(
        join(packageDir, "membership.json"),
        JSON.stringify({ conversation_ids: ["room-a"] }),
      );
    }
    const records = createRecords(packageDir);
    const result = records.execute({ operation: "manifest", period: "rolling_7d" });
    expect(result).toMatchObject({
      status: "unavailable",
      complete: false,
      error: { code: reason },
    });
  });

  it("rejects corrupt databases and incompatible schemas", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-kakao-invalid-"));
    temporaryRoots.push(root);
    const packageDir = join(root, "package");
    mkdirSync(packageDir);
    writeFileSync(
      join(packageDir, "membership.json"),
      JSON.stringify({ conversation_ids: ["room-a"] }),
    );
    writeFileSync(join(packageDir, "messages.sqlite"), "not sqlite");
    expect(
      createRecords(packageDir).execute({ operation: "manifest", period: "rolling_7d" }),
    ).toMatchObject({ status: "unavailable", error: { code: "database_corrupt" } });

    rmSync(join(packageDir, "messages.sqlite"));
    const db = new DatabaseSync(join(packageDir, "messages.sqlite"));
    db.exec("CREATE TABLE messages (message_id TEXT)");
    db.exec("CREATE TABLE attachments (message_id TEXT)");
    db.close();
    expect(
      createRecords(packageDir).execute({ operation: "manifest", period: "rolling_7d" }),
    ).toMatchObject({ status: "unavailable", error: { code: "schema_invalid" } });
  });

  it("registers one product-only model tool and executes the fixed manifest surface", async () => {
    const { packageDir } = fixture({ messageCount: 1 });
    expect(createKakaoworkPeriodRecordsTool({ packageDir })).toBeNull();
    process.env.JITECH_KWRAG_RUNTIME_PROFILE = "openclaw";
    const tool = createKakaoworkPeriodRecordsTool({
      packageDir,
      nowMs: () => NOW_MS,
      snapshotSecret: Buffer.alloc(32, 7),
    });
    if (!tool) {
      throw new Error("expected product tool");
    }
    expect(tool.name).toBe("jitech_kakaowork_period_records");
    const schema = tool.parameters as unknown as Record<string, unknown>;
    const properties = record(schema.properties);
    expect(record(properties.cursor)).toMatchObject({ type: "string" });
    expect(properties).toHaveProperty("coverage");
    expect(properties).not.toHaveProperty("coverage_tokens");
    const result = await tool.execute("call-1", {
      operation: "manifest",
      period: "rolling_7d",
    });
    expect(result.details).toMatchObject({ operation: "manifest", status: "ready" });
  });

  it("discovers the shipped weekly KakaoWork skill through the product loader", () => {
    const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills");
    const loaded = loadSkillsFromDirSafe({ dir: skillsDir, source: "openclaw-bundled" });
    expect(
      loaded.skills.find((skill) => skill.name === "jitech-weekly-kakaowork-summary"),
    ).toMatchObject({
      name: "jitech-weekly-kakaowork-summary",
      source: "openclaw-bundled",
    });
  });
});
