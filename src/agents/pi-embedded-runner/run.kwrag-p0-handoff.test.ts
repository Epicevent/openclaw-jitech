import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildKwragP0TestHandoff } from "../kwrag-p0-handoff.fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedResolveModelAsync,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

function firstAttemptParams(): Record<string, unknown> {
  const call = mockedRunEmbeddedAttempt.mock.calls[0] as [Record<string, unknown>] | undefined;
  if (!call) {
    throw new Error("expected fixed downstream attempt stub call");
  }
  return call[0];
}

describe("runEmbeddedPiAgent KWRAG P0 handoff", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("binds one content-free receipt without changing the prompt or making a physical provider call", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());
    const onRetrievalHandoffReceipt = vi.fn();

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-p0-1",
      retrievalHandoff: buildKwragP0TestHandoff(),
      onRetrievalHandoffReceipt,
    });

    expect(onRetrievalHandoffReceipt).toHaveBeenCalledTimes(1);
    expect(onRetrievalHandoffReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        consumptionStatus: "not_consumed",
        promptInjectionApplied: false,
      }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(firstAttemptParams().prompt).toBe("hello");
  });

  it("fails before model resolution or attempt dispatch when the receipt bytes are tampered", async () => {
    const retrievalHandoff = buildKwragP0TestHandoff();
    (retrievalHandoff.handoff as { result: { resultId: string } }).result.resultId = "tampered";
    const onRetrievalHandoffReceipt = vi.fn();

    await expect(
      runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        runId: "run-p0-1",
        retrievalHandoff,
        onRetrievalHandoffReceipt,
      }),
    ).rejects.toThrow(/handoffDigest does not match canonical bytes/u);

    expect(onRetrievalHandoffReceipt).not.toHaveBeenCalled();
    expect(mockedResolveModelAsync).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
  });

  it("fails before dispatch for an out-of-scope mount", async () => {
    const retrievalHandoff = buildKwragP0TestHandoff();
    retrievalHandoff.expected.mountAuthorityDigest = `sha256:${"6".repeat(64)}`;

    await expect(
      runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        runId: "run-p0-1",
        retrievalHandoff,
        onRetrievalHandoffReceipt: vi.fn(),
      }),
    ).rejects.toThrow(/same-slot read-only boundary/u);

    expect(mockedResolveModelAsync).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
  });

  it("fails before dispatch when a caller omits the immutable receipt sink", async () => {
    await expect(
      runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        runId: "run-p0-1",
        retrievalHandoff: buildKwragP0TestHandoff(),
      }),
    ).rejects.toThrow(/requires a receipt sink/u);

    expect(mockedResolveModelAsync).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
  });

  it("fails before dispatch when the immutable receipt sink cannot persist", async () => {
    const onRetrievalHandoffReceipt = vi.fn(async () => {
      throw new Error("fixture ledger unavailable");
    });

    await expect(
      runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        runId: "run-p0-1",
        retrievalHandoff: buildKwragP0TestHandoff(),
        onRetrievalHandoffReceipt,
      }),
    ).rejects.toThrow(/fixture ledger unavailable/u);

    expect(onRetrievalHandoffReceipt).toHaveBeenCalledTimes(1);
    expect(mockedResolveModelAsync).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
  });

  it("remains disabled by default and sends the original prompt to the fixed attempt stub", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());
    const onRetrievalHandoffReceipt = vi.fn();

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      onRetrievalHandoffReceipt,
    });

    expect(onRetrievalHandoffReceipt).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(firstAttemptParams().prompt).toBe("hello");
  });
});
