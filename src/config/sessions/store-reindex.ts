// Rebuild sessions.json entries from the transcript files on disk (issue #38).
//
// The index is DERIVED data: every conversation's source of truth is its
// <sessionId>.jsonl transcript next to sessions.json. When index entries are
// lost (the #38 clobber class) the transcripts survive, so the index can be
// re-derived. This module is the product successor of the one-off #39 recovery
// script that restored oc1 (79 sessions re-listed + 19 archived) — same skip
// rules and classification heuristics, hardened by what that run taught us:
//
//  - NEVER persist an absolute sessionFile path. The #39 branch script baked
//    the scanning host's mount path into recovered entries and the gateway
//    then failed on `mkdir /oc`; the actual oc1 run used an amended script
//    that OMITS the field so the gateway resolves `<sessionId>.jsonl` against
//    the store directory. Recovered entries here carry no sessionFile.
//  - Additive only, survivors win: an existing entry is never touched, so
//    re-running is idempotent and racing a live gateway can only lose an
//    addition, never damage an existing entry.
//  - Original routing keys (channel bindings, labels, folders) are physically
//    unrecoverable — transcripts don't contain them. Recovered sessions
//    re-enter under best-effort `agent:<id>:dashboard:<sessionId>` /
//    `agent:<id>:subagent:<sessionId>` keys: listed and openable, but not
//    re-bound to their old delivery routes.
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadSessionStore, SessionStoreUnreadableError } from "./store-load.js";
import { saveSessionStore, updateSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

const log = createSubsystemLogger("sessions/reindex");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBAGENT_PREFIX = "[Subagent Context]";
const HEARTBEAT_PREFIX = "Read HEARTBEAT.md";

export type ReindexAddition = {
  key: string;
  sessionId: string;
  kind: "dashboard" | "subagent";
  updatedAt: number;
  headerMismatch: boolean;
};

export type ReindexSkip = {
  file: string;
  reason: string;
};

export type SessionStoreReindexReport = {
  storePath: string;
  /** The store file existed but was unreadable; reindex rebuilt from zero. */
  storeUnreadable: boolean;
  scanned: number;
  orphans: number;
  additions: ReindexAddition[];
  skipped: ReindexSkip[];
  /** false = dry run (default). */
  wrote: boolean;
  /** Copy of the pre-reindex store (write mode only). */
  backupPath?: string;
  /** Preserved copy of an unreadable store file (write mode only). */
  corruptCopyPath?: string;
};

// A transcript file we should NOT treat as a recoverable top-level session.
function skipReasonForTranscriptName(name: string): string | undefined {
  if (name === "sessions.json" || name.startsWith("sessions.json.")) {
    return "store file / store artifact";
  }
  if (!name.endsWith(".jsonl")) {
    return "not a .jsonl transcript";
  }
  if (/\.checkpoint\.[0-9a-f-]+\.jsonl$/i.test(name)) {
    return "compaction checkpoint";
  }
  if (/\.trajectory\.jsonl$/i.test(name)) {
    return "trajectory artifact";
  }
  if (name.includes("-topic-")) {
    return "telegram topic thread (key unrecoverable)";
  }
  return undefined;
}

function coerceMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) {
      return ms;
    }
  }
  return undefined;
}

function firstUserText(records: unknown[]): string {
  for (const rec of records) {
    const record = rec as { type?: unknown; message?: { role?: unknown; content?: unknown } };
    if (record?.type !== "message") {
      continue;
    }
    const msg = record.message;
    if (!msg || msg.role !== "user") {
      continue;
    }
    const content = msg.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          typeof (part as { text?: unknown })?.text === "string"
            ? (part as { text: string }).text
            : "",
        )
        .join("")
        .trim();
    }
    return "";
  }
  return "";
}

type TranscriptInfo =
  | { ok: false; reason: string }
  | {
      ok: true;
      sessionId: string;
      headerMismatch: boolean;
      sessionStartedAt?: number;
      updatedAt?: number;
      firstUser: string;
    };

// Read a transcript and pull out only what a SessionEntry needs.
function inspectTranscript(filePath: string): TranscriptInfo {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return { ok: false, reason: `read failed${code ? ` (${code})` : ""}` };
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { ok: false, reason: "empty (0-byte tombstone)" };
  }
  let header: { type?: unknown; id?: unknown; timestamp?: unknown };
  try {
    header = JSON.parse(lines[0] ?? "") as typeof header;
  } catch {
    return { ok: false, reason: "line 1 is not JSON" };
  }
  if (header?.type !== "session") {
    return { ok: false, reason: "no session header" };
  }

  const records: unknown[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // Tolerate a stray bad line.
    }
  }
  let lastTs: number | undefined;
  for (const rec of records) {
    const ms = coerceMs((rec as { timestamp?: unknown })?.timestamp);
    if (ms !== undefined) {
      lastTs = ms;
    }
  }
  const stem = path.basename(filePath, ".jsonl");
  const headerId = typeof header.id === "string" ? header.id : undefined;
  // resolveSessionFilePath keys on the filename stem, so trust it over header.id
  // (a recovered-by-append duplicate header may carry a different id).
  const sessionId = UUID_RE.test(stem) ? stem : headerId;
  if (!sessionId) {
    return { ok: false, reason: "no usable session id (filename stem nor header.id)" };
  }
  const startedAt = coerceMs(header.timestamp);
  return {
    ok: true,
    sessionId,
    headerMismatch: headerId !== undefined && headerId !== stem,
    ...(startedAt !== undefined ? { sessionStartedAt: startedAt } : {}),
    ...(lastTs !== undefined ? { updatedAt: lastTs } : {}),
    firstUser: firstUserText(records),
  };
}

function classify(firstUser: string): "dashboard" | "subagent" | "heartbeat" {
  const t = firstUser.trimStart();
  if (t.startsWith(SUBAGENT_PREFIX)) {
    return "subagent";
  }
  if (t.startsWith(HEARTBEAT_PREFIX)) {
    return "heartbeat";
  }
  return "dashboard";
}

function fileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function reindexSessionStoreFromTranscripts(params: {
  storePath: string;
  agentId: string;
  write: boolean;
}): Promise<SessionStoreReindexReport> {
  const storePath = path.resolve(params.storePath);
  const dir = path.dirname(storePath);
  const report: SessionStoreReindexReport = {
    storePath,
    storeUnreadable: false,
    scanned: 0,
    orphans: 0,
    additions: [],
    skipped: [],
    wrote: false,
  };

  // Base store. An unreadable-but-existing store is exactly the disaster this
  // command recovers from: rebuild from zero, preserving the corrupt file.
  let base: Record<string, SessionEntry> = {};
  if (fs.existsSync(storePath)) {
    try {
      base = loadSessionStore(storePath, { skipCache: true, strict: true });
    } catch (err) {
      if (!(err instanceof SessionStoreUnreadableError)) {
        throw err;
      }
      report.storeUnreadable = true;
      log.warn(`reindex: store is unreadable, rebuilding from transcripts: ${storePath}`);
    }
  }

  // Transcripts already referenced by a surviving entry are left alone.
  const referenced = new Set<string>();
  for (const entry of Object.values(base)) {
    if (entry?.sessionFile) {
      referenced.add(path.basename(entry.sessionFile));
    }
    if (entry?.sessionId) {
      referenced.add(`${entry.sessionId}.jsonl`);
    }
  }

  const additions: Record<string, SessionEntry> = {};
  for (const name of fs.readdirSync(dir)) {
    const skipReason = skipReasonForTranscriptName(name);
    if (skipReason) {
      continue; // not transcript-shaped at all; keep the report focused
    }
    report.scanned += 1;
    if (referenced.has(name)) {
      continue;
    }
    report.orphans += 1;
    const info = inspectTranscript(path.join(dir, name));
    if (!info.ok) {
      report.skipped.push({ file: name, reason: info.reason });
      continue;
    }
    const kind = classify(info.firstUser);
    if (kind === "heartbeat") {
      // Heartbeat transcripts rotate under a single live store entry; adding
      // them back would resurrect stale rotations as phantom sessions.
      report.skipped.push({ file: name, reason: "heartbeat rotation" });
      continue;
    }
    const key = `agent:${params.agentId}:${kind}:${info.sessionId}`;
    if (key in base || key in additions) {
      report.skipped.push({ file: name, reason: `key already present: ${key}` });
      continue;
    }
    const updatedAt =
      info.updatedAt ?? info.sessionStartedAt ?? fs.statSync(path.join(dir, name)).mtimeMs;
    // No sessionFile on purpose: the gateway resolves <sessionId>.jsonl against
    // the store directory, and a baked absolute path from the machine that ran
    // the reindex breaks inside the container (#39's bug).
    additions[key] = {
      sessionId: info.sessionId,
      updatedAt,
      ...(info.sessionStartedAt !== undefined ? { sessionStartedAt: info.sessionStartedAt } : {}),
    } as SessionEntry;
    report.additions.push({
      key,
      sessionId: info.sessionId,
      kind,
      updatedAt,
      headerMismatch: info.headerMismatch,
    });
  }

  if (!params.write || report.additions.length === 0) {
    return report;
  }

  if (report.storeUnreadable) {
    // Preserve the unreadable file for forensics, then write the rebuilt store.
    const corruptCopy = `${storePath}.corrupt.${fileStamp()}`;
    fs.copyFileSync(storePath, corruptCopy);
    report.corruptCopyPath = corruptCopy;
    // skipShrinkGuard: the base is empty because the store was unreadable —
    // that IS the recovery case, and the corrupt original is preserved above.
    // skipMaintenance: a recovery pass must not double as a retention pass —
    // recovered entries often carry old timestamps and would be pruned right
    // back out. Retention stays with the ordinary maintenance cycle.
    await saveSessionStore(storePath, additions, {
      skipShrinkGuard: true,
      skipMaintenance: true,
    });
    report.wrote = true;
    return report;
  }

  const backupPath = `${storePath}.pre-reindex.${fileStamp()}`;
  fs.copyFileSync(storePath, backupPath);
  report.backupPath = backupPath;
  // skipMaintenance: a recovery pass must not double as a retention pass —
  // both survivors with old timestamps and freshly recovered old sessions
  // would otherwise be pruned in the same write. Retention stays with the
  // ordinary maintenance cycle.
  await updateSessionStore(
    storePath,
    (store) => {
      for (const [key, entry] of Object.entries(additions)) {
        if (!(key in store)) {
          store[key] = entry; // additive only; survivors win
        }
      }
    },
    { skipMaintenance: true },
  );
  report.wrote = true;
  return report;
}
