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

// User-provided one-line patch note shown in the product's "변경" column. Collapse
// whitespace so build metadata cannot accidentally turn it into multi-line prose.
const rawNote = process.env.BUILD_NOTE ?? process.argv[5];
const note = rawNote?.replace(/\s+/g, " ").trim() || undefined;
// CUSTOMER_RELEASE=1 marks this build as a customer-facing release. Only these show in
// customer/--safe mode; development iterations remain outside the customer timeline.
const customerRelease = process.env.CUSTOMER_RELEASE === "1";
const versionsMode = process.env.VERSIONS_MODE ?? "customer";
if (versionsMode !== "customer" && versionsMode !== "owner") {
  console.error(`build-history: unsupported VERSIONS_MODE=${versionsMode}`);
  process.exit(2);
}
if (versionsMode === "customer" && !customerRelease) {
  console.error("build-history: customer builds require CUSTOMER_RELEASE=1");
  process.exit(2);
}
if (customerRelease && !note) {
  console.error("build-history: CUSTOMER_RELEASE=1 requires a non-empty BUILD_NOTE");
  process.exit(2);
}
const entry = {
  version,
  commit,
  date: new Date().toISOString(),
  ...(note ? { note } : {}),
  ...(customerRelease ? { customerRelease: true } : {}),
};

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
