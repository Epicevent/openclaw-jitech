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

describe("product-native live-corpus retrieval", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    stdinEndMock.mockReset();
    const runtime = {
      slot_namespace: "openclaw",
      mount_read_only: true,
      index_manifest: "sha256:" + "1".repeat(64),
      pipeline_fingerprint: "sha256:" + "2".repeat(64),
      source_state_sha256: "sha256:" + "3".repeat(64),
    };
    const response: Record<string, unknown> = {
      index_manifest: runtime.index_manifest,
      pipeline_fingerprint: runtime.pipeline_fingerprint,
      result_status: "hits",
      results: [{ source_id: "source-1", score: 0.9 }],
    };
    response.result_digest = sha(response.results);
    execFileMock.mockImplementation(
      (
        _path: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(
          null,
          JSON.stringify({
            schema_version: "kwrag-product-cli-search-v1",
            status: "ok",
            response,
            runtime_observation: runtime,
            runtime_digest: sha(runtime),
            operation_receipt_observation: {
              status: "written",
              digest: "sha256:" + "5".repeat(64),
            },
          }),
          "",
        );
        return { stdin: { end: stdinEndMock } };
      },
    );
  });

  it("uses only the fixed product CLI and binds the live observation", async () => {
    const evidence = await prepareKwragProductEvidenceForExplicitQuery({
      retrieval: { corpus: "kakao", query: "지난 회의" },
      runId: "run-1",
      sessionId: "session-1",
    });

    expect(execFileMock).toHaveBeenCalledOnce();
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(["search"]);
    expect(JSON.parse(stdinEndMock.mock.calls[0]?.[0])).toMatchObject({
      corpus: "kakao",
      query: "지난 회의",
    });
    expect(JSON.parse(stdinEndMock.mock.calls[0]?.[0])).not.toHaveProperty(
      "expected_source_generation",
    );
    expect(evidence.runtimeMode).toBe("live_corpus");
    expect(evidence.expectedSourceGeneration).toBe("sha256:" + "3".repeat(64));
    expect(evidence.expectedIndexManifest).toBe("sha256:" + "1".repeat(64));
    expect(evidence.resultCount).toBe(1);
    expect(evidence.handoff.handoff).toMatchObject({
      consumption: { status: "not_consumed" },
    });
  });

  it("fails closed when the mounted corpus is not read-only", async () => {
    execFileMock.mockImplementationOnce(
      (
        _path: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(
          null,
          JSON.stringify({
            schema_version: "kwrag-product-cli-search-v1",
            status: "ok",
            response: {
              index_manifest: "sha256:" + "1".repeat(64),
              pipeline_fingerprint: "sha256:" + "2".repeat(64),
              result_status: "hits",
              result_digest: "sha256:" + "4".repeat(64),
              results: [{ source_id: "source-1" }],
            },
            runtime_observation: {
              slot_namespace: "openclaw",
              mount_read_only: false,
              index_manifest: "sha256:" + "1".repeat(64),
              pipeline_fingerprint: "sha256:" + "2".repeat(64),
              source_state_sha256: "sha256:" + "3".repeat(64),
            },
            runtime_digest: "sha256:" + "6".repeat(64),
            operation_receipt_observation: {
              status: "written",
              digest: "sha256:" + "5".repeat(64),
            },
          }),
          "",
        );
        return { stdin: { end: stdinEndMock } };
      },
    );

    await expect(
      prepareKwragProductEvidenceForExplicitQuery({
        retrieval: { corpus: "kakao", query: "질문" },
        runId: "run-2",
        sessionId: "session-2",
      }),
    ).rejects.toThrow("runtime observation is invalid");
  });
});
