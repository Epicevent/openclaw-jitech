import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSelftest } from "./selftest.js";

const completionMock =
  vi.fn<(prompt: string) => Promise<{ ok: boolean; text: string; detail: string }>>();
vi.mock("../cli/capability-cli.js", () => ({
  runLocalModelCompletion: (prompt: string) => completionMock(prompt),
}));

const readdirMock = vi.fn<(path: string) => Promise<string[]>>();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    promises: { ...actual.promises, readdir: (path: string) => readdirMock(path) },
  };
});

/** Stub the gateway readiness HTTP probe. */
function stubReadyz(response: { ok: boolean; status: number } = { ok: true, status: 200 }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/readyz")) {
        return response as unknown as Response;
      }
      throw new Error(`unexpected fetch url ${url}`);
    }),
  );
}

function byName(checks: { name: string; ok: boolean; detail?: string }[]) {
  return Object.fromEntries(checks.map((c) => [c.name, c]));
}

beforeEach(() => {
  completionMock.mockResolvedValue({ ok: true, text: "OK", detail: "google/gemini-x" });
  readdirMock.mockResolvedValue(["host-abc123"]);
  stubReadyz();
});

afterEach(() => {
  vi.restoreAllMocks();
  completionMock.mockReset();
  readdirMock.mockReset();
});

describe("openclaw selftest", () => {
  it("passes when gateway, model, and NAS access all succeed", async () => {
    const result = await runSelftest({ timeoutMs: 5_000 });
    expect(result.ok).toBe(true);
    expect(result.contract).toBe("openclaw-selftest-v1");
    expect(result.required_checks).toEqual([
      "selftest_gateway_ready_ok",
      "selftest_model_roundtrip_ok",
      "selftest_nas_access_ok",
    ]);
    const checks = byName(result.checks);
    expect(checks.selftest_gateway_ready_ok.ok).toBe(true);
    expect(checks.selftest_model_roundtrip_ok.ok).toBe(true);
    expect(checks.selftest_nas_access_ok.ok).toBe(true);
  });

  it("fails when the model completion lacks the expected token", async () => {
    completionMock.mockResolvedValue({ ok: true, text: "no token here", detail: "google/gemini-x" });
    const result = await runSelftest({ timeoutMs: 5_000 });
    expect(result.ok).toBe(false);
    expect(byName(result.checks).selftest_model_roundtrip_ok.ok).toBe(false);
  });

  it("fails the model check when the local completion errors", async () => {
    completionMock.mockResolvedValue({ ok: false, text: "", detail: "no api key" });
    const result = await runSelftest({ timeoutMs: 5_000 });
    expect(byName(result.checks).selftest_model_roundtrip_ok.ok).toBe(false);
  });

  it("fails the NAS check when the docs mount is not readable", async () => {
    readdirMock.mockRejectedValue(new Error("ENOENT: no such file or directory"));
    const result = await runSelftest({ timeoutMs: 5_000 });
    expect(result.ok).toBe(false);
    expect(byName(result.checks).selftest_nas_access_ok.ok).toBe(false);
  });

  it("fails gateway readiness on a non-200 readyz", async () => {
    stubReadyz({ ok: false, status: 503 });
    const result = await runSelftest({ timeoutMs: 5_000 });
    expect(byName(result.checks).selftest_gateway_ready_ok.ok).toBe(false);
  });

  it("does not leak long secret-like blobs into details", async () => {
    completionMock.mockRejectedValue(new Error("boom token=abcdefghijklmnopqrstuvwxyz0123456789"));
    const result = await runSelftest({ timeoutMs: 5_000 });
    const detail = byName(result.checks).selftest_model_roundtrip_ok.detail ?? "";
    expect(detail).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(detail).toContain("<redacted>");
  });
});
