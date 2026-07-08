// Wave 0 harness for issue #35: same-session-file embedded runs must never
// overlap, even when they arrive under different session keys (dashboard
// connections each mint their own key, and aliased keys can resolve to one
// file). The dispatch lanes are BYPASSED via a pass-through `enqueue` so the
// only serialization under test is withSessionFileMutex in run.ts — otherwise
// a serial global lane would hide a broken mutex (false pass).
//
// Falsification: with the withSessionFileMutex wrap reverted, the first test
// must fail (maxActive > 1). Verified once at harness introduction; kept as a
// permanent regression guard afterwards.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

beforeAll(async () => {
  ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
});

beforeEach(() => {
  resetRunOverflowCompactionHarnessMocks();
});

type Passthrough = NonNullable<Parameters<typeof runEmbeddedPiAgent>[0]["enqueue"]>;

// Lanes bypassed: every run reaches the session-file mutex concurrently.
const passthroughEnqueue: Passthrough = (task) => task();

function trackAttemptOverlap(promptMs: number) {
  const state = { active: 0, maxActive: 0, calls: 0 };
  mockedRunEmbeddedAttempt.mockImplementation(async () => {
    state.calls += 1;
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    // The "prompt": long enough that concurrent entries would overlap.
    await new Promise((resolve) => setTimeout(resolve, promptMs));
    state.active -= 1;
    return makeAttemptResult({});
  });
  return state;
}

function runWith(params: { n: number; sessionFile: string }) {
  return runEmbeddedPiAgent({
    ...overflowBaseRunParams,
    // Distinct per-connection keys — exactly the incident shape. Distinct keys
    // mean distinct dispatch lanes, so lanes alone cannot serialize these.
    sessionKey: `agent:main:dashboard:w0-uuid-${params.n}`,
    runId: `w0-run-${params.n}`,
    sessionId: `w0-session-${params.n}`,
    sessionFile: params.sessionFile,
    enqueue: passthroughEnqueue,
  } as unknown as Parameters<typeof runEmbeddedPiAgent>[0]);
}

describe("session-file serialization (issue #35)", () => {
  it("never overlaps runs that target the same session file, across different session keys", async () => {
    const state = trackAttemptOverlap(40);
    const sharedFile = "/tmp/openclaw-w0-shared-session.jsonl";

    await Promise.all([
      runWith({ n: 1, sessionFile: sharedFile }),
      runWith({ n: 2, sessionFile: sharedFile }),
      runWith({ n: 3, sessionFile: sharedFile }),
    ]);

    expect(state.calls).toBe(3);
    // The invariant: one session file, one writer at a time — prompt included.
    expect(state.maxActive).toBe(1);
  });

  it("keeps runs on different session files parallel (no global serialization)", async () => {
    const state = trackAttemptOverlap(80);

    await Promise.all([
      runWith({ n: 1, sessionFile: "/tmp/openclaw-w0-file-a.jsonl" }),
      runWith({ n: 2, sessionFile: "/tmp/openclaw-w0-file-b.jsonl" }),
      runWith({ n: 3, sessionFile: "/tmp/openclaw-w0-file-c.jsonl" }),
    ]);

    expect(state.calls).toBe(3);
    // Different files must not queue behind each other. If this drops to 1 the
    // mutex (or a lane) is over-serializing — the groupware-convoy failure mode.
    expect(state.maxActive).toBeGreaterThan(1);
  });
});
