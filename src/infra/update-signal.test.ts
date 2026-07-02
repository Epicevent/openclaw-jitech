import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_UPDATE_SOURCE,
  normalizeUpdateSource,
  parseUpdateSignal,
  readUpdateSignal,
  resolveUpdateSignalPath,
  UPDATE_SIGNAL_FILENAME,
} from "./update-signal.js";

describe("normalizeUpdateSource", () => {
  it("accepts the two known sources case-insensitively", () => {
    expect(normalizeUpdateSource("npm")).toBe("npm");
    expect(normalizeUpdateSource("control-plane")).toBe("control-plane");
    expect(normalizeUpdateSource("Control-Plane")).toBe("control-plane");
  });

  it("returns null for unknown or empty values", () => {
    expect(normalizeUpdateSource("ghcr")).toBeNull();
    expect(normalizeUpdateSource("")).toBeNull();
    expect(normalizeUpdateSource(undefined)).toBeNull();
  });

  it("defaults to upstream npm behavior", () => {
    expect(DEFAULT_UPDATE_SOURCE).toBe("npm");
  });
});

describe("parseUpdateSignal", () => {
  it("parses a full signal", () => {
    expect(
      parseUpdateSignal({
        version: 1,
        availableVersion: "2026.7.1",
        channel: "jitech",
        imageTag: "ghcr.io/epicevent/openclaw-jitech:2026.7.1",
        approvedAt: "2026-07-01T12:00:00Z",
        note: "approved by ops",
      }),
    ).toEqual({
      availableVersion: "2026.7.1",
      channel: "jitech",
      imageTag: "ghcr.io/epicevent/openclaw-jitech:2026.7.1",
      approvedAt: "2026-07-01T12:00:00Z",
      note: "approved by ops",
    });
  });

  it("requires only availableVersion (version envelope optional)", () => {
    expect(parseUpdateSignal({ availableVersion: "2026.7.1" })).toEqual({
      availableVersion: "2026.7.1",
    });
  });

  it("strips an operator-supplied leading v", () => {
    expect(parseUpdateSignal({ availableVersion: "v2026.7.1" })?.availableVersion).toBe("2026.7.1");
  });

  it("rejects unsupported envelope versions", () => {
    expect(parseUpdateSignal({ version: 2, availableVersion: "2026.7.1" })).toBeNull();
  });

  it("rejects missing availableVersion and non-objects", () => {
    expect(parseUpdateSignal({ version: 1 })).toBeNull();
    expect(parseUpdateSignal({ availableVersion: "   " })).toBeNull();
    expect(parseUpdateSignal(null)).toBeNull();
    expect(parseUpdateSignal("nope")).toBeNull();
  });
});

describe("resolveUpdateSignalPath", () => {
  it("prefers the env override", () => {
    const resolved = resolveUpdateSignalPath({
      OPENCLAW_UPDATE_SIGNAL_PATH: "/var/lib/openclaw/signal.json",
    } as NodeJS.ProcessEnv);
    expect(resolved).toBe(path.resolve("/var/lib/openclaw/signal.json"));
  });

  it("falls back to the state directory", () => {
    const stateDir = path.join(os.tmpdir(), "oc-signal-state");
    const resolved = resolveUpdateSignalPath({
      OPENCLAW_STATE_DIR: stateDir,
    } as NodeJS.ProcessEnv);
    expect(resolved).toBe(path.join(path.resolve(stateDir), UPDATE_SIGNAL_FILENAME));
  });
});

describe("readUpdateSignal", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-update-signal-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns the parsed signal from a file", async () => {
    const signalPath = path.join(dir, "signal.json");
    await fs.writeFile(
      signalPath,
      JSON.stringify({ version: 1, availableVersion: "2026.7.1", note: "hi" }),
    );
    await expect(readUpdateSignal({ path: signalPath })).resolves.toEqual({
      availableVersion: "2026.7.1",
      note: "hi",
    });
  });

  it("returns null when the file is missing", async () => {
    await expect(readUpdateSignal({ path: path.join(dir, "absent.json") })).resolves.toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    const signalPath = path.join(dir, "bad.json");
    await fs.writeFile(signalPath, "{ not json");
    await expect(readUpdateSignal({ path: signalPath })).resolves.toBeNull();
  });
});
