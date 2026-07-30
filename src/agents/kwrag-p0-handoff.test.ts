import { describe, expect, it, vi } from "vitest";
import {
  buildKwragP0TestHandoff,
  KWRAG_P0_TEST_CONSUMPTION_DIGEST,
  KWRAG_P0_TEST_HANDOFF_DIGEST,
  KWRAG_P0_TEST_OPERATION_DIGEST,
  KWRAG_P0_TEST_RECEIPT_DIGEST,
  KWRAG_P0_TEST_RESULT_DIGEST,
} from "./kwrag-p0-handoff.fixture.js";
import {
  KWRAG_CONSUMPTION_RECEIPT_SCHEMA,
  KWRAG_OPERATION_RECEIPT_SCHEMA,
  KWRAG_P1_UNRESOLVED_IDENTITY,
  KWRAG_RESULT_RECEIPT_SCHEMA,
  verifyOptionalKwragP0Handoff,
} from "./kwrag-p0-handoff.js";

describe("caller-explicit KWRAG P0 handoff", () => {
  it("binds exact operation, result, and non-consumed receipt identities", () => {
    const input = buildKwragP0TestHandoff();
    const receipt = verifyOptionalKwragP0Handoff({
      input,
      runId: "run-p0-1",
      sessionId: "session-p0-1",
    });

    expect((input.handoff as { handoffDigest: string }).handoffDigest).toBe(
      KWRAG_P0_TEST_HANDOFF_DIGEST,
    );
    expect(receipt).toEqual(
      expect.objectContaining({
        operationSchema: KWRAG_OPERATION_RECEIPT_SCHEMA,
        operationReceiptDigest: KWRAG_P0_TEST_OPERATION_DIGEST,
        resultSchema: KWRAG_RESULT_RECEIPT_SCHEMA,
        resultReceiptDigest: KWRAG_P0_TEST_RESULT_DIGEST,
        consumptionSchema: KWRAG_CONSUMPTION_RECEIPT_SCHEMA,
        consumptionReceiptDigest: KWRAG_P0_TEST_CONSUMPTION_DIGEST,
        consumptionStatus: "not_consumed",
        promptInjectionApplied: false,
        p1Identity: KWRAG_P1_UNRESOLVED_IDENTITY,
      }),
    );
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(receipt?.receiptDigest).toBe(KWRAG_P0_TEST_RECEIPT_DIGEST);
  });

  it("rejects canonical-byte tampering", () => {
    const input = buildKwragP0TestHandoff();
    (input.handoff as { result: { resultId: string } }).result.resultId = "tampered-result";

    expect(() =>
      verifyOptionalKwragP0Handoff({
        input,
        runId: "run-p0-1",
        sessionId: "session-p0-1",
      }),
    ).toThrow(/handoffDigest does not match canonical bytes/u);
  });

  it("rejects self-consistent but mislinked receipts", () => {
    const input = buildKwragP0TestHandoff((body) => {
      (body.consumption as Record<string, unknown>).resultReceiptDigest =
        KWRAG_P0_TEST_OPERATION_DIGEST;
    });

    expect(() =>
      verifyOptionalKwragP0Handoff({
        input,
        runId: "run-p0-1",
        sessionId: "session-p0-1",
      }),
    ).toThrow(/must link the exact operation and result receipts/u);
  });

  it("rejects prompt or backend policy fields even when re-digested", () => {
    const input = buildKwragP0TestHandoff((body) => {
      body.prompt = "must never enter the P0 handoff";
    });

    expect(() =>
      verifyOptionalKwragP0Handoff({
        input,
        runId: "run-p0-1",
        sessionId: "session-p0-1",
      }),
    ).toThrow(/fields must be exactly/u);
  });

  it("rejects query or prompt data outside the canonical handoff body", () => {
    const input = buildKwragP0TestHandoff();
    (input.expected as Record<string, unknown>).query = "must not cross the P0 boundary";

    expect(() =>
      verifyOptionalKwragP0Handoff({
        input,
        runId: "run-p0-1",
        sessionId: "session-p0-1",
      }),
    ).toThrow(/retrievalHandoff.expected fields must be exactly/u);
  });

  it("rejects a sibling slot boundary", () => {
    const input = buildKwragP0TestHandoff();
    input.expected.slotInstanceId = "slot-sibling";

    expect(() =>
      verifyOptionalKwragP0Handoff({
        input,
        runId: "run-p0-1",
        sessionId: "session-p0-1",
      }),
    ).toThrow(/same-slot read-only boundary/u);
  });

  it("is default-off and retains no handoff across a fresh module load", async () => {
    expect(
      verifyOptionalKwragP0Handoff({
        runId: "run-p0-1",
        sessionId: "session-p0-1",
      }),
    ).toBeNull();

    vi.resetModules();
    const fresh = await import("./kwrag-p0-handoff.js");
    expect(
      fresh.verifyOptionalKwragP0Handoff({
        runId: "run-p0-1",
        sessionId: "session-p0-1",
      }),
    ).toBeNull();
  });
});
