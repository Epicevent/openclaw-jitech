import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const stdinEndMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { prepareKwragProductEvidenceForExplicitQuery } from "./kwrag-product.js";
import { stableStringify } from "./stable-stringify.js";

function sha(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function validExchange() {
  const identity = {
    slot_namespace: "openclaw",
    index_manifest: "sha256:" + "1".repeat(64),
    pipeline_fingerprint: "sha256:" + "2".repeat(64),
  };
  const response: Record<string, unknown> = {
    index_manifest: identity.index_manifest,
    pipeline_fingerprint: identity.pipeline_fingerprint,
    result_status: "hits",
    results: [{ source_id: "source-1", score: 0.9 }],
  };
  response.result_digest = sha(response.results);
  const operation = {
    authorization_basis: "slot_mounted_storage",
    index_manifest: identity.index_manifest,
    pipeline_fingerprint: identity.pipeline_fingerprint,
    result_digest: response.result_digest,
    pipeline_evidence: {
      stages: [
        { stage_id: "query_embedding" },
        { stage_id: "dense_index_search" },
        { stage_id: "candidate_rerank" },
      ],
    },
  };
  response.operation_receipt = { status: "written", digest: sha(operation) };
  return {
    schema_version: "kwrag-product-cli-search-exchange-v1",
    identity,
    response,
    operation_receipt: operation,
  };
}

describe("product-native live-corpus retrieval", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    stdinEndMock.mockReset();
    execFileMock.mockImplementation(
      (
        _path: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, JSON.stringify(validExchange()), "");
        return { stdin: { end: stdinEndMock } };
      },
    );
  });

  it("uses the zero-argv request envelope and maps a verified exchange", async () => {
    const evidence = await prepareKwragProductEvidenceForExplicitQuery({
      retrieval: {
        scope: { sources: ["kakao"], rooms: [{ source: "kakao", roomId: "kakao-user" }] },
        query: "지난 회의",
      },
      runId: "run-1",
      sessionId: "session-1",
    });

    expect(execFileMock).toHaveBeenCalledOnce();
    expect(execFileMock.mock.calls[0]?.[1]).toEqual([]);
    expect(JSON.parse(stdinEndMock.mock.calls[0]?.[0])).toMatchObject({
      schema_version: "kwrag-product-cli-request-v1",
      operation: "search",
      scope: {
        sources: ["kakao"],
        rooms: [{ source: "kakao", room_id: "kakao-user" }],
      },
      query: "지난 회의",
    });
    expect(JSON.parse(stdinEndMock.mock.calls[0]?.[0])).not.toHaveProperty("corpus");
    expect(evidence.runtimeMode).toBe("live_corpus");
    expect(evidence.expectedIndexManifest).toBe("sha256:" + "1".repeat(64));
    expect(evidence.resultCount).toBe(1);
    expect(evidence.handoff.handoff).toMatchObject({ consumption: { status: "not_consumed" } });
  });

  it("fails closed when the exchange identity and operation receipt do not agree", async () => {
    const exchange = validExchange();
    exchange.response.operation_receipt = { status: "written", digest: "sha256:" + "9".repeat(64) };
    execFileMock.mockImplementationOnce(
      (
        _path: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, JSON.stringify(exchange), "");
        return { stdin: { end: stdinEndMock } };
      },
    );

    await expect(
      prepareKwragProductEvidenceForExplicitQuery({
        retrieval: { scope: { sources: ["kakao"] }, query: "질문" },
        runId: "run-2",
        sessionId: "session-2",
      }),
    ).rejects.toThrow("product search exchange is invalid");
  });

  it("keeps generic source scope on the wire without the legacy corpus field", async () => {
    await prepareKwragProductEvidenceForExplicitQuery({
      retrieval: {
        scope: {
          sources: ["groupware", "whatsapp"],
          rooms: [{ source: "groupware", roomId: "mail-room" }],
        },
        query: "보안 정책",
      },
      runId: "run-generic-1",
      sessionId: "session-generic-1",
    });

    expect(JSON.parse(stdinEndMock.mock.calls[0]?.[0])).toMatchObject({
      schema_version: "kwrag-product-cli-request-v1",
      operation: "search",
      scope: {
        sources: ["groupware", "whatsapp"],
        rooms: [{ source: "groupware", room_id: "mail-room" }],
      },
    });
    expect(JSON.parse(stdinEndMock.mock.calls[0]?.[0])).not.toHaveProperty("corpus");
  });
});
