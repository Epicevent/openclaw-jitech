import { afterEach, describe, expect, it, vi } from "vitest";

import { runSelftest } from "./selftest.js";

type FetchResponse = {
  ok: boolean;
  status: number;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
};

/** Route a mocked fetch by URL to the three localhost surfaces the selftest hits. */
function mockFetch(routes: {
  readyz?: FetchResponse;
  responses?: FetchResponse;
  runner?: FetchResponse;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/readyz")) {
        return (routes.readyz ?? { ok: true, status: 200 }) as unknown as Response;
      }
      if (url.includes("/v1/responses")) {
        return (routes.responses ??
          { ok: true, status: 200, text: async () => "...OK..." }) as unknown as Response;
      }
      if (url.includes("/runner/runs")) {
        return (routes.runner ??
          {
            ok: true,
            status: 200,
            json: async () => ({ tool_audit: { ok: true, tool_call_count: 1 } }),
          }) as unknown as Response;
      }
      throw new Error(`unexpected fetch url ${url}`);
    }),
  );
}

function byName(checks: { name: string; ok: boolean; detail?: string }[]) {
  return Object.fromEntries(checks.map((c) => [c.name, c]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openclaw selftest", () => {
  it("passes when gateway, model, and NAS round-trip all succeed", async () => {
    mockFetch({});
    const result = await runSelftest({ timeoutMs: 5_000 });
    expect(result.ok).toBe(true);
    expect(result.contract).toBe("openclaw-selftest-v1");
    const checks = byName(result.checks);
    expect(checks.selftest_gateway_ready_ok.ok).toBe(true);
    expect(checks.selftest_model_roundtrip_ok.ok).toBe(true);
    expect(checks.selftest_executor_nas_roundtrip_ok.ok).toBe(true);
  });

  it("fails when the model completion lacks the expected token", async () => {
    mockFetch({ responses: { ok: true, status: 200, text: async () => "no token here" } });
    const result = await runSelftest({ timeoutMs: 5_000 });
    expect(result.ok).toBe(false);
    expect(byName(result.checks).selftest_model_roundtrip_ok.ok).toBe(false);
  });

  it("fails the model check on a non-200 responses status", async () => {
    mockFetch({ responses: { ok: false, status: 401, text: async () => "" } });
    const result = await runSelftest({ timeoutMs: 5_000 });
    expect(byName(result.checks).selftest_model_roundtrip_ok.ok).toBe(false);
  });

  it("fails the NAS check when the runner reports no tool calls", async () => {
    mockFetch({
      runner: { ok: true, status: 200, json: async () => ({ tool_audit: { ok: false, tool_call_count: 0 } }) },
    });
    const result = await runSelftest({ timeoutMs: 5_000 });
    expect(result.ok).toBe(false);
    expect(byName(result.checks).selftest_executor_nas_roundtrip_ok.ok).toBe(false);
  });

  it("fails gateway readiness on a non-200 readyz", async () => {
    mockFetch({ readyz: { ok: false, status: 503 } });
    const result = await runSelftest({ timeoutMs: 5_000 });
    expect(byName(result.checks).selftest_gateway_ready_ok.ok).toBe(false);
  });

  it("does not leak long secret-like blobs into details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom token=abcdefghijklmnopqrstuvwxyz0123456789");
      }),
    );
    const result = await runSelftest({ timeoutMs: 5_000 });
    const detail = byName(result.checks).selftest_gateway_ready_ok.detail ?? "";
    expect(detail).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(detail).toContain("<redacted>");
  });
});
