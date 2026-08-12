import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const stdinEndMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { createKwragIndexTool } from "./kwrag-index-tool.js";

describe("kwrag_index_build", () => {
  beforeEach(() => {
    process.env.JITECH_KWRAG_RUNTIME_PROFILE = "openclaw";
    execFileMock.mockReset();
    stdinEndMock.mockReset();
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
            schema_version: "kwrag-product-index-build-observation-v1",
            status: "activated",
            active_index_id: "release-2",
            previous_index_id: "release-1",
            receipt_status: "written",
            receipt_digest: "sha256:" + "1".repeat(64),
          }),
          "",
        );
        return { stdin: { end: stdinEndMock } };
      },
    );
  });

  afterEach(() => {
    delete process.env.JITECH_KWRAG_RUNTIME_PROFILE;
  });

  it("uses the fixed zero-argv build request without caller paths", async () => {
    const tool = createKwragIndexTool();
    if (!tool) {
      throw new Error("expected product tool");
    }
    const result = await tool.execute("call-1", {});
    expect(execFileMock).toHaveBeenCalledOnce();
    expect(execFileMock.mock.calls[0]?.[1]).toEqual([]);
    expect(JSON.parse(stdinEndMock.mock.calls[0]?.[0])).toEqual({
      schema_version: "kwrag-product-cli-request-v1",
      operation: "build_index",
      rebuild: true,
    });
    expect(result).toMatchObject({
      details: {
        status: "activated",
        active_index_id: "release-2",
        raw_content_present: false,
      },
    });
  });

  it("rejects an obsolete build response schema", async () => {
    execFileMock.mockImplementationOnce(
      (
        _path: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, JSON.stringify({ schema_version: "kwrag-product-cli-index-build-v1" }), "");
        return { stdin: { end: stdinEndMock } };
      },
    );
    const tool = createKwragIndexTool();
    if (!tool) {
      throw new Error("expected product tool");
    }
    await expect(tool.execute("call-2", {})).rejects.toThrow("RAG index refresh unavailable");
  });

  it("does not advertise the product tool outside the product runtime", () => {
    delete process.env.JITECH_KWRAG_RUNTIME_PROFILE;
    expect(createKwragIndexTool()).toBeNull();
  });
});
