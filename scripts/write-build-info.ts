import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const pkgPath = path.join(rootDir, "package.json");

const readPackageVersion = () => {
  try {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
};

// Trusted product-image builds stamp the JI version via OPENCLAW_BUILD_VERSION so the
// running slot resolves its own version from build-info.json (see src/version.ts) instead
// of a per-slot OPENCLAW_VERSION override. Stored bare to match the package-version shape.
const resolveBuildVersion = () => {
  const envVersion = process.env.OPENCLAW_BUILD_VERSION?.trim();
  if (envVersion) {
    return envVersion.replace(/^v(?=\d)/i, "");
  }
  return readPackageVersion();
};

const resolveCommit = () => {
  const envCommit = process.env.GIT_COMMIT?.trim() || process.env.GIT_SHA?.trim();
  if (envCommit) {
    return envCommit;
  }
  try {
    return execSync("git rev-parse HEAD", {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

const version = resolveBuildVersion();
const commit = resolveCommit();

const buildInfo = {
  version,
  commit,
  builtAt: new Date().toISOString(),
};

fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
