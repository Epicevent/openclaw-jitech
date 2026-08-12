import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

import { createKwragIndexTool } from "./kwrag-index-tool.js";

describe("kwrag_index_build", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        schema_version: "kwrag-product-cli-index-build-v1",
        status: "activated",
        active_index_id: "release-2",
        previous_index_id: "release-1",
        receipt_status: "written",
        receipt_digest: "sha256:" + "1".repeat(64),
      }),
    );
  });

  it("uses the fixed shell-free refresh command with no caller path", async () => {
    const tool = createKwragIndexTool();
    const result = await tool.execute("call-1", {});
    expect(execFileSyncMock).toHaveBeenCalledOnce();
    expect(execFileSyncMock.mock.calls[0]?.[1]).toEqual(["index-build"]);
    expect(execFileSyncMock.mock.calls[0]?.[2].input).toBe("{}\n");
    expect(result).toMatchObject({
      details: {
        status: "activated",
        active_index_id: "release-2",
        raw_content_present: false,
      },
    });
  });
});
