import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withProviderUsageCallReceipt } from "../agents/provider-usage-receipts.js";
import { resolveProviderUsageReceiptDbPath } from "../agents/provider-usage-receipts.paths.js";
import { closeProviderUsageReceiptStore } from "../agents/provider-usage-receipts.store.js";
import { registerUsageReceiptsCli } from "./usage-receipts-cli.js";

describe("usage-receipts coverage CLI", () => {
  afterEach(() => {
    closeProviderUsageReceiptStore();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("prints the exact coverage contract without initializing the receipt DB", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-coverage-cli-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const program = new Command();
      program.exitOverride();
      registerUsageReceiptsCli(program);
      await program.parseAsync(["node", "openclaw", "usage-receipts", "coverage", "--json"]);

      const payload = JSON.parse(writes.join("")) as {
        schema: string;
        manifestDigest: string;
        coverageStatus: string;
      };
      expect(payload).toMatchObject({
        schema: "jitech-provider-usage-coverage/v1",
        coverageStatus: "partial",
      });
      expect(payload.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(existsSync(resolveProviderUsageReceiptDbPath(process.env))).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("prints receipts with their exact generation-time coverage manifests", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-export-cli-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await withProviderUsageCallReceipt({
        provider: "google",
        model: "gemini-3.6-flash",
        run: async () => null,
      });
      const program = new Command();
      program.exitOverride();
      registerUsageReceiptsCli(program);
      await program.parseAsync([
        "node",
        "openclaw",
        "usage-receipts",
        "export",
        "--after",
        "0",
        "--limit",
        "1",
      ]);

      const payload = JSON.parse(writes.join("")) as {
        receipts: Array<{ producerCoverageDigest: string }>;
        coverageManifests: Array<{ manifestDigest: string }>;
      };
      expect(payload.receipts).toHaveLength(1);
      expect(payload.coverageManifests).toHaveLength(1);
      expect(payload.receipts[0]?.producerCoverageDigest).toBe(
        payload.coverageManifests[0]?.manifestDigest,
      );
    } finally {
      closeProviderUsageReceiptStore();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
