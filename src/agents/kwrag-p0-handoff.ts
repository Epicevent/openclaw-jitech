import { createHash } from "node:crypto";
import { stableStringify } from "./stable-stringify.js";

export const KWRAG_P0_HANDOFF_SCHEMA = "jitech-openclaw-kwrag-p0-handoff/v1" as const;
export const KWRAG_P0_HANDOFF_RECEIPT_SCHEMA =
  "jitech-openclaw-kwrag-p0-handoff-receipt/v1" as const;
export const KWRAG_OPERATION_RECEIPT_SCHEMA = "jitech-kwrag-operation-receipt/v1" as const;
export const KWRAG_RESULT_RECEIPT_SCHEMA = "jitech-kwrag-result-receipt/v1" as const;
export const KWRAG_CONSUMPTION_RECEIPT_SCHEMA = "jitech-kwrag-consumption-receipt/v1" as const;

export type Sha256Digest = `sha256:${string}`;

export type KwragP0ExpectedBoundary = {
  traceId: string;
  slotInstanceId: string;
  mountAuthorityDigest: Sha256Digest;
  slotRuntimeBindingDigest: Sha256Digest;
};

export type KwragP0CallerHandoff = {
  expected: KwragP0ExpectedBoundary;
  handoff: unknown;
};

export const KWRAG_P1_UNRESOLVED_IDENTITY = Object.freeze({
  status: "RUNNER_READY_EXECUTION_BLOCKED" as const,
  pipelineFactoryDigest: null,
  backendId: null,
  pipelineFingerprint: null,
  researchDecisionDigest: null,
});

export type KwragP0HandoffReceipt = Readonly<{
  schema: typeof KWRAG_P0_HANDOFF_RECEIPT_SCHEMA;
  receiptDigest: Sha256Digest;
  handoffDigest: Sha256Digest;
  runId: string;
  traceId: string;
  sessionId: string;
  slotInstanceId: string;
  mountAuthorityDigest: Sha256Digest;
  slotRuntimeBindingDigest: Sha256Digest;
  operationSchema: typeof KWRAG_OPERATION_RECEIPT_SCHEMA;
  operationId: string;
  operationReceiptDigest: Sha256Digest;
  resultSchema: typeof KWRAG_RESULT_RECEIPT_SCHEMA;
  resultId: string;
  resultReceiptDigest: Sha256Digest;
  consumptionSchema: typeof KWRAG_CONSUMPTION_RECEIPT_SCHEMA;
  consumptionId: string;
  consumptionReceiptDigest: Sha256Digest;
  consumptionStatus: "not_consumed";
  promptInjectionApplied: false;
  p1Identity: typeof KWRAG_P1_UNRESOLVED_IDENTITY;
}>;

type KwragP0Handoff = {
  schema: typeof KWRAG_P0_HANDOFF_SCHEMA;
  handoffDigest: Sha256Digest;
  runId: string;
  traceId: string;
  slotInstanceId: string;
  mountAuthorityDigest: Sha256Digest;
  slotRuntimeBindingDigest: Sha256Digest;
  operation: {
    schema: typeof KWRAG_OPERATION_RECEIPT_SCHEMA;
    operationId: string;
    receiptDigest: Sha256Digest;
  };
  result: {
    schema: typeof KWRAG_RESULT_RECEIPT_SCHEMA;
    resultId: string;
    receiptDigest: Sha256Digest;
    operationReceiptDigest: Sha256Digest;
  };
  consumption: {
    schema: typeof KWRAG_CONSUMPTION_RECEIPT_SCHEMA;
    consumptionId: string;
    receiptDigest: Sha256Digest;
    operationReceiptDigest: Sha256Digest;
    resultReceiptDigest: Sha256Digest;
    status: "not_consumed";
  };
};

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const CALLER_HANDOFF_FIELDS = ["expected", "handoff"] as const;
const EXPECTED_BOUNDARY_FIELDS = [
  "traceId",
  "slotInstanceId",
  "mountAuthorityDigest",
  "slotRuntimeBindingDigest",
] as const;
const HANDOFF_FIELDS = [
  "schema",
  "handoffDigest",
  "runId",
  "traceId",
  "slotInstanceId",
  "mountAuthorityDigest",
  "slotRuntimeBindingDigest",
  "operation",
  "result",
  "consumption",
] as const;
const OPERATION_FIELDS = ["schema", "operationId", "receiptDigest"] as const;
const RESULT_FIELDS = ["schema", "resultId", "receiptDigest", "operationReceiptDigest"] as const;
const CONSUMPTION_FIELDS = [
  "schema",
  "consumptionId",
  "receiptDigest",
  "operationReceiptDigest",
  "resultReceiptDigest",
  "status",
] as const;

export class KwragP0HandoffContractError extends Error {
  constructor(message: string) {
    super(`KWRAG P0 handoff contract violation: ${message}`);
    this.name = "KwragP0HandoffContractError";
  }
}

function fail(message: string): never {
  throw new KwragP0HandoffContractError(message);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expectedFields: readonly string[],
  path: string,
): void {
  const actual = Object.keys(record).toSorted();
  const expected = [...expectedFields].toSorted();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    fail(`${path} fields must be exactly ${expected.join(",")}`);
  }
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) {
    fail(`${path} must be a bounded identifier`);
  }
  return value;
}

function digest(value: unknown, path: string): Sha256Digest {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) {
    fail(`${path} must be a lower-case SHA-256 digest`);
  }
  return value as Sha256Digest;
}

export function digestKwragP0Canonical(value: unknown): Sha256Digest {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export function digestKwragP0CanonicalWithoutField(value: unknown, field: string): Sha256Digest {
  const body = { ...asRecord(value, "digest input") };
  delete body[field];
  return digestKwragP0Canonical(body);
}

function parseHandoff(value: unknown): KwragP0Handoff {
  const handoff = asRecord(value, "retrievalHandoff.handoff");
  assertExactKeys(handoff, HANDOFF_FIELDS, "retrievalHandoff.handoff");
  if (handoff.schema !== KWRAG_P0_HANDOFF_SCHEMA) {
    fail(`retrievalHandoff.handoff.schema must be ${KWRAG_P0_HANDOFF_SCHEMA}`);
  }
  const handoffDigest = digest(handoff.handoffDigest, "retrievalHandoff.handoff.handoffDigest");
  if (handoffDigest !== digestKwragP0CanonicalWithoutField(handoff, "handoffDigest")) {
    fail("retrievalHandoff.handoff.handoffDigest does not match canonical bytes");
  }

  const operation = asRecord(handoff.operation, "retrievalHandoff.handoff.operation");
  assertExactKeys(operation, OPERATION_FIELDS, "retrievalHandoff.handoff.operation");
  const result = asRecord(handoff.result, "retrievalHandoff.handoff.result");
  assertExactKeys(result, RESULT_FIELDS, "retrievalHandoff.handoff.result");
  const consumption = asRecord(handoff.consumption, "retrievalHandoff.handoff.consumption");
  assertExactKeys(consumption, CONSUMPTION_FIELDS, "retrievalHandoff.handoff.consumption");
  if (operation.schema !== KWRAG_OPERATION_RECEIPT_SCHEMA) {
    fail(`retrievalHandoff operation.schema must be ${KWRAG_OPERATION_RECEIPT_SCHEMA}`);
  }
  if (result.schema !== KWRAG_RESULT_RECEIPT_SCHEMA) {
    fail(`retrievalHandoff result.schema must be ${KWRAG_RESULT_RECEIPT_SCHEMA}`);
  }
  if (consumption.schema !== KWRAG_CONSUMPTION_RECEIPT_SCHEMA) {
    fail(`retrievalHandoff consumption.schema must be ${KWRAG_CONSUMPTION_RECEIPT_SCHEMA}`);
  }

  const operationReceiptDigest = digest(
    operation.receiptDigest,
    "retrievalHandoff.handoff.operation.receiptDigest",
  );
  const resultReceiptDigest = digest(
    result.receiptDigest,
    "retrievalHandoff.handoff.result.receiptDigest",
  );
  const consumptionReceiptDigest = digest(
    consumption.receiptDigest,
    "retrievalHandoff.handoff.consumption.receiptDigest",
  );
  if (result.operationReceiptDigest !== operationReceiptDigest) {
    fail("retrievalHandoff result must link the exact operation receipt digest");
  }
  if (
    consumption.operationReceiptDigest !== operationReceiptDigest ||
    consumption.resultReceiptDigest !== resultReceiptDigest
  ) {
    fail("retrievalHandoff consumption must link the exact operation and result receipts");
  }
  if (consumption.status !== "not_consumed") {
    fail("retrievalHandoff consumption.status must be not_consumed for P0");
  }

  return {
    schema: KWRAG_P0_HANDOFF_SCHEMA,
    handoffDigest,
    runId: identifier(handoff.runId, "retrievalHandoff.handoff.runId"),
    traceId: identifier(handoff.traceId, "retrievalHandoff.handoff.traceId"),
    slotInstanceId: identifier(handoff.slotInstanceId, "retrievalHandoff.handoff.slotInstanceId"),
    mountAuthorityDigest: digest(
      handoff.mountAuthorityDigest,
      "retrievalHandoff.handoff.mountAuthorityDigest",
    ),
    slotRuntimeBindingDigest: digest(
      handoff.slotRuntimeBindingDigest,
      "retrievalHandoff.handoff.slotRuntimeBindingDigest",
    ),
    operation: {
      schema: KWRAG_OPERATION_RECEIPT_SCHEMA,
      operationId: identifier(
        operation.operationId,
        "retrievalHandoff.handoff.operation.operationId",
      ),
      receiptDigest: operationReceiptDigest,
    },
    result: {
      schema: KWRAG_RESULT_RECEIPT_SCHEMA,
      resultId: identifier(result.resultId, "retrievalHandoff.handoff.result.resultId"),
      receiptDigest: resultReceiptDigest,
      operationReceiptDigest,
    },
    consumption: {
      schema: KWRAG_CONSUMPTION_RECEIPT_SCHEMA,
      consumptionId: identifier(
        consumption.consumptionId,
        "retrievalHandoff.handoff.consumption.consumptionId",
      ),
      receiptDigest: consumptionReceiptDigest,
      operationReceiptDigest,
      resultReceiptDigest,
      status: "not_consumed",
    },
  };
}

export function verifyOptionalKwragP0Handoff(params: {
  input?: KwragP0CallerHandoff;
  runId: string;
  sessionId: string;
}): KwragP0HandoffReceipt | null {
  if (!params.input) {
    return null;
  }
  const input = asRecord(params.input, "retrievalHandoff");
  assertExactKeys(input, CALLER_HANDOFF_FIELDS, "retrievalHandoff");
  const expected = asRecord(input.expected, "retrievalHandoff.expected");
  assertExactKeys(expected, EXPECTED_BOUNDARY_FIELDS, "retrievalHandoff.expected");
  const handoff = parseHandoff(input.handoff);
  const expectedTraceId = identifier(expected.traceId, "retrievalHandoff.expected.traceId");
  const expectedSlotInstanceId = identifier(
    expected.slotInstanceId,
    "retrievalHandoff.expected.slotInstanceId",
  );
  const expectedMountAuthorityDigest = digest(
    expected.mountAuthorityDigest,
    "retrievalHandoff.expected.mountAuthorityDigest",
  );
  const expectedSlotRuntimeBindingDigest = digest(
    expected.slotRuntimeBindingDigest,
    "retrievalHandoff.expected.slotRuntimeBindingDigest",
  );
  if (handoff.runId !== params.runId || handoff.traceId !== expectedTraceId) {
    fail("retrievalHandoff must match the current run and expected trace");
  }
  if (
    handoff.slotInstanceId !== expectedSlotInstanceId ||
    handoff.mountAuthorityDigest !== expectedMountAuthorityDigest ||
    handoff.slotRuntimeBindingDigest !== expectedSlotRuntimeBindingDigest
  ) {
    fail("retrievalHandoff must match the expected same-slot read-only boundary");
  }

  const body = {
    schema: KWRAG_P0_HANDOFF_RECEIPT_SCHEMA,
    handoffDigest: handoff.handoffDigest,
    runId: handoff.runId,
    traceId: handoff.traceId,
    sessionId: identifier(params.sessionId, "sessionId"),
    slotInstanceId: handoff.slotInstanceId,
    mountAuthorityDigest: handoff.mountAuthorityDigest,
    slotRuntimeBindingDigest: handoff.slotRuntimeBindingDigest,
    operationSchema: handoff.operation.schema,
    operationId: handoff.operation.operationId,
    operationReceiptDigest: handoff.operation.receiptDigest,
    resultSchema: handoff.result.schema,
    resultId: handoff.result.resultId,
    resultReceiptDigest: handoff.result.receiptDigest,
    consumptionSchema: handoff.consumption.schema,
    consumptionId: handoff.consumption.consumptionId,
    consumptionReceiptDigest: handoff.consumption.receiptDigest,
    consumptionStatus: "not_consumed" as const,
    promptInjectionApplied: false as const,
    p1Identity: KWRAG_P1_UNRESOLVED_IDENTITY,
  };
  return Object.freeze({
    ...body,
    receiptDigest: digestKwragP0Canonical(body),
  });
}
