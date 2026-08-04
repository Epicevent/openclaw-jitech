import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stableStringify } from "./stable-stringify.js";

const execFileSyncMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());
const closeSyncMock = vi.hoisted(() => vi.fn());
const openRootFileSyncMock = vi.hoisted(() => vi.fn());
const agentCommandMock = vi.hoisted(() => vi.fn());
const ledgerMock = vi.hoisted(() => vi.fn());
const closeLedgerMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));
vi.mock("node:fs", () => ({ closeSync: closeSyncMock, readFileSync: readFileSyncMock }));
vi.mock("../infra/boundary-file-read.js", () => ({ openRootFileSync: openRootFileSyncMock }));
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => "00000000-0000-4000-8000-000000000001",
}));
vi.mock("../infra/git-commit.js", () => ({ resolveExactCommitHash: () => "f".repeat(40) }));
vi.mock("./agent-command.js", () => ({ agentCommand: agentCommandMock }));
vi.mock("./kwrag-p0-handoff.store.js", () => ({
  appendKwragP0EvidenceEvent: vi.fn(),
  closeKwragP0HandoffReceiptStore: closeLedgerMock,
  readKwragP0HandoffLedgerSnapshot: ledgerMock,
}));

import { readKwragP1AttachmentStatus, runKwragP1UserTurnProof } from "./kwrag-p1-thin.js";

const COMPONENT = "sha256:e471b4c3ef4258dff28b97f30ef81649dcf711a3b85b66a93da51f7704adac6a";
const CONTRACT = "sha256:6d637d1a2a3202d8feb4b59bc0fe2167900311930e01d5e9fb5651c8e5c8f288";
const DATABASE = `sha256:${"2".repeat(64)}`;
const MANIFEST = `sha256:${"3".repeat(64)}`;
const SOURCE = `sha256:${"4".repeat(64)}`;
const RUNTIME_PROFILE = `sha256:${"7".repeat(64)}`;
const RESOURCE_PROFILE = "sha256:2d4ff46a2d76e712421a9758ecb0ae1d262e2d42ea00cee888c103477e6709ed";
const OPERATION = `sha256:${"8".repeat(64)}`;
const PRODUCER_RECEIPT = `sha256:${"9".repeat(64)}`;
const SOURCE_EXCHANGE = `sha256:${"a".repeat(64)}`;
const PIPELINE = "sha256:53e14752cc9d147dfb4129e00234d1c7fb9f6558df00da7c03189db8da8e4606";
const FACTORY = "sha256:0dbe54f5a8bc56a6c821e181a0dc6cfda85d25be8cea6a01235cb5e347782f0e";
const DECISION = "sha256:81e6f4d83e6cde6a9c83a9aa435c65354a1122dded735bf607462c3497e9b25d";
const QUERY = "actual user ask";

function authorityReceipt() {
  return {
    schema: "kwrag-read-only-authority-receipt/v1",
    status: "observed",
    slot: "oc14",
    family: "openclaw",
    containerNasRoot: "/home/node/nas_docs",
    releaseRelativeRoot: "kw/package/.kwrag/releases/release",
    indexManifestDigest: MANIFEST,
    mountReadOnly: true,
    allBoundFilesReadOnly: true,
  };
}
const AUTHORITY = `sha256:${createHash("sha256")
  .update(stableStringify(authorityReceipt()))
  .digest("hex")}`;

function fixedBinding(enabled: boolean) {
  return {
    schema_version: "kwrag-fixed-producer-binding-v1",
    enabled,
    mount_root: "/home/node/nas_docs",
    index_manifest_relative: "kw/package/.kwrag/releases/release/index-manifest.json",
    index_manifest_digest: MANIFEST,
    operation_receipt_path: "/home/node/.openclaw/kwrag/operation-receipts.jsonl",
    producer_receipt_path: "/home/node/.openclaw/kwrag/producer-receipts.jsonl",
    max_concurrent: 1,
    selected_engine: {},
    corpora: {
      room: {
        database_relative: "kw/package/.kwrag/releases/release/room.sqlite3",
        database_sha256: DATABASE,
        source_snapshot_relative: "kw/package/.kwrag/releases/release/room-source.json",
        source_snapshot_digest: SOURCE,
        authority_receipt_digest: AUTHORITY,
      },
    },
  };
}
const RUNTIME_BINDING = `sha256:${createHash("sha256")
  .update(stableStringify(fixedBinding(true)))
  .digest("hex")}`;

function productBinding(enabled: boolean) {
  return {
    schema: "agent-runtime-retrieval-binding/v2",
    proofMode: "attachment_only",
    enabled,
    family: "openclaw",
    instanceId: "oc14",
    runtimeProfileDigest: RUNTIME_PROFILE,
    containerNasRoot: "/home/node/nas_docs",
    transport: "in_process",
    hostPortCount: 0,
    mountReadOnly: true,
    componentDigest: COMPONENT,
    contractDigest: CONTRACT,
    resourceProfileDigest: RESOURCE_PROFILE,
    p1Identity: {
      status: "research_selected_p1_attachment_probe_candidate",
      pipelineFactoryDigest: FACTORY,
      backendId: "slot-local-fts5-trigram-or-attachment-v1",
      pipelineFingerprint: PIPELINE,
      researchDecisionDigest: DECISION,
    },
    attachmentData: enabled
      ? {
          databaseSha256: DATABASE,
          indexManifestDigest: MANIFEST,
          sourceSnapshotDigest: SOURCE,
          readOnlyAuthorityReceiptDigest: AUTHORITY,
          slotRuntimeBindingDigest: RUNTIME_BINDING,
        }
      : null,
  };
}

function installBindings(
  enabled: boolean,
  mountMode: "ro" | "rw" = "ro",
  authorityValue = authorityReceipt(),
) {
  const product = stableStringify(productBinding(enabled));
  const fixed = stableStringify(fixedBinding(enabled));
  const proof = stableStringify({
    schema: "kwrag-two-canary-private-proof-request/v1",
    corpus: "room",
    query: QUERY,
  });
  const authority = stableStringify(authorityValue);
  readFileSyncMock.mockImplementation((path: string | number) => {
    if (path === 42) {
      return product;
    }
    if (path === 43) {
      return fixed;
    }
    if (path === 44) {
      return proof;
    }
    if (path === 45) {
      return authority;
    }
    if (path === "/proc/self/mountinfo") {
      return `11 1 0:1 / /home/node/nas_docs ${mountMode},relatime - ext4 /dev/test rw\n`;
    }
    throw new Error(`unexpected read ${path}`);
  });
  openRootFileSyncMock.mockImplementation(({ absolutePath }) => {
    const entries: Record<string, [number, string]> = {
      "/run/kwrag/attachment-binding-v2.json": [42, product],
      "/run/kwrag/fixed-producer-binding.json": [43, fixed],
      "/run/kwrag/proof-request.json": [44, proof],
      "/run/kwrag/read-only-authority.json": [45, authority],
    };
    const entry = entries[String(absolutePath)];
    if (!entry) {
      throw new Error(`unexpected open ${absolutePath}`);
    }
    return {
      ok: true,
      fd: entry[0],
      path: absolutePath,
      rootRealPath: "/run/kwrag",
      stat: {
        isFile: () => true,
        nlink: 1,
        mode: 0o100444,
        uid: 0,
        size: Buffer.byteLength(entry[1]),
      },
    };
  });
}

function fixedOutput(
  request: Record<string, unknown>,
  mutate?: (value: Record<string, unknown>) => void,
) {
  const results = [
    {
      corpus: "room",
      id: "1",
      path: "p",
      score: 1,
      snippet: "evidence",
      source_ids: [],
      title: "t",
    },
  ];
  const resultDigest = `sha256:${createHash("sha256").update(stableStringify(results)).digest("hex")}`;
  const value: Record<string, unknown> = {
    schema_version: "kwrag-fixed-producer-output-v1",
    consumable: {
      schema_version: "kwrag-fixed-consumable-v1",
      request_id: request.request_id,
      operation_id: request.operation_id,
      run_id: request.run_id,
      attempt: 1,
      index_manifest: MANIFEST,
      pipeline_fingerprint: PIPELINE,
      result_status: "hits",
      results,
    },
    linkage: {
      operation_receipt_digest: OPERATION,
      result_digest: resultDigest,
      source_exchange_digest: SOURCE_EXCHANGE,
      producer_receipt_digest: PRODUCER_RECEIPT,
    },
  };
  mutate?.(value);
  return stableStringify(value);
}

describe("KWRAG P1 fixed-producer thin adapter", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    readFileSyncMock.mockReset();
    closeSyncMock.mockReset();
    openRootFileSyncMock.mockReset();
    agentCommandMock.mockReset();
    ledgerMock.mockReset();
    closeLedgerMock.mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("emits exact Decision A disabled truth from both current fixed bindings", () => {
    installBindings(false);
    expect(readKwragP1AttachmentStatus()).toMatchObject({
      schema: "jitech-embedded-retrieval-attachment-status/v1",
      enabled: false,
      componentDigest: COMPONENT,
      resourceProfileDigest: RESOURCE_PROFILE,
      attachmentDataDigest: null,
      mountReadOnly: true,
      attachmentHealth: "disabled",
      resourceStatus: "unavailable",
      consumptionStatus: "not_applicable",
      revocationStatus: "complete",
    });
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("links enabled status to the current same-slot P0 receipt", () => {
    installBindings(true);
    ledgerMock.mockReturnValueOnce({
      latest: {
        receipt: {
          productSourceCommit: "f".repeat(40),
          slotInstanceId: "oc14",
          mountAuthorityDigest: AUTHORITY,
          slotRuntimeBindingDigest: RUNTIME_BINDING,
          operationReceiptDigest: OPERATION,
          resultReceiptDigest: `sha256:${"e".repeat(64)}`,
          consumptionReceiptDigest: `sha256:${"f".repeat(64)}`,
        },
      },
    });
    expect(readKwragP1AttachmentStatus()).toMatchObject({
      enabled: true,
      attachmentHealth: "healthy",
      resourceStatus: "within_declared_reservation",
      consumptionStatus: "not_consumed",
      linkageStatus: "complete",
    });
  });

  it("rejects fixed producer binding drift before product or provider dispatch", () => {
    installBindings(true);
    const drifted = stableStringify({
      ...fixedBinding(true),
      index_manifest_digest: `sha256:${"f".repeat(64)}`,
    });
    readFileSyncMock.mockImplementation((path: string | number) => {
      if (path === 42) {
        return stableStringify(productBinding(true));
      }
      if (path === 43) {
        return drifted;
      }
      if (path === "/proc/self/mountinfo") {
        return "11 1 0:1 / /home/node/nas_docs ro,relatime - ext4 /dev/test rw\n";
      }
      throw new Error(`unexpected read ${path}`);
    });
    expect(() => readKwragP1AttachmentStatus()).toThrow(/fixed producer binding/u);
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it("rejects live authority drift before product or provider dispatch", () => {
    installBindings(true, "ro", { ...authorityReceipt(), mountReadOnly: false });
    expect(() => readKwragP1AttachmentStatus()).toThrow(/read-only authority/u);
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it.each(["rw", "noncanonical"])("fails closed for %s binding truth", (variant) => {
    installBindings(false, variant === "rw" ? "rw" : "ro");
    if (variant === "noncanonical") {
      readFileSyncMock.mockImplementation((path: string | number) => {
        if (path === "/proc/self/mountinfo") {
          return "11 1 0:1 / /home/node/nas_docs ro - ext4 /dev/test rw\n";
        }
        return `${JSON.stringify(productBinding(false))}\n`;
      });
    }
    expect(() => readKwragP1AttachmentStatus()).toThrow(/binding|invalid or stale/u);
  });

  it("runs exact fixed producer stdin through the actual user-turn caller and receipt chain", async () => {
    installBindings(true);
    execFileSyncMock.mockImplementation((_path, _args, options) =>
      fixedOutput(JSON.parse(options.input as string)),
    );
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "answer" }], meta: {} });
    ledgerMock.mockImplementation((_env, runId) => {
      const call = agentCommandMock.mock.calls[0]?.[0];
      const evidence = call.retrievalEvidence;
      return {
        latest: {
          receipt: {
            runId,
            sessionId: call.sessionId,
            resultReceiptDigest: evidence.resultDigest,
          },
        },
        latestEvidenceEvents: [
          {
            stage: "evidence_dispatch_handoff_committed",
            consumptionStatus: "evidence_dispatch_handoff_committed",
            receiptDigest: OPERATION,
          },
          {
            stage: "response_observed",
            consumptionStatus: "response_observed",
            receiptDigest: PRODUCER_RECEIPT,
          },
        ],
      };
    });

    await expect(runKwragP1UserTurnProof()).resolves.toMatchObject({
      enabled: true,
      retrievalCount: 1,
      projectionCount: 1,
      dispatchCount: 1,
      responseObservedCount: 1,
    });
    expect(execFileSyncMock).toHaveBeenCalledOnce();
    expect(execFileSyncMock.mock.calls[0]?.[0]).toBe("/opt/jitech/kwrag/bin/kwrag-fixed-producer");
    expect(execFileSyncMock.mock.calls[0]?.[1]).toEqual([]);
    expect(JSON.parse(execFileSyncMock.mock.calls[0]?.[2].input)).toMatchObject({
      schema_version: "kwrag-slot-search-request-v1",
      query: QUERY,
      corpus: "room",
    });
    expect(agentCommandMock).toHaveBeenCalledOnce();
    expect(agentCommandMock.mock.calls[0]?.[0]).toMatchObject({
      message: QUERY,
      transcriptMessage: QUERY,
      retrievalEvidence: { resultCount: 1 },
    });
    expect(closeLedgerMock).toHaveBeenCalledOnce();
  });

  it("rejects producer correlation tamper before the actual user-turn caller", async () => {
    installBindings(true);
    execFileSyncMock.mockImplementation((_path, _args, options) =>
      fixedOutput(JSON.parse(options.input as string), (output) => {
        (output.consumable as Record<string, unknown>).run_id = "foreign-run";
      }),
    );
    await expect(runKwragP1UserTurnProof()).rejects.toThrow(/producer output/u);
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("keeps zero-hit output outside the positive attachment proof without dispatching", async () => {
    installBindings(true);
    execFileSyncMock.mockImplementation((_path, _args, options) =>
      fixedOutput(JSON.parse(options.input as string), (output) => {
        const consumable = output.consumable as Record<string, unknown>;
        const linkage = output.linkage as Record<string, unknown>;
        consumable.result_status = "zero_hits";
        consumable.results = [];
        linkage.result_digest = `sha256:${createHash("sha256").update("[]").digest("hex")}`;
      }),
    );
    await expect(runKwragP1UserTurnProof()).rejects.toThrow(/producer output/u);
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("sanitizes producer failures", async () => {
    installBindings(true);
    execFileSyncMock.mockImplementation(() => {
      throw new Error("SECRET_STDERR_VALUE");
    });
    await expect(runKwragP1UserTurnProof()).rejects.toThrow(/fixed producer execution failed/u);
    await expect(runKwragP1UserTurnProof()).rejects.not.toThrow(/SECRET_STDERR_VALUE/u);
  });

  it("keeps retrieval, projection, and dispatch at zero after disabled restart", async () => {
    installBindings(false);
    await expect(runKwragP1UserTurnProof()).resolves.toMatchObject({
      enabled: false,
      retrievalCount: 0,
      projectionCount: 0,
      dispatchCount: 0,
      responseObservedCount: 0,
    });
    vi.resetModules();
    const restarted = await import("./kwrag-p1-thin.js");
    await expect(restarted.runKwragP1UserTurnProof()).resolves.toMatchObject({
      enabled: false,
      retrievalCount: 0,
      projectionCount: 0,
      dispatchCount: 0,
      responseObservedCount: 0,
    });
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();
  });
});
