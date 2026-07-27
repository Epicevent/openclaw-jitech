import { randomUUID } from "node:crypto";
import {
  readProviderUsageCoverageManifest,
  type ProviderUsageCoverageManifest,
} from "./provider-usage-coverage.js";
import {
  deriveProviderUsageCoverage,
  deriveProviderUsageReceiptCoverage,
} from "./provider-usage-receipts.contract.js";
import { appendProviderUsageReceipt } from "./provider-usage-receipts.store.js";
import {
  PROVIDER_USAGE_CALL_SCHEMA,
  type ProviderUsageCallReceipt,
  type ProviderUsageCallReceiptBody,
  type ProviderUsageCallStatus,
  type ProviderUsageCallTrigger,
  type ProviderUsageDimensions,
  type ProviderUsageModelRef,
} from "./provider-usage-receipts.types.js";

export type ProviderUsageRunIdentity = {
  runId?: string | null;
  turnId?: string | null;
  requestId?: string | number | null;
  sessionId?: string | null;
  trigger?: ProviderUsageCallTrigger;
  configuredProvider: string;
  configuredModel: string;
};

export type ProviderUsageCallHandle = {
  callId: string;
  producerCoverageManifest: ProviderUsageCoverageManifest;
  runId: string | null;
  turnId: string | null;
  requestId: string | null;
  sessionId: string | null;
  trigger: ProviderUsageCallTrigger;
  attempt: number;
  retryOf: string | null;
  fallbackParent: string | null;
  fallbackIndex: number;
  startedAt: string;
  configured: ProviderUsageModelRef;
  requested: ProviderUsageModelRef;
};

export type ProviderUsageRunContext = {
  beginCall(params: {
    requestedProvider: string;
    requestedModel: string;
    embeddedAttempt: number;
    retryPrevious?: boolean;
    startedAtMs?: number;
  }): ProviderUsageCallHandle;
};

export type ProviderUsageCallObservation = {
  responseId: string | null;
  responseModel: string | null;
  responseModelEvidenceSource: string | null;
  providerFinishReason: string | null;
  usage: ProviderUsageDimensions;
};

export type ProviderUsageEvidenceRecorder = (evidence: unknown) => void;

type ProviderOutputRecord = Record<string, unknown>;

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeId(value: string | number | null | undefined): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return normalizeString(value);
}

function normalizeCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER);
}

function asRecord(value: unknown): ProviderOutputRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ProviderOutputRecord)
    : null;
}

function firstRecord(...values: unknown[]): ProviderOutputRecord | null {
  for (const value of values) {
    const record = asRecord(value);
    if (record) {
      return record;
    }
  }
  return null;
}

function emptyUsage(): ProviderUsageDimensions {
  return {
    inputTotal: null,
    inputNonCached: null,
    cacheRead: null,
    cacheWrite: null,
    outputCandidates: null,
    reasoningThinking: null,
    toolUsePrompt: null,
    providerReportedTotal: null,
    serviceTier: null,
    rawProviderUsage: null,
  };
}

export function buildGoogleProviderUsageEvidence(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  const usage = asRecord(record?.usageMetadata);
  const candidates = Array.isArray(record?.candidates) ? record.candidates : [];
  const firstCandidate = asRecord(candidates[0]);
  return {
    responseId: normalizeString(record?.responseId),
    responseModel: normalizeString(record?.modelVersion),
    responseModelEvidenceSource: normalizeString(record?.modelVersion)
      ? "gemini_response.modelVersion"
      : null,
    providerFinishReason: normalizeString(firstCandidate?.finishReason),
    providerUsage: usage
      ? {
          source: "gemini_response.usageMetadata",
          promptTokenCount: usage.promptTokenCount,
          cachedContentTokenCount: usage.cachedContentTokenCount,
          candidatesTokenCount: usage.candidatesTokenCount,
          thoughtsTokenCount: usage.thoughtsTokenCount,
          toolUsePromptTokenCount: usage.toolUsePromptTokenCount,
          totalTokenCount: usage.totalTokenCount,
          serviceTier: usage.serviceTier,
          trafficType: usage.trafficType,
          promptTokensDetails: usage.promptTokensDetails,
          cacheTokensDetails: usage.cacheTokensDetails,
          candidatesTokensDetails: usage.candidatesTokensDetails,
          toolUsePromptTokensDetails: usage.toolUsePromptTokensDetails,
        }
      : null,
  };
}

export function buildAnthropicProviderUsageEvidence(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  return {
    responseId: normalizeString(record?.id),
    responseModel: normalizeString(record?.model),
    responseModelEvidenceSource: normalizeString(record?.model) ? "anthropic_response.model" : null,
    providerFinishReason: normalizeString(record?.stop_reason),
    usage: asRecord(record?.usage),
  };
}

function normalizeUsageModalityDetails(
  value: unknown,
): Array<{ modality: string; tokenCount: number }> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized: Array<{ modality: string; tokenCount: number }> = [];
  for (const item of value) {
    const detail = asRecord(item);
    const modality = normalizeString(detail?.modality);
    const tokenCount = normalizeCount(detail?.tokenCount);
    if (!modality || modality.length > 64 || tokenCount === null) {
      return null;
    }
    normalized.push({ modality, tokenCount });
  }
  return normalized;
}

function extractGoogleUsage(record: ProviderOutputRecord): ProviderUsageDimensions | null {
  const raw = asRecord(record.providerUsage);
  if (!raw || raw.source !== "gemini_response.usageMetadata") {
    return null;
  }
  const prompt = normalizeCount(raw.promptTokenCount);
  const cacheRead = normalizeCount(raw.cachedContentTokenCount);
  const candidates = normalizeCount(raw.candidatesTokenCount);
  const thinking = normalizeCount(raw.thoughtsTokenCount);
  const toolUse = normalizeCount(raw.toolUsePromptTokenCount);
  const total = normalizeCount(raw.totalTokenCount);
  const serviceTier = normalizeString(raw.serviceTier);
  const inputNonCached =
    prompt !== null && cacheRead !== null ? Math.max(0, prompt - cacheRead) : null;
  return {
    inputTotal: prompt,
    inputNonCached,
    cacheRead,
    cacheWrite: null,
    outputCandidates: candidates,
    reasoningThinking: thinking,
    toolUsePrompt: toolUse,
    providerReportedTotal: total,
    serviceTier,
    rawProviderUsage: {
      promptTokenCount: prompt,
      cachedContentTokenCount: cacheRead,
      candidatesTokenCount: candidates,
      thoughtsTokenCount: thinking,
      toolUsePromptTokenCount: toolUse,
      totalTokenCount: total,
      serviceTier,
      trafficType: normalizeString(raw.trafficType),
      promptTokensDetails: normalizeUsageModalityDetails(raw.promptTokensDetails),
      cacheTokensDetails: normalizeUsageModalityDetails(raw.cacheTokensDetails),
      candidatesTokensDetails: normalizeUsageModalityDetails(raw.candidatesTokensDetails),
      toolUsePromptTokensDetails: normalizeUsageModalityDetails(raw.toolUsePromptTokensDetails),
    },
  };
}

function extractNormalizedUsage(record: ProviderOutputRecord): ProviderUsageDimensions | null {
  const usage = asRecord(record.usage) ?? asRecord(record.timings);
  if (!usage) {
    return null;
  }
  const input = normalizeCount(
    usage.input ??
      usage.inputTokens ??
      usage.input_tokens ??
      usage.promptTokens ??
      usage.prompt_tokens,
  );
  const output = normalizeCount(
    usage.output ??
      usage.outputTokens ??
      usage.output_tokens ??
      usage.completionTokens ??
      usage.completion_tokens,
  );
  const cacheRead = normalizeCount(
    usage.cacheRead ?? usage.cache_read ?? usage.cache_read_input_tokens,
  );
  const cacheWrite = normalizeCount(
    usage.cacheWrite ?? usage.cache_write ?? usage.cache_creation_input_tokens,
  );
  const total = normalizeCount(usage.totalTokens ?? usage.total_tokens ?? usage.total);
  const serviceTier = normalizeString(usage.serviceTier ?? usage.service_tier);
  const inputTotal = input !== null && cacheRead !== null ? input + cacheRead : null;
  return {
    inputTotal,
    inputNonCached: input,
    cacheRead,
    cacheWrite,
    outputCandidates: output,
    reasoningThinking: null,
    toolUsePrompt: null,
    providerReportedTotal: total,
    serviceTier,
    rawProviderUsage: null,
  };
}

export function observeProviderUsageCallChunk(
  current: ProviderUsageCallObservation | undefined,
  chunk: unknown,
): ProviderUsageCallObservation {
  const chunkRecord = asRecord(chunk);
  const output = chunkRecord
    ? firstRecord(chunkRecord.message, chunkRecord.error, chunkRecord.partial, chunkRecord)
    : null;
  if (!output) {
    return (
      current ?? {
        responseId: null,
        responseModel: null,
        responseModelEvidenceSource: null,
        providerFinishReason: null,
        usage: emptyUsage(),
      }
    );
  }
  const usage = extractGoogleUsage(output) ?? extractNormalizedUsage(output);
  const responseModelEvidenceSource = normalizeString(output.responseModelEvidenceSource);
  const evidencedResponseModel = responseModelEvidenceSource
    ? normalizeString(output.responseModel)
    : null;
  return {
    responseId: normalizeString(output.responseId) ?? current?.responseId ?? null,
    responseModel: evidencedResponseModel ?? current?.responseModel ?? null,
    responseModelEvidenceSource:
      (evidencedResponseModel ? responseModelEvidenceSource : null) ??
      current?.responseModelEvidenceSource ??
      null,
    providerFinishReason:
      normalizeString(output.providerFinishReason) ??
      normalizeString(output.stopReason) ??
      current?.providerFinishReason ??
      null,
    usage: usage ?? current?.usage ?? emptyUsage(),
  };
}

export function createProviderUsageRunContext(
  identity: ProviderUsageRunIdentity,
): ProviderUsageRunContext {
  const configured = {
    provider: identity.configuredProvider,
    model: identity.configuredModel,
  };
  let attempt = 0;
  let previousCall: {
    callId: string;
    embeddedAttempt: number;
    requested: ProviderUsageModelRef;
  } | null = null;
  const lastCallByRoute = new Map<string, string>();
  const configuredRouteKey = `${configured.provider}\0${configured.model}`;
  const fallbackIndexByRoute = new Map<string, number>([[configuredRouteKey, 0]]);
  const fallbackParentByRoute = new Map<string, string | null>([[configuredRouteKey, null]]);
  let nextFallbackIndex = 1;

  return {
    beginCall(params) {
      attempt += 1;
      const requested = {
        provider: params.requestedProvider,
        model: params.requestedModel,
      };
      const requestedChanged =
        previousCall !== null &&
        (previousCall.requested.provider !== requested.provider ||
          previousCall.requested.model !== requested.model);
      const embeddedAttemptChanged =
        previousCall !== null && previousCall.embeddedAttempt !== params.embeddedAttempt;
      const requestedRouteKey = `${requested.provider}\0${requested.model}`;
      let fallbackIndex = fallbackIndexByRoute.get(requestedRouteKey);
      if (fallbackIndex === undefined) {
        fallbackIndex = previousCall ? nextFallbackIndex : 0;
        fallbackIndexByRoute.set(requestedRouteKey, fallbackIndex);
        fallbackParentByRoute.set(requestedRouteKey, previousCall?.callId ?? null);
        if (fallbackIndex > 0) {
          nextFallbackIndex += 1;
        }
      }
      const lastSameRouteCallId = lastCallByRoute.get(requestedRouteKey) ?? null;
      const callId = randomUUID();
      const producerCoverageManifest = readProviderUsageCoverageManifest();
      const handle: ProviderUsageCallHandle = {
        callId,
        producerCoverageManifest,
        runId: normalizeString(identity.runId),
        turnId: normalizeString(identity.turnId === undefined ? identity.runId : identity.turnId),
        requestId: normalizeId(identity.requestId),
        sessionId: normalizeString(identity.sessionId),
        trigger: identity.trigger ?? "unknown",
        attempt,
        retryOf:
          params.retryPrevious || embeddedAttemptChanged
            ? lastSameRouteCallId
            : requestedChanged && lastSameRouteCallId
              ? lastSameRouteCallId
              : null,
        fallbackParent:
          fallbackIndex === 0 ? null : (fallbackParentByRoute.get(requestedRouteKey) ?? null),
        fallbackIndex,
        startedAt: new Date(params.startedAtMs ?? Date.now()).toISOString(),
        configured,
        requested,
      };
      previousCall = { callId, embeddedAttempt: params.embeddedAttempt, requested };
      lastCallByRoute.set(requestedRouteKey, callId);
      return handle;
    },
  };
}

export async function withProviderUsageCallReceipt<T>(params: {
  provider: string;
  model: string;
  identity?: Omit<ProviderUsageRunIdentity, "configuredProvider" | "configuredModel">;
  runContext?: ProviderUsageRunContext;
  retryPrevious?: boolean;
  embeddedAttempt?: number;
  run: (recordEvidence: ProviderUsageEvidenceRecorder) => Promise<T>;
}): Promise<T> {
  const run =
    params.runContext ??
    createProviderUsageRunContext({
      runId: params.identity?.runId ?? null,
      turnId: params.identity?.turnId ?? null,
      requestId: params.identity?.requestId ?? null,
      sessionId: params.identity?.sessionId ?? null,
      trigger: params.identity?.trigger ?? "unknown",
      configuredProvider: params.provider,
      configuredModel: params.model,
    });
  const handle = run.beginCall({
    requestedProvider: params.provider,
    requestedModel: params.model,
    embeddedAttempt: params.embeddedAttempt ?? 1,
    retryPrevious: params.retryPrevious,
  });
  let observation: ProviderUsageCallObservation | undefined;
  const recordEvidence = (evidence: unknown) => {
    observation = observeProviderUsageCallChunk(observation, evidence);
  };
  try {
    const value = await params.run(recordEvidence);
    persistProviderUsageCall({
      handle,
      status: "succeeded",
      observation,
    });
    return value;
  } catch (error) {
    persistProviderUsageCall({
      handle,
      status: "failed",
      observation,
      errorCategory:
        error instanceof Error && error.name.trim() ? error.name.trim() : "provider_call_error",
    });
    throw error;
  }
}

export function persistProviderUsageCall(params: {
  handle: ProviderUsageCallHandle;
  completedAtMs?: number;
  status: ProviderUsageCallStatus;
  observation?: ProviderUsageCallObservation;
  errorCategory?: string | null;
}): ProviderUsageCallReceipt {
  const observation = params.observation ?? {
    responseId: null,
    responseModel: null,
    responseModelEvidenceSource: null,
    providerFinishReason: null,
    usage: emptyUsage(),
  };
  const usageCoverage = deriveProviderUsageCoverage(observation.usage);
  const actualModel = observation.responseModel;
  const errorCategory = normalizeString(params.errorCategory);
  const actual = {
    provider: actualModel ? params.handle.requested.provider : null,
    model: actualModel,
    responseId: observation.responseId,
    evidenceSource: actualModel ? observation.responseModelEvidenceSource : null,
  };
  const finishReason = observation.providerFinishReason;
  const receiptCoverage = deriveProviderUsageReceiptCoverage({
    runId: params.handle.runId,
    turnId: params.handle.turnId,
    requestId: params.handle.requestId,
    sessionId: params.handle.sessionId,
    trigger: params.handle.trigger,
    status: params.status,
    actual,
    usage: observation.usage,
    finishReason,
    errorCategory,
  });
  const body: ProviderUsageCallReceiptBody = {
    schema: PROVIDER_USAGE_CALL_SCHEMA,
    producerCoverageDigest: params.handle.producerCoverageManifest.manifestDigest,
    callId: params.handle.callId,
    runId: params.handle.runId,
    turnId: params.handle.turnId,
    requestId: params.handle.requestId,
    sessionId: params.handle.sessionId,
    trigger: params.handle.trigger,
    attempt: params.handle.attempt,
    retryOf: params.handle.retryOf,
    fallbackParent: params.handle.fallbackParent,
    fallbackIndex: params.handle.fallbackIndex,
    startedAt: params.handle.startedAt,
    completedAt: new Date(params.completedAtMs ?? Date.now()).toISOString(),
    status: params.status,
    configured: params.handle.configured,
    requested: params.handle.requested,
    actual,
    usage: observation.usage,
    usageCoverage: usageCoverage.coverage,
    missingUsageFields: usageCoverage.missing,
    receiptCoverage: receiptCoverage.coverage,
    missingReceiptFields: receiptCoverage.missing,
    finishReason,
    errorCategory,
  };
  return appendProviderUsageReceipt(body, params.handle.producerCoverageManifest);
}
