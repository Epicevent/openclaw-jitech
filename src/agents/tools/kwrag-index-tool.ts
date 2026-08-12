import { execFile } from "node:child_process";
import { Type } from "typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

const CLI = process.env.JITECH_KWRAG_PRODUCT_CLI ?? "/opt/jitech/kwrag/bin/kwrag-product";

/**
 * Explicit operator/user action only. Searching never refreshes the index and
 * this tool never accepts a path, digest, or release chosen by the caller.
 */
export function createKwragIndexTool(): AnyAgentTool | null {
  if (process.env.JITECH_KWRAG_RUNTIME_PROFILE !== "openclaw") {
    return null;
  }
  return {
    label: "Kakao RAG index",
    name: "kwrag_index_build",
    displaySummary: "Refresh the disposable index from the mounted Kakao corpus.",
    description:
      "Call only when the user explicitly asks to index or refresh the mounted Kakao corpus. " +
      "Do not call for an ordinary question or to invent a query. The source is the slot's " +
      "read-only mount; the index is rebuilt in Workspace.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (_toolCallId, _params, signal) => {
      try {
        const raw = await new Promise<string>((resolve, reject) => {
          const child = execFile(
            CLI,
            ["index-build"],
            {
              encoding: "utf8",
              maxBuffer: 256 * 1024,
              timeout: 120_000,
              windowsHide: true,
              signal,
            },
            (error, stdout) => {
              if (error) {
                reject(error);
              } else {
                resolve(stdout);
              }
            },
          );
          child.stdin?.end("{}\n");
        });
        const output = JSON.parse(raw) as Record<string, unknown>;
        if (output.schema_version !== "kwrag-product-cli-index-build-v1") {
          throw new Error("index_build_output_invalid");
        }
        if (output.status !== "activated" && output.status !== "unchanged") {
          throw new Error("index_build_not_ready");
        }
        return jsonResult({
          status: output.status ?? "unknown",
          active_index_id: output.active_index_id ?? null,
          previous_index_id: output.previous_index_id ?? null,
          receipt_status: output.receipt_status ?? null,
          receipt_digest: output.receipt_digest ?? null,
          raw_content_present: false,
        });
      } catch {
        throw new ToolInputError("Kakao RAG index refresh unavailable; no provider call was made.");
      }
    },
  };
}
