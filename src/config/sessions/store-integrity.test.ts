// W3 harness for issue #38: the sessions.json index must never be clobbered by
// a writer whose view of the world is wrong.
//
// The incident shape (oc1, 94→16): a transient read failure made the load
// path silently return an EMPTY store; that empty store became the base of the
// next read-modify-write save; the atomic writer then replaced the full index
// with a near-empty one — a perfectly clean, unrecoverable clobber. Two nets:
//
//  1. strict writer load — an EXISTING but unreadable store file throws
//     (SessionStoreUnreadableError) instead of silently becoming {}.
//  2. stale-base shrink guard — a save whose loaded BASE holds far fewer
//     entries than what is persisted on disk is refused
//     (SessionStoreMassShrinkError) and a backup is rotated first.
//     Intentional mutator deletions are exempt: the guard checks the base,
//     not the mutated result.
//
// Plus generation backups: content-changing saves keep a rotating
// sessions.json.bak.N restore point (interval-limited).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadSessionStore,
  saveSessionStore,
  SessionStoreMassShrinkError,
  SessionStoreUnreadableError,
  updateSessionStore,
} from "./store.js";
import type { SessionEntry } from "./types.js";

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-w3-store-"));
  storePath = path.join(dir, "sessions.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeStore(count: number, prefix = "agent:main:test"): Record<string, SessionEntry> {
  const store: Record<string, SessionEntry> = {};
  for (let i = 0; i < count; i += 1) {
    store[`${prefix}:${i}`] = {
      sessionId: `sid-${prefix}-${i}`,
      updatedAt: Date.now(),
    } as SessionEntry;
  }
  return store;
}

async function seedStore(count: number): Promise<void> {
  await saveSessionStore(storePath, makeStore(count), { skipMaintenance: true });
  expect(Object.keys(loadSessionStore(storePath, { skipCache: true }))).toHaveLength(count);
}

describe("strict writer load (issue #38 net 1)", () => {
  it("throws for an existing-but-corrupt store file instead of returning {}", async () => {
    await seedStore(5);
    fs.writeFileSync(storePath, "{ this is not json", "utf-8");
    expect(() => loadSessionStore(storePath, { skipCache: true, strict: true })).toThrow(
      SessionStoreUnreadableError,
    );
  });

  it("stays lenient for a non-record shape even in strict mode (legacy array recovery)", () => {
    // Valid JSON with the wrong shape (e.g. a legacy array-backed store) is
    // definitively not a session record — the product intentionally recovers
    // from it by resetting, so strict mode must not block that. Only
    // read/parse failures (intact content may still exist) are refused.
    fs.writeFileSync(storePath, JSON.stringify([1, 2, 3]), "utf-8");
    expect(loadSessionStore(storePath, { skipCache: true, strict: true })).toEqual({});
  });

  it("does NOT throw for a missing file (legitimately empty store)", () => {
    const store = loadSessionStore(storePath, { skipCache: true, strict: true });
    expect(store).toEqual({});
  });

  it("lenient (reader) load still falls back to {} on corruption", async () => {
    await seedStore(5);
    fs.writeFileSync(storePath, "garbage", "utf-8");
    expect(loadSessionStore(storePath, { skipCache: true })).toEqual({});
  });

  it("refuses to let a corrupt file become an RMW base: updateSessionStore rejects", async () => {
    await seedStore(5);
    fs.writeFileSync(storePath, "garbage", "utf-8");
    await expect(
      updateSessionStore(storePath, (store) => {
        store["agent:main:test:new"] = { sessionId: "sid-new" } as SessionEntry;
      }),
    ).rejects.toBeInstanceOf(SessionStoreUnreadableError);
    // The corrupt file is untouched — nothing was clobbered.
    expect(fs.readFileSync(storePath, "utf-8")).toBe("garbage");
  });
});

describe("stale-base shrink guard (issue #38 net 2)", () => {
  it("refuses a direct save whose base lost most of the persisted index", async () => {
    await seedStore(40);
    // A stale writer (e.g. another process's old snapshot) tries to persist a
    // 3-entry world over a 40-entry index — the oc1 clobber shape.
    await expect(
      saveSessionStore(storePath, makeStore(3, "agent:main:stale"), { skipMaintenance: true }),
    ).rejects.toBeInstanceOf(SessionStoreMassShrinkError);
    // The full index survived, and a forensic backup was rotated.
    expect(Object.keys(loadSessionStore(storePath, { skipCache: true }))).toHaveLength(40);
    expect(fs.existsSync(`${storePath}.bak.1`)).toBe(true);
  });

  it("allows intentional bulk deletions through an updateSessionStore mutator", async () => {
    await seedStore(40);
    // The mutator saw the full 40-entry base and deliberately deleted 35 —
    // that is a legitimate operation (session reaper), not a stale base.
    await updateSessionStore(storePath, (store) => {
      for (const key of Object.keys(store).slice(0, 35)) {
        delete store[key];
      }
    });
    expect(Object.keys(loadSessionStore(storePath, { skipCache: true }))).toHaveLength(5);
  });

  it("allows small shrinks and stays quiet below the thresholds", async () => {
    await seedStore(25);
    await saveSessionStore(storePath, makeStore(20), { skipMaintenance: true });
    expect(Object.keys(loadSessionStore(storePath, { skipCache: true }))).toHaveLength(20);
  });

  it("skipShrinkGuard bypasses the guard for explicitly-intended bulk clears", async () => {
    await seedStore(40);
    await saveSessionStore(storePath, makeStore(2, "agent:main:clear"), {
      skipMaintenance: true,
      skipShrinkGuard: true,
    });
    expect(Object.keys(loadSessionStore(storePath, { skipCache: true }))).toHaveLength(2);
  });
});

describe("generation backups", () => {
  it("rotates a backup before a content-changing save", async () => {
    await seedStore(30);
    await updateSessionStore(storePath, (store) => {
      store["agent:main:test:extra"] = { sessionId: "sid-extra" } as SessionEntry;
    });
    expect(fs.existsSync(`${storePath}.bak.1`)).toBe(true);
    // The backup holds a valid pre-change snapshot.
    const backup = JSON.parse(fs.readFileSync(`${storePath}.bak.1`, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(backup).length).toBeGreaterThanOrEqual(30);
  });
});
