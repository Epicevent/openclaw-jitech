import { afterEach, describe, expect, it } from "vitest";
import {
  getModelHealthSnapshot,
  recordModelCallFailure,
  recordModelCallSuccess,
  recordSessionStoreSaveFailure,
  resetModelHealthForTest,
} from "./model-health.js";

afterEach(() => {
  resetModelHealthForTest();
});

describe("model health recorder (issue #32)", () => {
  it("tracks consecutive failures and resets on success", () => {
    recordModelCallFailure({ provider: "anthropic", model: "opus", status: 529 });
    recordModelCallFailure({ provider: "anthropic", model: "opus", status: 529 });
    let snap = getModelHealthSnapshot();
    expect(snap.consecutiveFailures).toBe(2);
    expect(snap.lastFailure?.status).toBe(529);
    expect(snap.recentFailures).toHaveLength(2);
    expect(snap.lastSuccess).toBeUndefined();

    recordModelCallSuccess({ provider: "anthropic", model: "opus" });
    snap = getModelHealthSnapshot();
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.lastSuccess?.provider).toBe("anthropic");
    // History survives recovery — that's the incident forensics.
    expect(snap.recentFailures).toHaveLength(2);
    expect(snap.lastFailure?.status).toBe(529);
  });

  it("caps the recent-failure ring buffer", () => {
    for (let i = 0; i < 60; i += 1) {
      recordModelCallFailure({ provider: "p", model: "m", code: `e${i}` });
    }
    const snap = getModelHealthSnapshot();
    expect(snap.recentFailures).toHaveLength(50);
    expect(snap.recentFailures[49]?.code).toBe("e59");
    expect(snap.consecutiveFailures).toBe(60);
  });

  it("tracks session-store save failures separately", () => {
    recordSessionStoreSaveFailure({ storePath: "/s/sessions.json", error: new Error("ENOSPC") });
    const snap = getModelHealthSnapshot();
    expect(snap.sessionStore.saveFailureCount).toBe(1);
    expect(snap.sessionStore.lastSaveFailure?.error).toBe("ENOSPC");
    // Store failures do not pollute the model-call axis.
    expect(snap.consecutiveFailures).toBe(0);
  });

  it("returns a defensive copy of recentFailures", () => {
    recordModelCallFailure({ provider: "p", model: "m" });
    const snap = getModelHealthSnapshot();
    snap.recentFailures.length = 0;
    expect(getModelHealthSnapshot().recentFailures).toHaveLength(1);
  });
});
