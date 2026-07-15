// Append one line to the build-history log — the authoritative list of builds the
// version-tracking view reads. No backfill: history starts from the first build that
// runs this. Called by build-trusted-product-image.sh after a successful push.
//
// Usage: node scripts/record-build-version.mjs <version> <commit> [historyFile]
//   version      the image tag / build name (e.g. "mediafix", "v2026.7.16")
//   commit       the full source commit sha
//   historyFile  jsonl to append to (default: env BUILD_HISTORY_FILE or
//                ~/.openclaw-build-history.jsonl on the build host)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [version, commit] = process.argv.slice(2);
if (!version || !commit) {
  console.error("usage: record-build-version.mjs <version> <commit> [historyFile]");
  process.exit(2);
}
const historyFile =
  process.argv[4] ??
  process.env.BUILD_HISTORY_FILE ??
  path.join(os.homedir(), ".openclaw-build-history.jsonl");

// Optional owner-written one-line key point (the "변경" shown in the modal). Supplied at
// build time via BUILD_NOTE env or a 4th arg; absent for builds recorded before this.
const note = process.env.BUILD_NOTE?.trim() || process.argv[5]?.trim() || undefined;
const entry = { version, commit, date: new Date().toISOString(), ...(note ? { note } : {}) };

// De-dupe: a rebuild of the same version+commit shouldn't stack duplicate rows.
let already = false;
try {
  const existing = fs.readFileSync(historyFile, "utf8");
  already = existing.split("\n").some((line) => {
    if (!line.trim()) {
      return false;
    }
    try {
      const e = JSON.parse(line);
      return e.version === version && e.commit === commit;
    } catch {
      return false;
    }
  });
} catch {
  /* first build — file doesn't exist yet */
}

if (already) {
  console.error(`build-history: ${version} @ ${commit.slice(0, 8)} already recorded, skipping`);
} else {
  fs.mkdirSync(path.dirname(historyFile), { recursive: true });
  fs.appendFileSync(historyFile, `${JSON.stringify(entry)}\n`);
  console.error(`build-history: recorded ${version} @ ${commit.slice(0, 8)} -> ${historyFile}`);
}
