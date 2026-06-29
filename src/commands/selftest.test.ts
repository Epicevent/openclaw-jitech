import { afterEach, describe, expect, it, vi } from "vitest";

const callGateway = vi.fn();
vi.mock("../gateway/call.js", () => ({ callGateway: (...args: unknown[]) => callGateway(...args) }));

import { runSelftest } from "./selftest.js";

function okRunnerResponse() {
  return {
    ok: true,
    json: async () => ({ tool_audit: { ok: true, tool_call_count: 1 } }),
    status: 200,
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  callGateway.mockReset();
});

describe("openclaw selftest", () => {
  it("passes when gateway, model, and NAS round-trip all succeed", async () => {
    callGateway.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "health") {
        return {};
      }
      if (opts.method === "sessions.create") {
        return { key: "s1" };
      }
      if (opts.method === "sessions.send") {
        return { reply: "OK" };
      }
      throw new Error(`unexpected method ${opts.method}`);
    });
    vi.stubGlobal("fetch", vi.fn(async () => okRunnerResponse()));

    const result = await runSelftest({ timeoutMs: 5_000 });
    expect(result.ok).toBe(true);
    expect(result.contract).toBe("openclaw-selftest-v1");
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c.ok]));
    expect(byName.selftest_gateway_ready_ok).toBe(true);
    expect(byName.selftest_model_roundtrip_ok).toBe(true);
    expect(byName.selftest_executor_nas_roundtrip_ok).toBe(true);
  });

  it("fails when the model reply lacks the expected token", async () => {
    callGateway.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "health") {
        return {};
      }
      if (opts.method === "sessions.create") {
        return { sessionKey: "s2" };
      }
      if (opts.method === "sessions.send") {
        return { reply: "nope" };
      }
      throw new Error(`unexpected method ${opts.method}`);
    });
    vi.stubGlobal("fetch", vi.fn(async () => okRunnerResponse()));

    const result = await runSelftest({ timeoutMs: 5_000 });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "selftest_model_roundtrip_ok")?.ok).toBe(false);
  });

  it("fails the NAS check when the runner reports no tool calls", async () => {
    callGateway.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "health") {
        return {};
      }
      if (opts.method === "sessions.create") {
        return { key: "s3" };
      }
      if (opts.method === "sessions.send") {
        return { reply: "OK" };
      }
      throw new Error(`unexpected method ${opts.method}`);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ tool_audit: { ok: false, tool_call_count: 0 } }),
      })),
    );

    const result = await runSelftest({ timeoutMs: 5_000 });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "selftest_executor_nas_roundtrip_ok")?.ok).toBe(false);
  });

  it("does not leak long secret-like blobs into details", async () => {
    callGateway.mockImplementation(async () => {
      throw new Error("boom token=abcdefghijklmnopqrstuvwxyz0123456789");
    });
    vi.stubGlobal("fetch", vi.fn(async () => okRunnerResponse()));

    const result = await runSelftest({ timeoutMs: 5_000 });
    const detail = result.checks.find((c) => c.name === "selftest_gateway_ready_ok")?.detail ?? "";
    expect(detail).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(detail).toContain("<redacted>");
  });
});
