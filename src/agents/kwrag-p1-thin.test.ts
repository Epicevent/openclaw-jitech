import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildKwragP0TestHandoff } from "./kwrag-p0-handoff.fixture.js";
import { digestKwragP0Canonical } from "./kwrag-p0-handoff.js";

const execFileSyncMock = vi.hoisted(() => vi.fn());
const agentCommandMock = vi.hoisted(() => vi.fn());
const ledgerMock = vi.hoisted(() => vi.fn());
const closeLedgerMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));
vi.mock("../infra/git-commit.js", () => ({
  resolveExactCommitHash: () => "f".repeat(40),
}));
vi.mock("./agent-command.js", () => ({ agentCommand: agentCommandMock }));
vi.mock("./kwrag-p0-handoff.store.js", () => ({
  closeKwragP0HandoffReceiptStore: closeLedgerMock,
  readKwragP0HandoffLedgerSnapshot: ledgerMock,
}));

import { readKwragP1AttachmentStatus, runKwragP1UserTurnProof } from "./kwrag-p1-thin.js";

const BINDING = `sha256:${"1".repeat(64)}`;
const DATABASE = `sha256:${"2".repeat(64)}`;
const MANIFEST = `sha256:${"3".repeat(64)}`;
const SOURCE = `sha256:${"4".repeat(64)}`;
const AUTHORITY = `sha256:${"5".repeat(64)}`;
const RUNTIME_BINDING = `sha256:${"6".repeat(64)}`;
const RUNTIME_PROFILE = `sha256:${"7".repeat(64)}`;
const RESOURCE_PROFILE = `sha256:${"d".repeat(64)}`;
const COMPONENT = "sha256:6578b61f91151d6cfa2d6a100397a409a6293c1396ce957cd7e87cf0da74e811";
const P1_IDENTITY = "sha256:c74c42fd7931326f543398631287db40c0b9cdd7a159eb2d0931c1f724575b1a";

function observation(enabled: boolean) {
  return {
    schema: "jitech-openclaw-kwrag-p1-observation/v1",
    enabled,
    instanceId: "oc14",
    runtimeProfileDigest: RUNTIME_PROFILE,
    componentDigest: COMPONENT,
    bindingDigest: BINDING,
    resourceProfileDigest: RESOURCE_PROFILE,
    p1IdentityDigest: P1_IDENTITY,
    attachmentData: enabled
      ? {
          databaseSha256: DATABASE,
          indexManifestDigest: MANIFEST,
          sourceSnapshotDigest: SOURCE,
          readOnlyAuthorityReceiptDigest: AUTHORITY,
          slotRuntimeBindingDigest: RUNTIME_BINDING,
        }
      : null,
    mountReadOnly: true,
  };
}

function latestReceipt() {
  return {
    ledgerSeq: 1,
    receipt: {
      operationId: "p1att.operation-1",
      productSourceCommit: "f".repeat(40),
      slotInstanceId: "oc14",
      mountAuthorityDigest: AUTHORITY,
      slotRuntimeBindingDigest: RUNTIME_BINDING,
      operationReceiptDigest: `sha256:${"8".repeat(64)}`,
      resultReceiptDigest: `sha256:${"9".repeat(64)}`,
      consumptionReceiptDigest: `sha256:${"a".repeat(64)}`,
      receiptDigest: `sha256:${"b".repeat(64)}`,
    },
  };
}

function refreshHandoffDigest(handoff: ReturnType<typeof buildKwragP0TestHandoff>) {
  const body = handoff.handoff as Record<string, unknown>;
  body.handoffDigest = digestKwragP0Canonical(
    Object.fromEntries(Object.entries(body).filter(([key]) => key !== "handoffDigest")),
  );
}

function currentBindingHandoff() {
  const handoff = buildKwragP0TestHandoff((body) => {
    body.slotInstanceId = "oc14";
    body.mountAuthorityDigest = AUTHORITY;
    body.slotRuntimeBindingDigest = RUNTIME_BINDING;
  });
  Object.assign(handoff.expected, {
    slotInstanceId: "oc14",
    mountAuthorityDigest: AUTHORITY,
    slotRuntimeBindingDigest: RUNTIME_BINDING,
  });
  refreshHandoffDigest(handoff);
  return handoff;
}

describe("KWRAG P1 thin product adapter", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_KWRAG_P1_RUNTIME_PROFILE_DIGEST", RUNTIME_PROFILE);
    vi.stubEnv("OPENCLAW_STATE_DIR", "/fixed-state");
    execFileSyncMock.mockReset();
    agentCommandMock.mockReset();
    ledgerMock.mockReset();
    closeLedgerMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits exact Decision A disabled truth only after a fresh fixed observation", () => {
    execFileSyncMock.mockReturnValueOnce(JSON.stringify(observation(false)));

    const status = readKwragP1AttachmentStatus();

    expect(Object.keys(status)).toHaveLength(19);
    expect(status).toMatchObject({
      schema: "jitech-embedded-retrieval-attachment-status/v1",
      proofMode: "attachment_only",
      enabled: false,
      componentDigest: COMPONENT,
      bindingDigest: BINDING,
      resourceProfileDigest: RESOURCE_PROFILE,
      p1IdentityDigest: P1_IDENTITY,
      attachmentDataDigest: null,
      hostPortCount: 0,
      mountReadOnly: true,
      attachmentHealth: "disabled",
      resourceStatus: "unavailable",
      gpuAccessStatus: "none",
      operationReceiptDigest: null,
      resultReceiptDigest: null,
      consumptionReceiptDigest: null,
      consumptionStatus: "not_applicable",
      linkageStatus: "not_applicable",
      revocationStatus: "complete",
    });
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("links enabled status only to the current binding and actual-engine P0 receipt", () => {
    execFileSyncMock.mockReturnValueOnce(JSON.stringify(observation(true)));
    ledgerMock.mockReturnValueOnce({ latest: latestReceipt() });

    expect(readKwragP1AttachmentStatus()).toMatchObject({
      enabled: true,
      attachmentHealth: "healthy",
      resourceStatus: "within_declared_reservation",
      consumptionStatus: "not_consumed",
      linkageStatus: "complete",
      revocationStatus: null,
      operationReceiptDigest: `sha256:${"8".repeat(64)}`,
    });
  });

  it.each([
    ["writable mount", { mountReadOnly: false }],
    ["stale runtime", { runtimeProfileDigest: `sha256:${"c".repeat(64)}` }],
    ["erased capability", { componentDigest: null }],
  ])("fails closed for %s", (_label, mutation) => {
    execFileSyncMock.mockReturnValueOnce(JSON.stringify({ ...observation(false), ...mutation }));

    expect(() => readKwragP1AttachmentStatus()).toThrow(/invalid or stale/u);
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("never propagates adapter stderr or exception text", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("SECRET_STDERR_VALUE");
    });

    expect(() => readKwragP1AttachmentStatus()).toThrow(/adapter execution failed/u);
    expect(() => readKwragP1AttachmentStatus()).not.toThrow(/SECRET_STDERR_VALUE/u);
  });

  it("uses only the fixed source-owned producer argv", () => {
    execFileSyncMock.mockReturnValueOnce(JSON.stringify(observation(false)));

    readKwragP1AttachmentStatus();

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "/opt/jitech/kwrag/bin/openclaw-p1-evidence",
      ["observe"],
      { encoding: "utf8", maxBuffer: 256 * 1024, timeout: 30_000 },
    );
  });

  it("runs verified hits through the actual user-turn caller and requires the dispatch-response chain", async () => {
    const handoff = currentBindingHandoff();
    const canonicalResults =
      '[{"corpus":"room","id":"1","path":"p","score":1,"snippet":"evidence","source_ids":[],"title":"t"}]';
    const resultDigest = `sha256:${createHash("sha256").update(canonicalResults).digest("hex")}`;
    (handoff.handoff as { result: { receiptDigest: string } }).result.receiptDigest = resultDigest;
    refreshHandoffDigest(handoff);
    const receipts = [
      { stage: "evidence_dispatch_handoff_committed", receiptDigest: `sha256:${"8".repeat(64)}` },
      { stage: "response_observed", receiptDigest: `sha256:${"9".repeat(64)}` },
    ];
    execFileSyncMock.mockReturnValueOnce(JSON.stringify(observation(true))).mockReturnValueOnce(
      JSON.stringify({
        schema: "jitech-openclaw-kwrag-p1-retrieval/v1",
        sessionId: "p1-session",
        runId: "p1-run",
        query: "actual user ask",
        canonicalResults,
        resultDigest,
        resultCount: 1,
        p1IdentityDigest: P1_IDENTITY,
        handoff,
      }),
    );
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "answer" }], meta: {} });
    const handoffDigest = (handoff.handoff as { handoffDigest: string }).handoffDigest;
    ledgerMock.mockReturnValueOnce({
      latest: {
        receipt: {
          handoffDigest,
          runId: "p1-run",
          sessionId: "p1-session",
          resultReceiptDigest: resultDigest,
        },
      },
      latestEvidenceEvents: receipts,
    });

    await expect(runKwragP1UserTurnProof()).resolves.toMatchObject({
      schema: "jitech-openclaw-kwrag-user-turn-proof/v1",
      retrievalCount: 1,
      projectionCount: 1,
      dispatchCount: 1,
      responseObservedCount: 1,
      receipts,
    });
    expect(agentCommandMock).toHaveBeenCalledOnce();
    expect(closeLedgerMock).toHaveBeenCalledOnce();
    expect(agentCommandMock.mock.calls[0]?.[0]).toMatchObject({
      runId: "p1-run",
      message: "actual user ask",
      transcriptMessage: "actual user ask",
      retrievalEvidence: { handoff, resultDigest, resultCount: 1 },
    });
    expect(ledgerMock).toHaveBeenCalledWith(process.env, "p1-run");
  });

  it("rejects a valid foreign-slot handoff before the actual user-turn caller", async () => {
    const handoff = currentBindingHandoff();
    (handoff.handoff as Record<string, unknown>).slotInstanceId = "sibling-slot";
    const body = handoff.handoff as Record<string, unknown>;
    const canonicalResults = '[{"id":"1"}]';
    const resultDigest = `sha256:${createHash("sha256").update(canonicalResults).digest("hex")}`;
    (body.result as { receiptDigest: string }).receiptDigest = resultDigest;
    refreshHandoffDigest(handoff);
    execFileSyncMock.mockReturnValueOnce(JSON.stringify(observation(true))).mockReturnValueOnce(
      JSON.stringify({
        schema: "jitech-openclaw-kwrag-p1-retrieval/v1",
        sessionId: "p1-session",
        runId: "p1-run",
        query: "actual user ask",
        canonicalResults,
        resultDigest,
        resultCount: 1,
        p1IdentityDigest: P1_IDENTITY,
        handoff,
      }),
    );

    await expect(runKwragP1UserTurnProof()).rejects.toThrow(/retrieval output is invalid/u);
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("keeps retrieval, projection, and dispatch at zero after disabled restart", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify(observation(false)));

    await expect(runKwragP1UserTurnProof()).resolves.toMatchObject({
      enabled: false,
      retrievalCount: 0,
      projectionCount: 0,
      dispatchCount: 0,
      responseObservedCount: 0,
      receipts: [],
    });
    vi.resetModules();
    const restarted = await import("./kwrag-p1-thin.js");
    await expect(restarted.runKwragP1UserTurnProof()).resolves.toMatchObject({
      enabled: false,
      retrievalCount: 0,
      projectionCount: 0,
      dispatchCount: 0,
      responseObservedCount: 0,
      receipts: [],
    });
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(ledgerMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });
});
