// Passive model/session-store health recorder (issue #32).
//
// The oc1 incident opened with every infra indicator green while the customer
// path was dead: provider failures surfaced nowhere greppable and the gateway
// exposed no "when did a model call last succeed?" signal. This module fixes
// both observability gaps with zero active probing (issue #32's constraint:
// synthetic calls during a quota incident make the incident worse):
//
//  - B1: every failed model attempt emits ONE greppable line
//    (`model-call-failed provider=.. model=.. status=..`), as does every
//    session-store save failure. `grep model-call-failed` answers in seconds
//    what previously took log archaeology.
//  - B2: in-memory counters (last success/failure, consecutive failures,
//    store-save failures) exposed through the gateway health payload, so ops
//    can distinguish "gateway up" from "customer path dead" from the outside.
//
// State is process-local and intentionally ephemeral — a restart resets it,
// which is correct for "is the serving path healthy NOW?" questions.
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("model-health");

export type ModelCallFailureRecord = {
  at: number;
  provider: string;
  model: string;
  status?: number;
  code?: string;
  reason?: string;
  sessionId?: string;
  lane?: string;
};

export type ModelHealthSnapshot = {
  lastSuccess?: { at: number; provider: string; model: string };
  lastFailure?: ModelCallFailureRecord;
  consecutiveFailures: number;
  recentFailures: ModelCallFailureRecord[];
  sessionStore: {
    saveFailureCount: number;
    lastSaveFailure?: { at: number; storePath: string; error: string };
  };
};

const RECENT_FAILURE_CAP = 50;

let lastSuccess: ModelHealthSnapshot["lastSuccess"];
let lastFailure: ModelCallFailureRecord | undefined;
let consecutiveFailures = 0;
let recentFailures: ModelCallFailureRecord[] = [];
let saveFailureCount = 0;
let lastSaveFailure: ModelHealthSnapshot["sessionStore"]["lastSaveFailure"];

export function recordModelCallSuccess(params: { provider: string; model: string }): void {
  const hadFailures = consecutiveFailures > 0;
  lastSuccess = { at: Date.now(), provider: params.provider, model: params.model };
  consecutiveFailures = 0;
  if (hadFailures) {
    log.info(`model-call-recovered provider=${params.provider} model=${params.model}`);
  }
}

export function recordModelCallFailure(
  params: Omit<ModelCallFailureRecord, "at"> & { attempt?: number; totalCandidates?: number },
): void {
  const record: ModelCallFailureRecord = {
    at: Date.now(),
    provider: params.provider,
    model: params.model,
    ...(params.status !== undefined ? { status: params.status } : {}),
    ...(params.code !== undefined ? { code: params.code } : {}),
    ...(params.reason !== undefined ? { reason: params.reason } : {}),
    ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
    ...(params.lane !== undefined ? { lane: params.lane } : {}),
  };
  lastFailure = record;
  consecutiveFailures += 1;
  recentFailures.push(record);
  if (recentFailures.length > RECENT_FAILURE_CAP) {
    recentFailures = recentFailures.slice(-RECENT_FAILURE_CAP);
  }
  // The greppable line. Keep the key=value shape stable: ops tooling and
  // humans mid-incident both grep for `model-call-failed`.
  log.error(
    `model-call-failed provider=${record.provider} model=${record.model}` +
      (record.status !== undefined ? ` status=${record.status}` : "") +
      (record.code ? ` code=${record.code}` : "") +
      (record.reason ? ` reason=${record.reason}` : "") +
      (params.attempt !== undefined && params.totalCandidates !== undefined
        ? ` attempt=${params.attempt}/${params.totalCandidates}`
        : "") +
      (record.sessionId ? ` session=${record.sessionId}` : "") +
      (record.lane ? ` lane=${record.lane}` : "") +
      ` consecutive=${consecutiveFailures}`,
  );
}

export function recordSessionStoreSaveFailure(params: { storePath: string; error: unknown }): void {
  saveFailureCount += 1;
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  lastSaveFailure = { at: Date.now(), storePath: params.storePath, error: message };
  log.error(
    `session-store-save-failed store=${params.storePath} count=${saveFailureCount} error=${message}`,
  );
}

export function getModelHealthSnapshot(): ModelHealthSnapshot {
  return {
    ...(lastSuccess ? { lastSuccess } : {}),
    ...(lastFailure ? { lastFailure } : {}),
    consecutiveFailures,
    recentFailures: [...recentFailures],
    sessionStore: {
      saveFailureCount,
      ...(lastSaveFailure ? { lastSaveFailure } : {}),
    },
  };
}

export function resetModelHealthForTest(): void {
  lastSuccess = undefined;
  lastFailure = undefined;
  consecutiveFailures = 0;
  recentFailures = [];
  saveFailureCount = 0;
  lastSaveFailure = undefined;
}
