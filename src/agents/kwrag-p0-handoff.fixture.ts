import {
  digestKwragP0Canonical,
  KWRAG_CONSUMPTION_RECEIPT_SCHEMA,
  KWRAG_OPERATION_RECEIPT_SCHEMA,
  KWRAG_P0_HANDOFF_SCHEMA,
  KWRAG_RESULT_RECEIPT_SCHEMA,
  type KwragP0CallerHandoff,
  type Sha256Digest,
} from "./kwrag-p0-handoff.js";

export const KWRAG_P0_TEST_OPERATION_DIGEST: Sha256Digest = `sha256:${"1".repeat(64)}`;
export const KWRAG_P0_TEST_RESULT_DIGEST: Sha256Digest = `sha256:${"2".repeat(64)}`;
export const KWRAG_P0_TEST_CONSUMPTION_DIGEST: Sha256Digest = `sha256:${"3".repeat(64)}`;
export const KWRAG_P0_TEST_MOUNT_DIGEST: Sha256Digest = `sha256:${"4".repeat(64)}`;
export const KWRAG_P0_TEST_BINDING_DIGEST: Sha256Digest = `sha256:${"5".repeat(64)}`;
export const KWRAG_P0_TEST_HANDOFF_DIGEST =
  "sha256:2f1c5cf09e54542a7f872ec3150705e93d38de40a2ce6215578edc15d47971f8";
export const KWRAG_P0_TEST_RECEIPT_DIGEST =
  "sha256:5f4b242cc6af2b9ab32346556849ea50704c4e7dbc839b80c0070936423ac5f3";

export function buildKwragP0TestHandoff(
  mutate?: (body: Record<string, unknown>) => void,
): KwragP0CallerHandoff {
  const body: Record<string, unknown> = {
    schema: KWRAG_P0_HANDOFF_SCHEMA,
    runId: "run-p0-1",
    traceId: "trace-p0-1",
    slotInstanceId: "slot-dev-oc-fixture",
    mountAuthorityDigest: KWRAG_P0_TEST_MOUNT_DIGEST,
    slotRuntimeBindingDigest: KWRAG_P0_TEST_BINDING_DIGEST,
    operation: {
      schema: KWRAG_OPERATION_RECEIPT_SCHEMA,
      operationId: "operation-p0-1",
      receiptDigest: KWRAG_P0_TEST_OPERATION_DIGEST,
    },
    result: {
      schema: KWRAG_RESULT_RECEIPT_SCHEMA,
      resultId: "result-p0-1",
      receiptDigest: KWRAG_P0_TEST_RESULT_DIGEST,
      operationReceiptDigest: KWRAG_P0_TEST_OPERATION_DIGEST,
    },
    consumption: {
      schema: KWRAG_CONSUMPTION_RECEIPT_SCHEMA,
      consumptionId: "consumption-p0-1",
      receiptDigest: KWRAG_P0_TEST_CONSUMPTION_DIGEST,
      operationReceiptDigest: KWRAG_P0_TEST_OPERATION_DIGEST,
      resultReceiptDigest: KWRAG_P0_TEST_RESULT_DIGEST,
      status: "not_consumed",
    },
  };
  mutate?.(body);
  return {
    expected: {
      traceId: "trace-p0-1",
      slotInstanceId: "slot-dev-oc-fixture",
      mountAuthorityDigest: KWRAG_P0_TEST_MOUNT_DIGEST,
      slotRuntimeBindingDigest: KWRAG_P0_TEST_BINDING_DIGEST,
    },
    handoff: {
      ...body,
      handoffDigest: digestKwragP0Canonical(body),
    },
  };
}
