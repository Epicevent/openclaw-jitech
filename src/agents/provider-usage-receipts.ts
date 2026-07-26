import { randomUUID } from "node:crypto";
import { appendProviderUsageReceipt } from "./provider-usage-receipts.store.js";
import {
  PROVIDER_USAGE_CALL_SCHEMA,
  type ProviderUsageCallReceipt,
  type ProviderUsageCallReceiptBody,
  type ProviderUsageCallStatus,
  type ProviderUsageCallTrigger,
  type ProviderUsageCoverage,
  type ProviderUsageDimensions,
  type ProviderUsageModelRef,
} from "./provider-usage-receipts.types.js";

const USAGE_FIELDS = [
  "inputTotal",
  "inputNonCached",
  "cacheRead",
  "cacheWrite",
  "outputCandidates",
  "reasoningThinking",
  "toolUsePrompt",
  "providerReportedTotal",
] as const;

type UsageField = (typeof USAGE_FIELDS)[number];

type ProviderUsageRunIdentity = {
  runId: string;
  turnId?: string | null;
  requestId?: string | number | null;
  sessionId?: string | null;
  trigger?: ProviderUsageCallTrigger;
  configuredProvider: string;
  configuredModel: string;
};

export type ProviderUsageCallHandle = {
  callId: string;
  runId: string | null;
  turnId: string | null;
  requestId: string | null;
  sessionId: string | null;
  trigger: ProviderUsageCallTrigger;
  attempt: number;
  retryOf: string | null;
  fallbackParent: string | null;
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
    rawProviderUsage: null,
  };
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
    rawProviderUsage: {
      source: "gemini_response.usageMetadata",
      promptTokenCount: prompt,
      cachedContentTokenCount: cacheRead,
      candidatesTokenCount: candidates,
      thoughtsTokenCount: thinking,
      toolUsePromptTokenCount: toolUse,
      totalTokenCount: total,
    },
  };
}

function extractNormalizedUsage(record: ProviderOutputRecord): ProviderUsageDimensions {
  const usage = asRecord(record.usage) ?? asRecord(record.timings);
  if (!usage) {
    return emptyUsage();
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
  const inputTotal = input !== null && cacheRead !== null ? input + cacheRead : null;
  const rawProviderUsage: Record<string, number | string | null> = {
    source: "assistant_message.usage",
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: total,
  };
  const hasAny = [input, output, cacheRead, cacheWrite, total].some((value) => value !== null);
  return {
    inputTotal,
    inputNonCached: input,
    cacheRead,
    cacheWrite,
    outputCandidates: output,
    reasoningThinking: null,
    toolUsePrompt: null,
    providerReportedTotal: total,
    rawProviderUsage: hasAny ? rawProviderUsage : null,
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
    usage: usage.rawProviderUsage ? usage : (current?.usage ?? usage),
  };
}

function coverageForUsage(usage: ProviderUsageDimensions): {
  coverage: ProviderUsageCoverage;
  missing: UsageField[];
} {
  const missing = USAGE_FIELDS.filter((field) => usage[field] === null);
  if (missing.length === USAGE_FIELDS.length) {
    return { coverage: "unavailable", missing: [...missing] };
  }
  return {
    coverage: missing.length === 0 ? "complete" : "partial",
    missing: [...missing],
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
      const lastSameRouteCallId = lastCallByRoute.get(requestedRouteKey) ?? null;
      const callId = randomUUID();
      const handle: ProviderUsageCallHandle = {
        callId,
        runId: normalizeString(identity.runId),
        turnId: normalizeString(identity.turnId ?? identity.runId),
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
        fallbackParent: requestedChanged ? (previousCall?.callId ?? null) : null,
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
  const usageCoverage = coverageForUsage(observation.usage);
  const actualModel = observation.responseModel;
  const body: ProviderUsageCallReceiptBody = {
    schema: PROVIDER_USAGE_CALL_SCHEMA,
    callId: params.handle.callId,
    runId: params.handle.runId,
    turnId: params.handle.turnId,
    requestId: params.handle.requestId,
    sessionId: params.handle.sessionId,
    trigger: params.handle.trigger,
    attempt: params.handle.attempt,
    retryOf: params.handle.retryOf,
    fallbackParent: params.handle.fallbackParent,
    startedAt: params.handle.startedAt,
    completedAt: new Date(params.completedAtMs ?? Date.now()).toISOString(),
    status: params.status,
    configured: params.handle.configured,
    requested: params.handle.requested,
    actual: {
      provider: actualModel ? params.handle.requested.provider : null,
      model: actualModel,
      responseId: observation.responseId,
      evidenceSource: actualModel ? observation.responseModelEvidenceSource : null,
    },
    usage: observation.usage,
    usageCoverage: usageCoverage.coverage,
    missingUsageFields: usageCoverage.missing,
    finishReason: observation.providerFinishReason,
    errorCategory: normalizeString(params.errorCategory),
  };
  return appendProviderUsageReceipt(body);
}
