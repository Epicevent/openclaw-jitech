// Tests for the product reindex (issue #38): rebuild sessions.json entries
// from transcript files. Port of the validated #39 recovery-script behavior,
// including its hard-won lessons (no sessionFile in recovered entries;
// heartbeat rotations skipped; filename stem beats header.id).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reindexSessionStoreFromTranscripts } from "./store-reindex.js";
import { loadSessionStore, saveSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-w3-reindex-"));
  storePath = path.join(dir, "sessions.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

function writeTranscript(
  sessionId: string,
  opts: { firstUser?: string; headerId?: string; lastTimestamp?: string } = {},
): string {
  const name = `${sessionId}.jsonl`;
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: opts.headerId ?? sessionId,
      timestamp: "2026-07-01T00:00:00.000Z",
      cwd: "/work",
    }),
    JSON.stringify({
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-07-01T00:00:01.000Z",
      message: { role: "user", content: opts.firstUser ?? "hello there" },
    }),
    JSON.stringify({
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: opts.lastTimestamp ?? "2026-07-02T10:00:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    }),
  ];
  fs.writeFileSync(path.join(dir, name), `${lines.join("\n")}\n`, "utf-8");
  return name;
}

async function seedStore(entries: Record<string, SessionEntry>): Promise<void> {
  await saveSessionStore(storePath, entries, { skipMaintenance: true });
}

describe("reindexSessionStoreFromTranscripts (issue #38)", () => {
  it("re-registers an orphan dashboard transcript additively, without sessionFile", async () => {
    writeTranscript(UUID_A);
    writeTranscript(UUID_B); // referenced survivor
    await seedStore({
      [`agent:main:dashboard:${UUID_B}`]: { sessionId: UUID_B, updatedAt: 1 } as SessionEntry,
    });

    const dry = await reindexSessionStoreFromTranscripts({
      storePath,
      agentId: "main",
      write: false,
    });
    expect(dry.wrote).toBe(false);
    expect(dry.additions).toHaveLength(1);
    expect(dry.additions[0]?.key).toBe(`agent:main:dashboard:${UUID_A}`);

    // Dry run must not have touched the store.
    expect(Object.keys(loadSessionStore(storePath, { skipCache: true }))).toHaveLength(1);

    const wet = await reindexSessionStoreFromTranscripts({
      storePath,
      agentId: "main",
      write: true,
    });
    expect(wet.wrote).toBe(true);
    expect(wet.backupPath && fs.existsSync(wet.backupPath)).toBe(true);

    const store = loadSessionStore(storePath, { skipCache: true });
    const recovered = store[`agent:main:dashboard:${UUID_A}`];
    expect(recovered?.sessionId).toBe(UUID_A);
    expect(recovered?.updatedAt).toBe(Date.parse("2026-07-02T10:00:00.000Z"));
    // The #39 lesson: never bake an absolute path into recovered entries.
    expect(recovered && "sessionFile" in recovered && recovered.sessionFile).toBeFalsy();
    // Survivor untouched.
    expect(store[`agent:main:dashboard:${UUID_B}`]?.updatedAt).toBe(1);
  });

  it("classifies subagent transcripts and skips heartbeat rotations", async () => {
    writeTranscript(UUID_A, { firstUser: "[Subagent Context] do the thing" });
    writeTranscript(UUID_B, { firstUser: "Read HEARTBEAT.md and act on it" });
    await seedStore({});

    const report = await reindexSessionStoreFromTranscripts({
      storePath,
      agentId: "work",
      write: false,
    });
    expect(report.additions.map((a) => a.key)).toEqual([`agent:work:subagent:${UUID_A}`]);
    expect(report.skipped).toContainEqual({
      file: `${UUID_B}.jsonl`,
      reason: "heartbeat rotation",
    });
  });

  it("skips store artifacts, checkpoints, trajectories, topic threads, and tombstones", async () => {
    fs.writeFileSync(path.join(dir, "sessions.json.pre-reindex.x"), "{}", "utf-8");
    fs.writeFileSync(path.join(dir, `${UUID_C}.checkpoint.abc.jsonl`), "x", "utf-8");
    fs.writeFileSync(path.join(dir, `${UUID_C}.trajectory.jsonl`), "x", "utf-8");
    fs.writeFileSync(path.join(dir, `tg-topic-42-${UUID_C}.jsonl`), "x", "utf-8");
    fs.writeFileSync(path.join(dir, `${UUID_D}.jsonl`), "", "utf-8"); // tombstone
    await seedStore({});

    const report = await reindexSessionStoreFromTranscripts({
      storePath,
      agentId: "main",
      write: false,
    });
    expect(report.additions).toHaveLength(0);
    expect(report.skipped).toContainEqual({
      file: `${UUID_D}.jsonl`,
      reason: "empty (0-byte tombstone)",
    });
  });

  it("trusts the filename stem over a mismatching header.id", async () => {
    writeTranscript(UUID_A, { headerId: UUID_C });
    await seedStore({});

    const report = await reindexSessionStoreFromTranscripts({
      storePath,
      agentId: "main",
      write: false,
    });
    expect(report.additions[0]?.sessionId).toBe(UUID_A);
    expect(report.additions[0]?.headerMismatch).toBe(true);
  });

  it("rebuilds from zero when the store file exists but is unreadable, preserving the corrupt copy", async () => {
    writeTranscript(UUID_A);
    fs.writeFileSync(storePath, "{ corrupted", "utf-8");

    const report = await reindexSessionStoreFromTranscripts({
      storePath,
      agentId: "main",
      write: true,
    });
    expect(report.storeUnreadable).toBe(true);
    expect(report.wrote).toBe(true);
    expect(report.corruptCopyPath && fs.existsSync(report.corruptCopyPath)).toBe(true);
    expect(fs.readFileSync(report.corruptCopyPath ?? "", "utf-8")).toBe("{ corrupted");

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[`agent:main:dashboard:${UUID_A}`]?.sessionId).toBe(UUID_A);
  });

  it("is idempotent: a second run adds nothing", async () => {
    writeTranscript(UUID_A);
    await seedStore({});
    await reindexSessionStoreFromTranscripts({ storePath, agentId: "main", write: true });

    const again = await reindexSessionStoreFromTranscripts({
      storePath,
      agentId: "main",
      write: true,
    });
    expect(again.additions).toHaveLength(0);
    expect(again.wrote).toBe(false);
  });
});
