import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { createKwragIndexTool } from "./kwrag-index-tool.js";

describe("kwrag_index_build", () => {
  beforeEach(() => {
    process.env.JITECH_KWRAG_RUNTIME_PROFILE = "openclaw";
    execFileMock.mockReset();
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
            schema_version: "kwrag-product-cli-index-build-v1",
            status: "activated",
            active_index_id: "release-2",
            previous_index_id: "release-1",
            receipt_status: "written",
            receipt_digest: "sha256:" + "1".repeat(64),
          }),
          "",
        );
        return { stdin: { end: vi.fn() } };
      },
    );
  });

  afterEach(() => {
    delete process.env.JITECH_KWRAG_RUNTIME_PROFILE;
  });

  it("uses the fixed shell-free refresh command with no caller path", async () => {
    const tool = createKwragIndexTool();
    const result = await tool.execute("call-1", {});
    expect(execFileMock).toHaveBeenCalledOnce();
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(["index-build"]);
    expect(result).toMatchObject({
      details: {
        status: "activated",
        active_index_id: "release-2",
        raw_content_present: false,
      },
    });
  });

  it("does not advertise the product tool outside the product runtime", () => {
    delete process.env.JITECH_KWRAG_RUNTIME_PROFILE;
    expect(createKwragIndexTool()).toBeNull();
  });
});
