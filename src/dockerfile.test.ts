import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_PLUGIN_ROOT_DIR } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dockerfilePath = join(repoRoot, "Dockerfile");
const dockerReleaseWorkflowPath = join(repoRoot, ".github/workflows/docker-release.yml");
const dockerSetupDockerfilePaths = ["Dockerfile", "scripts/docker/sandbox/Dockerfile"] as const;
const pnpmWorkspacePath = join(repoRoot, "pnpm-workspace.yaml");

function collapseDockerContinuations(dockerfile: string): string {
  return dockerfile.replace(/\\\r?\n[ \t]*/g, " ");
}

describe("Dockerfile", () => {
  it("does not force an external Dockerfile frontend pull", async () => {
    for (const path of dockerSetupDockerfilePaths) {
      const dockerfile = await readFile(join(repoRoot, path), "utf8");
      expect(dockerfile, path).not.toMatch(/^#\s*syntax=/m);
    }
  });

  it("uses full bookworm for build stages and slim bookworm for runtime", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain(
      'ARG OPENCLAW_NODE_BOOKWORM_IMAGE="node:24-bookworm@sha256:3a09aa6354567619221ef6c45a5051b671f953f0a1924d1f819ffb236e520e6b"',
    );
    expect(dockerfile).toContain(
      'ARG OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE="node:24-bookworm-slim@sha256:e8e2e91b1378f83c5b2dd15f0247f34110e2fe895f6ca7719dbb780f929368eb"',
    );
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS workspace-deps");
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS build");
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-runtime");
    expect(dockerfile).toContain("FROM base-runtime");
    expect(dockerfile).toContain("current multi-arch manifest list entries");
    expect(dockerfile).not.toContain("current amd64 entry");
    expect(dockerfile).not.toContain("OPENCLAW_VARIANT");
  });

  it("installs CA certificates in the slim runtime stage", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const collapsed = collapseDockerContinuations(dockerfile);
    const runtimeIndex = collapsed.indexOf(
      "FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-runtime",
    );
    const caInstallIndex = collapsed.indexOf("ca-certificates curl git hostname libgdbm6");

    expect(runtimeIndex).toBeGreaterThan(-1);
    expect(caInstallIndex).toBeGreaterThan(runtimeIndex);
    expect(caInstallIndex).toBeLessThan(collapsed.indexOf("RUN chown node:node /app"));
    expect(collapsed).toMatch(/apt-get install -y --no-install-recommends\s+ca-certificates/);
    expect(collapsed).toContain("update-ca-certificates");
  });

  it("installs tini and runtime utilities in the slim runtime stage", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    const runtimeIndex = dockerfile.indexOf(
      "FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-runtime",
    );
    const runtimeInstallIndex = dockerfile.indexOf("ca-certificates curl git hostname libgdbm6");

    expect(runtimeIndex).toBeGreaterThan(-1);
    expect(runtimeInstallIndex).toBeGreaterThan(runtimeIndex);
    expect(runtimeInstallIndex).toBeLessThan(dockerfile.indexOf("RUN chown node:node /app"));
    expect(dockerfile).toContain("libreadline8 libsqlite3-0 libtirpc3 lsof netbase");
    expect(dockerfile).toContain('ENTRYPOINT ["tini", "-s", "--"]');
  });

  it("packages the default-off live-corpus KWRAG component", async () => {
    const componentRoot = join(repoRoot, "runtime-components/kwrag");
    const wheel = await readFile(
      join(componentRoot, "kwrag_product_service-0.5.0-py3-none-any.whl"),
    );
    const manifestBytes = await readFile(join(componentRoot, "component-manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      source: { commit: string };
      surface: {
        argv: string[];
        stdin_schema: string;
        stdout_schemas: string[];
        host_ports: number;
        network: boolean;
        default_enabled: boolean;
        mount_read_only: boolean;
        corpus_authority: string;
      };
      wheel: { sha256: string };
    };
    const launcher = await readFile(join(componentRoot, "kwrag-product"), "utf8");
    const dockerfile = await readFile(dockerfilePath, "utf8");

    expect(`sha256:${createHash("sha256").update(wheel).digest("hex")}`).toBe(
      manifest.wheel.sha256,
    );
    expect(manifest.source.commit).toBe("d0960595b4d2eb82a00005f1baebe390fac4cab0");
    expect(manifest.surface.argv).toEqual(["kwrag-product"]);
    expect(manifest.surface.stdin_schema).toBe("kwrag-product-cli-request-v1");
    expect(manifest.surface.stdout_schemas).toContain(
      "kwrag-product-cli-search-exchange-v1",
    );
    expect(manifest.surface.host_ports).toBe(0);
    expect(manifest.surface.network).toBe(false);
    expect(manifest.surface.default_enabled).toBe(false);
    expect(manifest.surface.mount_read_only).toBe(true);
    expect(manifest.surface.corpus_authority).toBe("mounted_nas");
    expect(launcher).toContain('from kwrag.product_cli import main');
    expect(launcher).not.toContain("/bin/sh");
    expect(launcher).not.toContain("env -S");
    expect(dockerfile).toContain(
      'ARG OPENCLAW_PYTHON_BOOKWORM_SLIM_IMAGE="python:3.12-slim-bookworm@sha256:d50fb7611f86d04a3b0471b46d7557818d88983fc3136726336b2a4c657aa30b"',
    );
    expect(dockerfile).toContain(
      "FROM ${OPENCLAW_PYTHON_BOOKWORM_SLIM_IMAGE} AS kwrag-python-runtime",
    );
    expect(dockerfile).toContain("COPY --from=kwrag-python-runtime /usr/local /usr/local");
    expect(dockerfile).toContain(
      'com.epicevent.agent-runtime.retrieval.schema="jitech-kwrag-product-cli/v1"',
    );
    expect(dockerfile).toContain(
      'com.epicevent.agent-runtime.retrieval.source-commit="d0960595b4d2eb82a00005f1baebe390fac4cab0"',
    );
    expect(dockerfile).toContain(
      'com.epicevent.agent-runtime.retrieval.wheel-sha256="sha256:f74481268e289f40e0b24cc9727f293fccb83b6e5bdb09ff5c289a7e1d257073"',
    );
    expect(dockerfile).toContain(
      'com.epicevent.agent-runtime.retrieval.command.json="[\\"kwrag-product\\"]"',
    );
    expect(dockerfile).toContain(
      'com.epicevent.agent-runtime.retrieval.stdin-schema="kwrag-product-cli-request-v1"',
    );
    expect(dockerfile).not.toContain(
      'com.epicevent.agent-runtime.retrieval.search-command.json="[\\"kwrag-product\\",\\"search\\"]"',
    );
    expect(dockerfile).toContain(
      'com.epicevent.agent-runtime.retrieval.index-admission="mounted-corpus-only"',
    );
    expect(dockerfile).toContain(
      `COPY runtime-components/kwrag/kwrag_product_service-0.5.0-py3-none-any.whl /tmp/kwrag.whl`,
    );
    expect(dockerfile).toContain(
      `COPY runtime-components/kwrag/kwrag-product /opt/jitech/kwrag/bin/kwrag-product`,
    );
    expect(dockerfile).not.toContain("kwrag-fixed-producer");
    expect(dockerfile).toContain("python3 -m zipfile -e /tmp/kwrag.whl /opt/jitech/kwrag/lib");
    expect(manifestBytes.toString("utf8")).not.toContain("expected_source_generation");
  });

  it("installs optional browser dependencies after pnpm install", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const browserArgIndex = dockerfile.indexOf("ARG OPENCLAW_INSTALL_BROWSER");

    expect(installIndex).toBeGreaterThan(-1);
    expect(browserArgIndex).toBeGreaterThan(-1);
    expect(browserArgIndex).toBeGreaterThan(installIndex);
    expect(dockerfile).toContain(
      "node /app/node_modules/playwright-core/cli.js install --with-deps chromium",
    );
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends xvfb");
  });

  it("uses the Docker target platform for pnpm install and prune", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");

    expect(dockerfile).toContain("pnpm install --frozen-lockfile \\");
    expect(dockerfile).toContain("CI=true pnpm prune --prod \\");
    expect(dockerfile).toContain("--config.offline=true");
    expect(dockerfile.split("--config.supportedArchitectures.os=linux").length - 1).toBe(2);
    expect(
      dockerfile.split("--config.supportedArchitectures.cpu=\"$(node -p 'process.arch')\"").length -
        1,
    ).toBe(2);
    expect(dockerfile.split("--config.supportedArchitectures.libc=glibc").length - 1).toBe(2);
  });

  it("verifies matrix-sdk-crypto native addons without hardcoded pnpm virtual-store paths", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain("Verifying critical native addons");
    expect(dockerfile).toContain('find /app/node_modules -name "matrix-sdk-crypto*.node"');
    expect(dockerfile).toContain(
      "node /app/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js",
    );
    expect(dockerfile).toContain("matrix-sdk-crypto native addon missing after retries");
    expect(dockerfile).not.toMatch(
      /ADDON_DIR=.*node_modules\/\.pnpm\/@matrix-org\+matrix-sdk-crypto-nodejs@/,
    );
  });

  it("copies install workspace manifests before pnpm install", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const postinstallIndex = dockerfile.indexOf("COPY scripts/postinstall-bundled-plugins.mjs");
    const distImportHelperIndex = dockerfile.indexOf(
      "COPY scripts/lib/package-dist-imports.mjs ./scripts/lib/package-dist-imports.mjs",
    );
    const packageManifestIndex = dockerfile.indexOf(
      "COPY --from=workspace-deps /out/packages/ ./packages/",
    );
    const extensionManifestIndex = dockerfile.indexOf(
      "COPY --from=workspace-deps /out/${OPENCLAW_BUNDLED_PLUGIN_DIR}/ ./${OPENCLAW_BUNDLED_PLUGIN_DIR}/",
    );

    expect(postinstallIndex).toBeGreaterThan(-1);
    expect(distImportHelperIndex).toBeGreaterThan(-1);
    expect(packageManifestIndex).toBeGreaterThan(-1);
    expect(extensionManifestIndex).toBeGreaterThan(-1);
    expect(dockerfile).toContain("for manifest in /tmp/packages/*/package.json");
    expect(dockerfile).toContain(
      `if [ -f "/tmp/\${OPENCLAW_BUNDLED_PLUGIN_DIR}/$ext/package.json" ]; then`,
    );
    expect(postinstallIndex).toBeLessThan(installIndex);
    expect(distImportHelperIndex).toBeLessThan(installIndex);
    expect(packageManifestIndex).toBeLessThan(installIndex);
    expect(extensionManifestIndex).toBeLessThan(installIndex);
  });

  it("does not let pnpm resync the full source workspace during Docker build scripts", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");

    expect(dockerfile).toContain(
      "NODE_OPTIONS=--max-old-space-size=8192 pnpm_config_verify_deps_before_run=false pnpm build:docker",
    );
    expect(dockerfile).toContain(
      "pnpm_config_verify_deps_before_run=false pnpm canvas:a2ui:bundle",
    );
    expect(dockerfile).toContain("pnpm_config_verify_deps_before_run=false pnpm ui:build");
    expect(dockerfile).toContain("pnpm_config_verify_deps_before_run=false pnpm qa:lab:build");
  });

  it("prunes runtime dependencies after the build stage", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain("FROM build AS runtime-assets");
    expect(dockerfile).toContain("ARG OPENCLAW_EXTENSIONS");
    expect(dockerfile).toContain("ARG OPENCLAW_BUNDLED_PLUGIN_DIR");
    expect(dockerfile).toContain(
      "Opt-in plugin dependencies at build time (space- or comma-separated directory names).",
    );
    expect(dockerfile).toContain(
      'Example: docker build --build-arg OPENCLAW_EXTENSIONS="diagnostics-otel,matrix" .',
    );
    expect(dockerfile).toContain(
      "RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \\",
    );
    expect(dockerfile).toContain("COPY --from=workspace-deps /out/packages/ ./packages/");
    expect(dockerfile).toContain(
      "COPY --from=workspace-deps /out/${OPENCLAW_BUNDLED_PLUGIN_DIR}/ ./${OPENCLAW_BUNDLED_PLUGIN_DIR}/",
    );
    expect(dockerfile).toContain("CI=true pnpm prune --prod \\");
    expect(dockerfile).toContain("--config.offline=true");
    expect(dockerfile).toContain("--config.supportedArchitectures.os=linux");
    expect(dockerfile).toContain(
      "--config.supportedArchitectures.cpu=\"$(node -p 'process.arch')\"",
    );
    expect(dockerfile).toContain("--config.supportedArchitectures.libc=glibc");
    expect(dockerfile).toContain(
      'OPENCLAW_EXTENSIONS="$OPENCLAW_EXTENSIONS" node scripts/prune-docker-plugin-dist.mjs',
    );
    expect(dockerfile).not.toContain("pnpm-workspace.runtime.yaml");
    expect(dockerfile).not.toContain("write-runtime-pnpm-workspace");
    expect(dockerfile).not.toContain(
      `npm install --prefix "${BUNDLED_PLUGIN_ROOT_DIR}/$ext" --omit=dev --silent`,
    );
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=node:node /app/node_modules ./node_modules",
    );
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=node:node /app/pnpm-workspace.yaml .",
    );
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=node:node /app/patches ./patches",
    );
  });

  it("keeps package manager patch files in runtime images", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    const pnpmWorkspace = YAML.parse(await readFile(pnpmWorkspacePath, "utf8")) as {
      patchedDependencies?: Record<string, string>;
    };
    const pruneProd = "CI=true pnpm prune --prod";
    const finalWorkspaceCopy =
      "COPY --from=runtime-assets --chown=node:node /app/pnpm-workspace.yaml .";

    expect(Object.keys(pnpmWorkspace.patchedDependencies ?? {})).not.toHaveLength(0);
    expect(dockerfile).not.toContain("pnpm-workspace.runtime.yaml");
    expect(dockerfile).not.toContain("write-runtime-pnpm-workspace");
    expect(dockerfile).not.toContain("pnpm_config_frozen_lockfile=false");
    expect(dockerfile).toContain(finalWorkspaceCopy);
    expect(dockerfile.indexOf(pruneProd)).toBeLessThan(dockerfile.indexOf(finalWorkspaceCopy));
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=node:node /app/pnpm-workspace.yaml .",
    );
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=node:node /app/patches ./patches",
    );
  });

  it("keeps the Codex plugin in official Docker release images", async () => {
    const workflow = await readFile(dockerReleaseWorkflowPath, "utf8");
    const releaseKeepList = "OPENCLAW_EXTENSIONS=diagnostics-otel,codex";

    expect(workflow.match(new RegExp(releaseKeepList, "g"))).toHaveLength(2);
    expect(workflow).not.toContain("OPENCLAW_EXTENSIONS=diagnostics-otel\n");
  });

  it("stamps the exact source commit into trusted and official image build metadata", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const trustedBuild = await readFile(
      join(repoRoot, "scripts/build-trusted-product-image.sh"),
      "utf8",
    );
    const workflow = await readFile(dockerReleaseWorkflowPath, "utf8");

    expect(dockerfile).toContain('ARG GIT_COMMIT=""');
    expect(dockerfile).toContain(
      'RUN GIT_COMMIT="$GIT_COMMIT" NODE_OPTIONS=--max-old-space-size=8192',
    );
    expect(dockerfile).not.toContain("ENV GIT_COMMIT=");
    expect(dockerfile.indexOf('ARG GIT_COMMIT=""')).toBeGreaterThan(
      dockerfile.indexOf("pnpm install --frozen-lockfile"),
    );
    expect(trustedBuild).toContain('--build-arg "GIT_COMMIT=${sha}"');
    expect(workflow.match(/echo "source_sha=\$\{source_sha\}"/g)).toHaveLength(2);
    expect(
      workflow.match(/GIT_COMMIT=\$\{\{ steps\.labels\.outputs\.source_sha \}\}/g),
    ).toHaveLength(2);
  });

  it("does not override bundled plugin discovery in runtime images", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    expect(dockerfile).toContain(`ARG OPENCLAW_BUNDLED_PLUGIN_DIR=${BUNDLED_PLUGIN_ROOT_DIR}`);
    expect(dockerfile).not.toMatch(/^\s*ENV\b[^\n]*\bOPENCLAW_BUNDLED_PLUGINS_DIR\b/m);
  });

  it("normalizes plugin and agent paths permissions in image layers", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain(
      "RUN for dir in /app/${OPENCLAW_BUNDLED_PLUGIN_DIR} /app/.agent /app/.agents; do \\",
    );
    expect(dockerfile).toContain('find "$dir" -type d -exec chmod 755 {} +');
    expect(dockerfile).toContain('find "$dir" -type f -exec chmod 644 {} +');
  });

  it("Docker GPG fingerprint awk uses correct quoting for OPENCLAW_SANDBOX=1 build", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain('== "fpr" {');
    expect(dockerfile).not.toContain('\\"fpr\\"');
  });

  it("counts primary pub keys before Docker apt fingerprint compare and dearmor", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    const anchor = dockerfile.indexOf(
      "curl -fsSL https://download.docker.com/linux/debian/gpg -o /tmp/docker.gpg.asc",
    );
    expect(anchor).toBeGreaterThan(-1);
    const slice = dockerfile.slice(anchor);
    expect(slice).toContain("docker_gpg_pub_count=");
    expect(slice).toContain('$1 == "pub"');
    expect(slice).not.toContain('\\"pub\\"');
    const pubCountIdx = slice.indexOf("docker_gpg_pub_count=");
    const fpIdx = slice.indexOf("actual_fingerprint=");
    const dearmorIdx = slice.indexOf("gpg --dearmor");
    expect(pubCountIdx).toBeLessThan(fpIdx);
    expect(fpIdx).toBeLessThan(dearmorIdx);
    expect(slice).toContain('[ "$docker_gpg_pub_count" != "1" ]');
  });

  it("keeps runtime pnpm available", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain("ENV COREPACK_HOME=/usr/local/share/corepack");
    expect(dockerfile).toContain(
      'corepack prepare "$(node -p "require(\'./package.json\').packageManager")" --activate',
    );
  });

  it("pre-creates the OpenClaw home before switching to the node user", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const runtimeStageIndex = dockerfile.lastIndexOf("FROM base-runtime");
    const stateDirIndex = dockerfile.indexOf(
      "RUN install -d -m 0700 -o node -g node /home/node/.openclaw && \\",
      runtimeStageIndex,
    );
    const userIndex = dockerfile.indexOf("USER node", runtimeStageIndex);

    expect(runtimeStageIndex).toBeGreaterThan(-1);
    expect(stateDirIndex).toBeGreaterThan(-1);
    expect(userIndex).toBeGreaterThan(-1);
    expect(stateDirIndex).toBeGreaterThan(runtimeStageIndex);
    expect(stateDirIndex).toBeLessThan(userIndex);
    expect(dockerfile).not.toContain("mkdir -p /home/node/.openclaw");
    expect(dockerfile).toContain(
      "stat -c '%U:%G %a' /home/node/.openclaw | grep -qx 'node:node 700'",
    );
  });
});
