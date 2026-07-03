import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

/**
 * Source of the "update available" signal that drives the control-UI banner.
 * - "npm": upstream behavior — poll the npm release feed (registry.npmjs.org).
 * - "control-plane": JI fleet — read an opsctl-written signal file describing the
 *   latest approved product image. Slots never reach a registry and never self-apply;
 *   promotion is an operator action (`rollout image-promote`).
 */
export type UpdateSource = "npm" | "control-plane";

export type UpdateInstallKind = "git" | "package" | "unknown";

export function normalizeUpdateSource(value?: string | null): UpdateSource | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "npm" || normalized === "control-plane") {
    return normalized;
  }
  return null;
}

/**
 * Effective update source. Explicit config always wins. When unset, this fork
 * defaults package/image installs to "control-plane" — a fork artifact must never
 * nag customers toward upstream npm releases, and it stays silent until an operator
 * signal appears. Git checkouts keep the upstream "npm" behavior so developer
 * working copies still see release hints and can self-update.
 */
export function resolveEffectiveUpdateSource(params: {
  configSource?: string | null;
  installKind: UpdateInstallKind;
}): UpdateSource {
  const explicit = normalizeUpdateSource(params.configSource);
  if (explicit) {
    return explicit;
  }
  return params.installKind === "git" ? "npm" : "control-plane";
}

/**
 * Contract for the opsctl-written signal at {@link resolveUpdateSignalPath}. The control
 * plane writes this when a JI-approved image becomes promotable; only `availableVersion`
 * is required. Unknown envelope `version` values are ignored rather than guessed.
 */
export type UpdateSignal = {
  availableVersion: string;
  channel?: string;
  imageTag?: string;
  approvedAt?: string;
  note?: string;
};

export const UPDATE_SIGNAL_FILENAME = "update-signal.json";
export const UPDATE_SIGNAL_PATH_ENV = "OPENCLAW_UPDATE_SIGNAL_PATH";
const SUPPORTED_SIGNAL_VERSION = 1;

export function resolveUpdateSignalPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = normalizeOptionalString(env[UPDATE_SIGNAL_PATH_ENV]);
  if (override) {
    return path.resolve(override);
  }
  return path.join(resolveStateDir(env), UPDATE_SIGNAL_FILENAME);
}

// The banner renders `v${latestVersion}` and compares against the bare package version,
// so strip an operator-supplied leading "v" to keep both sides in the same shape.
function normalizeSignalVersion(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return /^v\d/i.test(trimmed) ? trimmed.slice(1) : trimmed;
}

export function parseUpdateSignal(raw: unknown): UpdateSignal | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== undefined && record.version !== SUPPORTED_SIGNAL_VERSION) {
    return null;
  }
  const availableVersion = normalizeSignalVersion(record.availableVersion);
  if (!availableVersion) {
    return null;
  }
  const channel = normalizeOptionalString(record.channel);
  const imageTag = normalizeOptionalString(record.imageTag);
  const approvedAt = normalizeOptionalString(record.approvedAt);
  const note = normalizeOptionalString(record.note);
  return {
    availableVersion,
    ...(channel ? { channel } : {}),
    ...(imageTag ? { imageTag } : {}),
    ...(approvedAt ? { approvedAt } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * Read and validate the control-plane update signal. Returns `null` when the file is
 * absent, empty, malformed, or carries an unsupported envelope version — the caller
 * treats every one of these as "no update available" and must never throw from here
 * (this runs inside the gateway update-check loop).
 */
export async function readUpdateSignal(params?: {
  path?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<UpdateSignal | null> {
  const signalPath = params?.path ?? resolveUpdateSignalPath(params?.env);
  let rawText: string;
  try {
    rawText = await fs.readFile(signalPath, "utf-8");
  } catch {
    return null;
  }
  try {
    return parseUpdateSignal(JSON.parse(rawText));
  } catch {
    return null;
  }
}
