#!/usr/bin/env node
// Recover orphaned session transcripts back into sessions.json (issue #35).
//
// The session-write concurrency bug dropped sessions from the store while their
// transcript .jsonl files stayed intact on disk. Those orphans no longer appear
// in the sidebar. This re-registers them additively so the customer's history
// reappears. It is DATA-ONLY (no code, no container/image change).
//
// Self-contained — node built-ins only, so it runs anywhere with node against a
// session store directory (host bind-mount or inside the container).
//
// Usage:
//   node recover-orphan-sessions.mjs <sessions-dir> [--agent <id>] [--write]
//
//   <sessions-dir>  dir holding sessions.json and the <uuid>.jsonl transcripts
//                   (e.g. .../agents/main/sessions)
//   --agent <id>    agent id for the recovered keys (default: main)
//   --write         actually write (default is a dry-run that only reports)
//
// Safety: run with the gateway STOPPED (avoids racing the live store cache).
// Backs up sessions.json before writing; never overwrites an existing entry;
// writes atomically (temp file + rename).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBAGENT_PREFIX = "[Subagent Context]";
const HEARTBEAT_PREFIX = "Read HEARTBEAT.md";

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { agent: "main", write: false, dir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") {
      args.write = true;
    } else if (a === "--agent") {
      args.agent = argv[++i];
    } else if (!a.startsWith("--") && !args.dir) {
      args.dir = a;
    } else {
      fail(`unexpected argument: ${a}`);
    }
  }
  if (!args.dir) {
    fail("missing <sessions-dir>");
  }
  if (!args.agent) {
    fail("--agent requires a value");
  }
  return args;
}

// A transcript file we should NOT treat as a recoverable top-level session.
function isSkippableTranscriptName(name) {
  if (name === "sessions.json") {
    return true;
  }
  if (name.startsWith("sessions.json.")) {
    return true;
  } // backups / lock artifacts
  if (!name.endsWith(".jsonl")) {
    return true;
  } // archived <file>.<reason>.<ts> etc.
  if (/\.checkpoint\.[0-9a-f-]+\.jsonl$/i.test(name)) {
    return true;
  } // compaction checkpoints
  if (/\.trajectory\.jsonl$/i.test(name)) {
    return true;
  } // runtime trajectory artifacts
  if (/-topic-/.test(name)) {
    return true;
  } // telegram topic threads (key unrecoverable)
  return false;
}

function coerceMs(value) {
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

function firstUserText(records) {
  for (const rec of records) {
    if (rec?.type !== "message") {
      continue;
    }
    const msg = rec.message;
    if (!msg || msg.role !== "user") {
      continue;
    }
    const c = msg.content;
    if (typeof c === "string") {
      return c;
    }
    if (Array.isArray(c)) {
      const text = c
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("")
        .trim();
      if (text) {
        return text;
      }
    }
    return "";
  }
  return "";
}

// Read a transcript and pull out only what a SessionEntry needs.
function inspectTranscript(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    return { ok: false, reason: `read failed: ${err.code ?? err}` };
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { ok: false, reason: "empty (0-byte tombstone)" };
  }
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return { ok: false, reason: "line 1 is not JSON" };
  }
  if (header?.type !== "session") {
    return { ok: false, reason: "no session header" };
  }

  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      /* tolerate a stray bad line */
    }
  }
  let lastTs;
  for (const rec of records) {
    const ms = coerceMs(rec?.timestamp);
    if (ms !== undefined) {
      lastTs = ms;
    }
  }
  const stem = path.basename(filePath, ".jsonl");
  return {
    ok: true,
    // resolveSessionFilePath keys on the filename stem, so trust it over header.id.
    sessionId: UUID_RE.test(stem) ? stem : header.id,
    headerMismatch: typeof header.id === "string" && header.id !== stem,
    sessionStartedAt: coerceMs(header.timestamp),
    updatedAt: lastTs,
    firstUser: firstUserText(records),
  };
}

function classify(firstUser) {
  const t = (firstUser ?? "").trimStart();
  if (t.startsWith(SUBAGENT_PREFIX)) {
    return "subagent";
  }
  if (t.startsWith(HEARTBEAT_PREFIX)) {
    return "heartbeat";
  }
  return "dashboard";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(args.dir);
  const storePath = path.join(dir, "sessions.json");
  if (!fs.existsSync(storePath)) {
    fail(`no sessions.json in ${dir}`);
  }

  let store;
  try {
    store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
  } catch (err) {
    fail(`sessions.json is not valid JSON: ${err}`);
  }
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    fail("sessions.json is not a key→entry object; refusing to touch an unexpected shape");
  }

  // Files already referenced by a surviving entry must be left alone.
  const referenced = new Set();
  for (const entry of Object.values(store)) {
    if (entry?.sessionFile) {
      referenced.add(path.basename(entry.sessionFile));
    }
    if (entry?.sessionId) {
      referenced.add(`${entry.sessionId}.jsonl`);
    }
  }

  const files = fs.readdirSync(dir).filter((name) => !isSkippableTranscriptName(name));
  const summary = { scanned: 0, orphan: 0, dashboard: 0, subagent: 0, heartbeatSkipped: 0, bad: 0 };
  const additions = {};

  for (const name of files) {
    summary.scanned++;
    if (referenced.has(name)) {
      continue;
    }
    summary.orphan++;
    const filePath = path.join(dir, name);
    const info = inspectTranscript(filePath);
    if (!info.ok) {
      summary.bad++;
      console.log(`  skip  ${name}  (${info.reason})`);
      continue;
    }
    const kind = classify(info.firstUser);
    if (kind === "heartbeat") {
      summary.heartbeatSkipped++;
      console.log(`  skip  ${name}  (heartbeat rotation — leaving the live entry alone)`);
      continue;
    }
    const key = `agent:${args.agent}:${kind}:${info.sessionId}`;
    if (key in store || key in additions) {
      console.log(`  skip  ${name}  (key already present: ${key})`);
      continue;
    }
    const updatedAt = info.updatedAt ?? info.sessionStartedAt ?? fs.statSync(filePath).mtimeMs;
    const entry = {
      sessionId: info.sessionId,
      updatedAt,
      ...(info.sessionStartedAt !== undefined ? { sessionStartedAt: info.sessionStartedAt } : {}),
      sessionFile: filePath,
    };
    additions[key] = entry;
    summary[kind]++;
    console.log(
      `  add   ${kind.padEnd(9)} ${key}${info.headerMismatch ? "  (header.id != filename — trusting filename)" : ""}`,
    );
  }

  console.log(
    `\nscanned=${summary.scanned} orphan=${summary.orphan} ` +
      `recover(dashboard=${summary.dashboard} subagent=${summary.subagent}) ` +
      `heartbeat-skipped=${summary.heartbeatSkipped} unreadable=${summary.bad}`,
  );

  const addCount = Object.keys(additions).length;
  if (addCount === 0) {
    console.log("nothing to recover.");
    return;
  }
  if (!args.write) {
    console.log(`\nDRY RUN — would add ${addCount} entries. Re-run with --write to apply.`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(dir, `sessions.json.pre-reindex.${stamp}`);
  fs.copyFileSync(storePath, backup);
  console.log(`\nbacked up sessions.json -> ${path.basename(backup)}`);

  const merged = { ...store };
  for (const [key, entry] of Object.entries(additions)) {
    if (!(key in merged)) {
      merged[key] = entry;
    } // additive only; survivors win
  }
  const tmp = path.join(dir, `sessions.json.reindex.tmp.${crypto.randomUUID()}`);
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, storePath);
  console.log(
    `wrote ${addCount} recovered entries to sessions.json (${Object.keys(merged).length} total).`,
  );
}

main();
