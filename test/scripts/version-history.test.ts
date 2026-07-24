import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const recordScript = path.resolve("scripts/record-build-version.mjs");
const generateScript = path.resolve("scripts/generate-versions.mjs");
const tempDirs: string[] = [];

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.BUILD_HISTORY_FILE;
  delete env.BUILD_NOTE;
  delete env.CUSTOMER_RELEASE;
  delete env.VERSIONS_MODE;
  return env;
}

function runNode(script: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("version history release notes", () => {
  it("rejects the default customer build when it is not marked as a release", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-version-history-"));
    tempDirs.push(dir);
    const history = path.join(dir, "history.jsonl");
    const env = cleanEnv();
    env.BUILD_NOTE = "고객에게 보일 패치 설명";

    const result = runNode(recordScript, ["customer-v1", "a".repeat(40), history], env);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("customer builds require CUSTOMER_RELEASE=1");
    await expect(readFile(history, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a customer release without the user's patch note", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-version-history-"));
    tempDirs.push(dir);
    const history = path.join(dir, "history.jsonl");
    const env = cleanEnv();
    env.CUSTOMER_RELEASE = "1";
    env.BUILD_NOTE = "   ";

    const result = runNode(recordScript, ["customer-v1", "a".repeat(40), history], env);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("CUSTOMER_RELEASE=1 requires a non-empty BUILD_NOTE");
    await expect(readFile(history, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes only customer-release rows with a normalized one-line note", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-version-history-"));
    tempDirs.push(dir);
    const history = path.join(dir, "history.jsonl");
    const output = path.join(dir, "versions.json");

    const releaseEnv = cleanEnv();
    releaseEnv.CUSTOMER_RELEASE = "1";
    releaseEnv.BUILD_NOTE = "  이미지 전달\n오탐을 제거했습니다.  ";
    const release = runNode(recordScript, ["customer-v1", "b".repeat(40), history], releaseEnv);
    expect(release.status).toBe(0);

    const developmentEnv = cleanEnv();
    developmentEnv.VERSIONS_MODE = "owner";
    developmentEnv.BUILD_NOTE = "개발 검증용 빌드";
    const development = runNode(recordScript, ["dev-v2", "c".repeat(40), history], developmentEnv);
    expect(development.status).toBe(0);

    const generated = runNode(generateScript, [history, output, "--safe"], cleanEnv());
    expect(generated.status).toBe(0);
    const parsed = JSON.parse(await readFile(output, "utf8")) as {
      mode: string;
      versions: Array<Record<string, unknown>>;
    };

    expect(parsed).toEqual({
      mode: "customer",
      versions: [
        {
          version: "customer-v1",
          date: expect.any(String),
          note: "이미지 전달 오탐을 제거했습니다.",
        },
      ],
    });
    expect(parsed.versions[0]).not.toHaveProperty("commit");
    expect(parsed.versions[0]).not.toHaveProperty("prUrl");
  });
});
