import { createHash } from "node:crypto";

export const PROVIDER_USAGE_COVERAGE_SCHEMA = "jitech-provider-usage-coverage/v1" as const;

const OBSERVATION_KINDS = ["per_call", "turn_aggregate", "request_only"] as const;
const METER_FAMILIES = ["tokens", "image", "audio", "characters", "search", "other"] as const;
const MODEL_EVIDENCE = ["provider_response", "requested_only", "unavailable"] as const;
const RETRY_OBSERVATION = ["physical_attempt", "logical_call_only", "unavailable"] as const;
const USAGE_OBSERVATION = ["provider_reported", "request_observed", "unavailable"] as const;
const SURFACE_STATUS = ["implemented", "partial", "gap"] as const;

export type ProviderUsageCoverageSurface = {
  surfaceCode: string;
  observationKind: (typeof OBSERVATION_KINDS)[number];
  meterFamily: (typeof METER_FAMILIES)[number];
  modelEvidence: (typeof MODEL_EVIDENCE)[number];
  retryObservation: (typeof RETRY_OBSERVATION)[number];
  usageObservation: (typeof USAGE_OBSERVATION)[number];
  status: (typeof SURFACE_STATUS)[number];
  gapCode: string | null;
};

export type ProviderUsageCoverageManifest = {
  schema: typeof PROVIDER_USAGE_COVERAGE_SCHEMA;
  productFamily: "openclaw";
  manifestDigest: string;
  coverageStatus: "complete" | "partial";
  surfaces: ProviderUsageCoverageSurface[];
};

const SURFACES: ProviderUsageCoverageSurface[] = [
  {
    surfaceCode: "codex.app_server.turn_usage",
    observationKind: "turn_aggregate",
    meterFamily: "tokens",
    modelEvidence: "requested_only",
    retryObservation: "unavailable",
    usageObservation: "provider_reported",
    status: "partial",
    gapCode: "codex_turn_aggregate_not_exported",
  },
  {
    surfaceCode: "generation.image.google_submit",
    observationKind: "per_call",
    meterFamily: "image",
    modelEvidence: "provider_response",
    retryObservation: "logical_call_only",
    usageObservation: "provider_reported",
    status: "implemented",
    gapCode: null,
  },
  {
    surfaceCode: "generation.image.other_submit",
    observationKind: "per_call",
    meterFamily: "image",
    modelEvidence: "requested_only",
    retryObservation: "logical_call_only",
    usageObservation: "request_observed",
    status: "implemented",
    gapCode: null,
  },
  {
    surfaceCode: "generation.music.google_submit",
    observationKind: "per_call",
    meterFamily: "audio",
    modelEvidence: "provider_response",
    retryObservation: "logical_call_only",
    usageObservation: "provider_reported",
    status: "implemented",
    gapCode: null,
  },
  {
    surfaceCode: "generation.music.other_submit",
    observationKind: "per_call",
    meterFamily: "audio",
    modelEvidence: "requested_only",
    retryObservation: "logical_call_only",
    usageObservation: "request_observed",
    status: "implemented",
    gapCode: null,
  },
  {
    surfaceCode: "generation.status_poll",
    observationKind: "request_only",
    meterFamily: "other",
    modelEvidence: "unavailable",
    retryObservation: "logical_call_only",
    usageObservation: "unavailable",
    status: "implemented",
    gapCode: null,
  },
  {
    surfaceCode: "generation.video.other_submit",
    observationKind: "per_call",
    meterFamily: "other",
    modelEvidence: "requested_only",
    retryObservation: "logical_call_only",
    usageObservation: "request_observed",
    status: "implemented",
    gapCode: null,
  },
  {
    surfaceCode: "llm.anthropic_transport",
    observationKind: "per_call",
    meterFamily: "tokens",
    modelEvidence: "provider_response",
    retryObservation: "physical_attempt",
    usageObservation: "provider_reported",
    status: "implemented",
    gapCode: null,
  },
  {
    surfaceCode: "llm.direct_internal",
    observationKind: "per_call",
    meterFamily: "tokens",
    modelEvidence: "provider_response",
    retryObservation: "logical_call_only",
    usageObservation: "provider_reported",
    status: "implemented",
    gapCode: null,
  },
  {
    surfaceCode: "llm.google_transport",
    observationKind: "per_call",
    meterFamily: "tokens",
    modelEvidence: "provider_response",
    retryObservation: "physical_attempt",
    usageObservation: "provider_reported",
    status: "implemented",
    gapCode: null,
  },
  {
    surfaceCode: "llm.openai_transport",
    observationKind: "per_call",
    meterFamily: "tokens",
    modelEvidence: "provider_response",
    retryObservation: "physical_attempt",
    usageObservation: "provider_reported",
    status: "implemented",
    gapCode: null,
  },
  {
    surfaceCode: "llm.pi_native_codex",
    observationKind: "per_call",
    meterFamily: "tokens",
    modelEvidence: "requested_only",
    retryObservation: "logical_call_only",
    usageObservation: "provider_reported",
    status: "partial",
    gapCode: "pi_native_codex_internal_retry_unobserved",
  },
  {
    surfaceCode: "media.google_understanding",
    observationKind: "per_call",
    meterFamily: "other",
    modelEvidence: "provider_response",
    retryObservation: "logical_call_only",
    usageObservation: "provider_reported",
    status: "implemented",
    gapCode: null,
  },
  {
    surfaceCode: "media.minimax_vlm",
    observationKind: "per_call",
    meterFamily: "image",
    modelEvidence: "unavailable",
    retryObservation: "logical_call_only",
    usageObservation: "unavailable",
    status: "implemented",
    gapCode: null,
  },
  {
    surfaceCode: "media.other_understanding",
    observationKind: "per_call",
    meterFamily: "other",
    modelEvidence: "requested_only",
    retryObservation: "logical_call_only",
    usageObservation: "request_observed",
    status: "implemented",
    gapCode: null,
  },
  {
    surfaceCode: "search.google_grounded",
    observationKind: "per_call",
    meterFamily: "search",
    modelEvidence: "provider_response",
    retryObservation: "logical_call_only",
    usageObservation: "provider_reported",
    status: "implemented",
    gapCode: null,
  },
  {
    surfaceCode: "speech.google_tts_submit",
    observationKind: "per_call",
    meterFamily: "audio",
    modelEvidence: "provider_response",
    retryObservation: "physical_attempt",
    usageObservation: "provider_reported",
    status: "implemented",
    gapCode: null,
  },
  {
    surfaceCode: "speech.other_submit",
    observationKind: "per_call",
    meterFamily: "characters",
    modelEvidence: "requested_only",
    retryObservation: "logical_call_only",
    usageObservation: "request_observed",
    status: "implemented",
    gapCode: null,
  },
];

const TOP_LEVEL_KEYS = [
  "schema",
  "productFamily",
  "manifestDigest",
  "coverageStatus",
  "surfaces",
] as const;
const SURFACE_KEYS = [
  "surfaceCode",
  "observationKind",
  "meterFamily",
  "modelEvidence",
  "retryObservation",
  "usageObservation",
  "status",
  "gapCode",
] as const;

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalJsonValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    );
  }
  return value;
}

function canonicalManifestBytes(params: {
  schema: string;
  productFamily: string;
  coverageStatus: string;
  surfaces: ProviderUsageCoverageSurface[];
}): string {
  return JSON.stringify(
    canonicalJsonValue({
      schema: params.schema,
      productFamily: params.productFamily,
      coverageStatus: params.coverageStatus,
      surfaces: params.surfaces,
    }),
  );
}

export function digestProviderUsageCoverageManifest(params: {
  schema: string;
  productFamily: string;
  coverageStatus: string;
  surfaces: ProviderUsageCoverageSurface[];
}): string {
  const digest = createHash("sha256").update(canonicalManifestBytes(params)).digest("hex");
  return `sha256:${digest}`;
}

export function buildProviderUsageCoverageManifest(): ProviderUsageCoverageManifest {
  const surfaces = SURFACES.map((surface) => Object.assign({}, surface));
  const coverageStatus = surfaces.every((surface) => surface.status === "implemented")
    ? "complete"
    : "partial";
  return {
    schema: PROVIDER_USAGE_COVERAGE_SCHEMA,
    productFamily: "openclaw",
    manifestDigest: digestProviderUsageCoverageManifest({
      schema: PROVIDER_USAGE_COVERAGE_SCHEMA,
      productFamily: "openclaw",
      coverageStatus,
      surfaces,
    }),
    coverageStatus,
    surfaces,
  };
}

function isEnumValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

export function assertProviderUsageCoverageManifest(
  value: unknown,
): asserts value is ProviderUsageCoverageManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider usage coverage manifest must be an object");
  }
  const manifest = value as Record<string, unknown>;
  if (!hasExactKeys(manifest, TOP_LEVEL_KEYS)) {
    throw new Error("Provider usage coverage manifest has non-exact top-level fields");
  }
  if (
    manifest.schema !== PROVIDER_USAGE_COVERAGE_SCHEMA ||
    manifest.productFamily !== "openclaw" ||
    (manifest.coverageStatus !== "complete" && manifest.coverageStatus !== "partial") ||
    typeof manifest.manifestDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(manifest.manifestDigest) ||
    !Array.isArray(manifest.surfaces)
  ) {
    throw new Error("Provider usage coverage manifest metadata is invalid");
  }

  let previousCode = "";
  for (const item of manifest.surfaces) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !hasExactKeys(item, SURFACE_KEYS)
    ) {
      throw new Error("Provider usage coverage surface has non-exact fields");
    }
    const surface = item as Record<string, unknown>;
    if (
      typeof surface.surfaceCode !== "string" ||
      !surface.surfaceCode ||
      surface.surfaceCode <= previousCode ||
      !isEnumValue(OBSERVATION_KINDS, surface.observationKind) ||
      !isEnumValue(METER_FAMILIES, surface.meterFamily) ||
      !isEnumValue(MODEL_EVIDENCE, surface.modelEvidence) ||
      !isEnumValue(RETRY_OBSERVATION, surface.retryObservation) ||
      !isEnumValue(USAGE_OBSERVATION, surface.usageObservation) ||
      !isEnumValue(SURFACE_STATUS, surface.status) ||
      (surface.gapCode !== null &&
        (typeof surface.gapCode !== "string" || !/^[a-z0-9_]+$/u.test(surface.gapCode)))
    ) {
      throw new Error("Provider usage coverage surface is invalid");
    }
    if (
      (surface.status === "implemented" && surface.gapCode !== null) ||
      (surface.status !== "implemented" && surface.gapCode === null)
    ) {
      throw new Error("Provider usage coverage surface gap status is inconsistent");
    }
    previousCode = surface.surfaceCode;
  }

  const expectedCoverage = (manifest.surfaces as ProviderUsageCoverageSurface[]).every(
    (surface) => surface.status === "implemented",
  )
    ? "complete"
    : "partial";
  if (manifest.coverageStatus !== expectedCoverage) {
    throw new Error("Provider usage coverageStatus disagrees with surface status");
  }
  const expectedDigest = digestProviderUsageCoverageManifest({
    schema: manifest.schema,
    productFamily: manifest.productFamily,
    coverageStatus: manifest.coverageStatus,
    surfaces: manifest.surfaces as ProviderUsageCoverageSurface[],
  });
  if (manifest.manifestDigest !== expectedDigest) {
    throw new Error("Provider usage coverage manifestDigest mismatch");
  }
}

export function serializeProviderUsageCoverageManifest(
  manifest: ProviderUsageCoverageManifest,
): string {
  assertProviderUsageCoverageManifest(manifest);
  return JSON.stringify(manifest);
}

export function readProviderUsageCoverageManifest(): ProviderUsageCoverageManifest {
  const manifest = buildProviderUsageCoverageManifest();
  assertProviderUsageCoverageManifest(manifest);
  return manifest;
}
