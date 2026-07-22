import {
  getDiagnosticStabilitySnapshot,
  normalizeDiagnosticStabilityQuery,
} from "../../logging/diagnostic-stability.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function clamp(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value.length > max ? `${value.slice(0, max)}…(truncated)` : value;
}

export const diagnosticsHandlers: GatewayRequestHandlers = {
  // Browser-side crashes (e.g. "Maximum call stack size exceeded") never reach the
  // server on their own. The Control UI's global error handler forwards them here so
  // the stack + context land in the gateway log we can actually read.
  "diagnostics.clientError": async ({ params, respond, context }) => {
    const message = clamp(params.message, 2000) ?? "(no message)";
    const stack = clamp(params.stack, 8000);
    const url = clamp(params.url, 500);
    const source = clamp(params.source, 200);
    const parts = [`[client-error] ${message}`];
    if (source) {
      parts.push(`source=${source}`);
    }
    if (url) {
      parts.push(`url=${url}`);
    }
    context.logGateway.warn(parts.join(" ") + (stack ? `\n${stack}` : ""));
    respond(true, { ok: true }, undefined);
  },
  "diagnostics.stability": async ({ params, respond }) => {
    try {
      const query = normalizeDiagnosticStabilityQuery(params);
      respond(true, getDiagnosticStabilitySnapshot(query), undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          err instanceof Error ? err.message : "invalid diagnostics.stability params",
        ),
      );
    }
  },
};
