import { beforeEach, describe, expect, it, vi } from "vitest";

const p1EvidenceMock = vi.hoisted(() => vi.fn());
vi.mock("./kwrag-p1-thin.js", () => ({
  prepareKwragP1EvidenceForExplicitScope: p1EvidenceMock,
}));

import { prepareKwragProductEvidenceForExplicitQuery } from "./kwrag-product.js";

const fakeEvidence = {
  handoff: { handoff: { handoffDigest: "sha256:" + "1".repeat(64) } },
  corpus: "kakao-user",
  expectedSourceGeneration: "sha256:" + "2".repeat(64),
  sourceSnapshotDigest: "sha256:" + "3".repeat(64),
  expectedIndexManifest: "sha256:" + "4".repeat(64),
  promptContext: "KWRAG verified turn evidence.",
  contextDigest: "sha256:" + "5".repeat(64),
  resultDigest: "sha256:" + "6".repeat(64),
  resultCount: 1,
  p1IdentityDigest: "sha256:" + "7".repeat(64),
  pipelineFingerprint: "sha256:" + "8".repeat(64),
};

describe("product-native retrieval caller adapter", () => {
  beforeEach(() => {
    p1EvidenceMock.mockReset();
    p1EvidenceMock.mockReturnValue(fakeEvidence);
  });

  it("passes the source-neutral scope to the fixed-producer seam", async () => {
    const evidence = await prepareKwragProductEvidenceForExplicitQuery({
      retrieval: {
        scope: {
          sources: ["kakao"],
          rooms: [{ source: "kakao", roomId: "kakao-user" }],
        },
        query: "납품 일정",
      },
      runId: "run-1",
      sessionId: "session-1",
    });

    expect(evidence).toBe(fakeEvidence);
    expect(p1EvidenceMock).toHaveBeenCalledOnce();
    expect(p1EvidenceMock).toHaveBeenCalledWith({
      retrieval: {
        query: "납품 일정",
        scope: {
          sources: ["kakao"],
          rooms: [{ source: "kakao", roomId: "kakao-user" }],
        },
      },
      runId: "run-1",
    });
  });

  it("rejects malformed scope before invoking the producer seam", async () => {
    await expect(
      prepareKwragProductEvidenceForExplicitQuery({
        retrieval: { scope: { sources: ["Kakao"] }, query: "query" },
        runId: "run-2",
        sessionId: "session-2",
      }),
    ).rejects.toThrow("scope source is invalid");
    expect(p1EvidenceMock).not.toHaveBeenCalled();
  });

  it("does not add the retired corpus field or caller-supplied identities", async () => {
    await prepareKwragProductEvidenceForExplicitQuery({
      retrieval: { scope: { sources: ["kakao"] }, query: "quality" },
      runId: "run-3",
      sessionId: "session-3",
    });
    const request = p1EvidenceMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request.retrieval).not.toHaveProperty("corpus");
    expect(request.retrieval).not.toHaveProperty("expected_source_generation");
    expect(request.retrieval).not.toHaveProperty("expected_index_manifest");
  });
});
