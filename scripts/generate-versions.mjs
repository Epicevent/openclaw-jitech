// Generate versions.json — the version-tracking timeline baked into the image, so a
// running slot needs no git/GitHub/registry access at runtime.
//
// The rows come from the build-history log (record-build-version.mjs), the
// authoritative list of builds — NOT from git log (git has no build names/tags) and
// NOT backfilled from ghcr. Each build appends itself, so history grows forward.
//
// Customer/--safe build: emit only {version, date}. Internal PR prose (which
// references the owner, internal decisions, etc.) must never ship in a customer
// image, so it's omitted at the DATA layer. Owner/dev builds also attach, per row,
// the PR title + body pulled from ground truth (the commit's "(#NN)" -> `gh pr`).
//
// Usage: node scripts/generate-versions.mjs [historyFile] [outFile] [--safe]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const safe = args.includes("--safe");
const positional = args.filter((a) => !a.startsWith("--"));
const historyFile =
  positional[0] ??
  process.env.BUILD_HISTORY_FILE ??
  path.join(os.homedir(), ".openclaw-build-history.jsonl");
const outFile = positional[1] ?? path.join("dist", "versions.json");

function readHistory(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return []; // no builds recorded yet — empty timeline (fills on the next build)
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const e = JSON.parse(line);
      if (e && typeof e.version === "string" && typeof e.commit === "string") {
        rows.push(e);
      }
    } catch {
      /* skip malformed line */
    }
  }
  // newest first
  return rows.toReversed();
}

function commitSubject(commit) {
  try {
    return execFileSync("git", ["show", "-s", "--format=%s", commit], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function ghPr(number) {
  try {
    const raw = execFileSync(
      "gh",
      ["pr", "view", String(number), "--json", "title,body,url"],
      { encoding: "utf8", env: process.env },
    );
    const { title, body, url } = JSON.parse(raw);
    return { title: title ?? null, body: body ?? null, url: url ?? null };
  } catch {
    return null; // PR not found / no gh auth → fall back to the commit subject
  }
}

const prCache = new Map();
const versions = readHistory(historyFile).map((e) => {
  const date = e.date ?? null;
  if (safe) {
    return { version: e.version, date }; // customer image: name + date only, nothing internal
  }

  // owner/dev image: attach the ground-truth PR content
  const subject = commitSubject(e.commit);
  const pr = subject.match(/\(#(\d+)\)\s*$/)?.[1];
  let prData = null;
  if (pr) {
    if (!prCache.has(pr)) {
      prCache.set(pr, ghPr(pr));
    }
    prData = prCache.get(pr);
  }
  return {
    version: e.version,
    date,
    commit: e.commit,
    shortCommit: e.commit.slice(0, 8),
    pr: pr ? Number.parseInt(pr, 10) : null,
    title: prData?.title ?? subject ?? null,
    body: prData?.body ?? null,
    prUrl: prData?.url ?? null,
    commitUrl: `https://github.com/Epicevent/openclaw-jitech/commit/${e.commit}`,
  };
});

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify({ mode: safe ? "customer" : "owner", versions }, null, 2)}\n`);
console.error(
  `wrote ${versions.length} versions (${safe ? "customer" : "owner"} mode) to ${outFile}`,
);
