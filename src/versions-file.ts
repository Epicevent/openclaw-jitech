import { createRequire } from "node:module";

// versions.json is baked next to build-info.json in the image dist (see
// scripts/generate-versions.mjs). Read it with the same candidate-path approach
// version.ts uses for build-info.json so bundled and source layouts both resolve.
const VERSIONS_CANDIDATES = [
  "../versions.json",
  "../../versions.json",
  "./versions.json",
] as const;

export type VersionEntry = {
  version: string;
  date: string | null;
  // owner-mode only fields (absent in customer/--safe builds):
  commit?: string;
  shortCommit?: string;
  pr?: number | null;
  title?: string | null;
  body?: string | null;
  prUrl?: string | null;
  commitUrl?: string;
};

export type VersionsFile = { mode: "owner" | "customer"; versions: VersionEntry[] };

const EMPTY: VersionsFile = { mode: "customer", versions: [] };

export function readVersionsForModuleUrl(moduleUrl: string): VersionsFile {
  try {
    const require = createRequire(moduleUrl);
    for (const candidate of VERSIONS_CANDIDATES) {
      try {
        const parsed = require(candidate) as Partial<VersionsFile>;
        if (parsed && Array.isArray(parsed.versions)) {
          return { mode: parsed.mode === "owner" ? "owner" : "customer", versions: parsed.versions };
        }
      } catch {
        // missing or unreadable candidate — try the next
      }
    }
  } catch {
    // ignore
  }
  return EMPTY;
}
