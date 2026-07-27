import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  assertProviderUsageCoverageManifest,
  buildProviderUsageCoverageManifest,
  readProviderUsageCoverageManifest,
} from "./provider-usage-coverage.js";

const fixtureUrl = new URL("./provider-usage-coverage.fixture.json", import.meta.url);
const routeFixtureUrl = new URL("./provider-usage-coverage-routes.fixture.json", import.meta.url);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const POST_HELPERS = new Set([
  "postJsonRequest",
  "postMultipartRequest",
  "postTranscriptionRequest",
]);
const DIRECT_RECEIPT_POST_FILES = [
  "extensions/google/image-generation-provider.ts",
  "extensions/google/media-understanding-provider.ts",
  "extensions/google/speech-provider.ts",
];

type RouteInventory = {
  schema: "jitech-provider-usage-route-inventory/v1";
  groups: Array<{
    surfaceCode: string;
    routes: Array<{ routeCode: string; sourceFile: string }>;
  }>;
};

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const pathname = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(pathname)));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(pathname);
    }
  }
  return files;
}

function propertyInitializer(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === name) ||
        (ts.isStringLiteral(property.name) && property.name.text === name))
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

function routeGroup(routeCode: string): string {
  if (routeCode.startsWith("image.")) {
    return "generation.image.other_submit";
  }
  if (routeCode.startsWith("music.")) {
    return "generation.music.other_submit";
  }
  if (routeCode.startsWith("video.")) {
    return "generation.video.other_submit";
  }
  if (routeCode.startsWith("media.")) {
    return "media.other_understanding";
  }
  if (routeCode.startsWith("speech.")) {
    return "speech.other_submit";
  }
  throw new Error(`Unknown provider usage route group for ${routeCode}`);
}

async function scanProviderUsageRoutes(): Promise<{
  routes: Array<{ surfaceCode: string; routeCode: string; sourceFile: string }>;
  directReceiptPostFiles: string[];
}> {
  const roots = [
    "src/image-generation",
    "src/video-generation",
    "src/tts",
    "src/media-understanding",
    "extensions",
  ];
  const routeFiles = new Map<string, string>();
  const directReceiptPostFiles = new Set<string>();
  for (const root of roots) {
    const files = await collectTypeScriptFiles(path.join(repoRoot, root));
    for (const filename of files) {
      const sourceText = await readFile(filename, "utf8");
      if (
        !sourceText.includes("postJsonRequest(") &&
        !sourceText.includes("postMultipartRequest(") &&
        !sourceText.includes("postTranscriptionRequest(") &&
        !sourceText.includes("runDashscopeVideoGenerationTask(")
      ) {
        continue;
      }
      const sourceFile = ts.createSourceFile(
        filename,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const relativeFile = path.relative(repoRoot, filename).split(path.sep).join("/");
      const recordRoute = (routeCode: string) => {
        const previousFile = routeFiles.get(routeCode);
        if (previousFile && previousFile !== relativeFile) {
          throw new Error(
            `Provider usage route ${routeCode} appears in both ${previousFile} and ${relativeFile}`,
          );
        }
        routeFiles.set(routeCode, relativeFile);
      };
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const callName = node.expression.text;
          const argument = node.arguments[0];
          if (callName === "runDashscopeVideoGenerationTask") {
            if (!argument || !ts.isObjectLiteralExpression(argument)) {
              throw new Error(`${relativeFile} has a non-literal DashScope submit descriptor`);
            }
            const surfaceCode = propertyInitializer(argument, "surfaceCode");
            if (!surfaceCode || !ts.isStringLiteral(surfaceCode)) {
              throw new Error(`${relativeFile} has no literal DashScope surfaceCode`);
            }
            recordRoute(surfaceCode.text);
          } else if (POST_HELPERS.has(callName)) {
            if (!argument || !ts.isObjectLiteralExpression(argument)) {
              throw new Error(`${relativeFile} has a non-literal ${callName} descriptor`);
            }
            const providerUsage = propertyInitializer(argument, "providerUsage");
            if (!providerUsage) {
              if (!DIRECT_RECEIPT_POST_FILES.includes(relativeFile)) {
                throw new Error(`${relativeFile} ${callName} has no providerUsage descriptor`);
              }
              directReceiptPostFiles.add(relativeFile);
            } else {
              if (!ts.isObjectLiteralExpression(providerUsage)) {
                throw new Error(`${relativeFile} providerUsage descriptor is not literal`);
              }
              const surfaceCode = propertyInitializer(providerUsage, "surfaceCode");
              if (
                relativeFile === "src/video-generation/dashscope-compatible.ts" &&
                surfaceCode &&
                ts.isPropertyAccessExpression(surfaceCode) &&
                surfaceCode.expression.getText(sourceFile) === "params" &&
                surfaceCode.name.text === "surfaceCode"
              ) {
                // The two provider-owned callers above supply the literal route code.
              } else if (surfaceCode && ts.isStringLiteral(surfaceCode)) {
                recordRoute(surfaceCode.text);
              } else {
                throw new Error(`${relativeFile} has no literal providerUsage.surfaceCode`);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }
  return {
    routes: [...routeFiles.entries()]
      .map(([routeCode, sourceFile]) => ({
        surfaceCode: routeGroup(routeCode),
        routeCode,
        sourceFile,
      }))
      .toSorted((left, right) => left.routeCode.localeCompare(right.routeCode)),
    directReceiptPostFiles: [...directReceiptPostFiles].toSorted(),
  };
}

describe("provider usage coverage manifest", () => {
  it("matches the versioned exact fixture and remains partial", async () => {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as unknown;
    assertProviderUsageCoverageManifest(fixture);
    expect(readProviderUsageCoverageManifest()).toEqual(fixture);
    expect((fixture as { coverageStatus: string }).coverageStatus).toBe("partial");
  });

  it("does not claim character-meter coverage without a stored quantity", () => {
    const speech = buildProviderUsageCoverageManifest().surfaces.find(
      (surface) => surface.surfaceCode === "speech.other_submit",
    );

    expect(speech).toMatchObject({
      meterFamily: "characters",
      usageObservation: "unavailable",
      status: "partial",
      gapCode: "character_quantity_unavailable",
    });
  });

  it("rejects changed canonical bytes and unsorted or duplicate surfaces", () => {
    const manifest = buildProviderUsageCoverageManifest();
    const changed = structuredClone(manifest);
    changed.surfaces[0].meterFamily = "other";
    expect(() => assertProviderUsageCoverageManifest(changed)).toThrow("manifestDigest mismatch");

    const unsorted = buildProviderUsageCoverageManifest();
    unsorted.surfaces.reverse();
    expect(() => assertProviderUsageCoverageManifest(unsorted)).toThrow("surface is invalid");
  });

  it("keeps every registered direct HTTP submit route equal to the grouped route fixture", async () => {
    const fixture = JSON.parse(await readFile(routeFixtureUrl, "utf8")) as RouteInventory;
    expect(Object.keys(fixture)).toEqual(["schema", "groups"]);
    expect(fixture.schema).toBe("jitech-provider-usage-route-inventory/v1");

    const manifestCodes = new Set(
      buildProviderUsageCoverageManifest().surfaces.map((surface) => surface.surfaceCode),
    );
    const expectedRoutes = fixture.groups
      .flatMap((group) => {
        expect(manifestCodes.has(group.surfaceCode), group.surfaceCode).toBe(true);
        expect(group.routes.map((route) => route.routeCode)).toEqual(
          group.routes.map((route) => route.routeCode).toSorted(),
        );
        return group.routes.map((route) => ({
          surfaceCode: group.surfaceCode,
          routeCode: route.routeCode,
          sourceFile: route.sourceFile,
        }));
      })
      .toSorted((left, right) => left.routeCode.localeCompare(right.routeCode));
    const scanned = await scanProviderUsageRoutes();

    expect(scanned.routes).toEqual(expectedRoutes);
    expect(scanned.directReceiptPostFiles).toEqual(DIRECT_RECEIPT_POST_FILES);
  });
});
