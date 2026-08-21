import { Type } from "typebox";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { asToolParamsRecord, jsonResult, ToolInputError } from "./common.js";
import {
  defaultKakaoworkPackageDir,
  KAKAOWORK_PERIODS,
  KakaoworkPeriodRecords,
  type KakaoworkPeriod,
  type KakaoworkPeriodRecordsOptions,
  type KakaoworkPeriodRecordsRequest,
} from "./kakaowork-period-records.js";

const OPERATIONS = ["manifest", "read_batch", "reconcile"] as const;

const parameters = Type.Object(
  {
    operation: stringEnum(OPERATIONS, {
      description: "manifest, read_batch, or reconcile.",
    }),
    period: Type.Optional(
      stringEnum(KAKAOWORK_PERIODS, {
        description: "Required only for manifest. Arbitrary date ranges are not accepted.",
      }),
    ),
    snapshot_token: Type.Optional(
      Type.String({ description: "Opaque token returned by manifest." }),
    ),
    batch_id: Type.Optional(Type.String({ description: "Batch id returned by manifest." })),
    cursor: Type.Optional(
      Type.String({ description: "Opaque cursor returned as next_cursor by read_batch." }),
    ),
    coverage: Type.Optional(
      Type.Array(
        Type.Object(
          {
            batch_id: Type.String(),
            coverage_digest: Type.String(),
          },
          { additionalProperties: false },
        ),
        {
          maxItems: 10_000,
          description: "One final batch_coverage_digest for every manifest batch.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(`${key} required`);
  }
  return value;
}

function parseRequest(value: unknown): KakaoworkPeriodRecordsRequest {
  const params = asToolParamsRecord(value);
  const rawOperation = params.operation;
  if (!OPERATIONS.includes(rawOperation as (typeof OPERATIONS)[number])) {
    throw new ToolInputError("operation invalid");
  }
  const operation = rawOperation as (typeof OPERATIONS)[number];
  if (operation === "manifest") {
    if (Object.keys(params).some((key) => !["operation", "period"].includes(key))) {
      throw new ToolInputError("manifest arguments invalid");
    }
    const period = params.period;
    if (!KAKAOWORK_PERIODS.includes(period as KakaoworkPeriod)) {
      throw new ToolInputError("period required");
    }
    return { operation, period: period as KakaoworkPeriod };
  }
  const snapshotToken = requiredString(params, "snapshot_token");
  if (operation === "read_batch") {
    if (
      Object.keys(params).some(
        (key) => !["operation", "snapshot_token", "batch_id", "cursor"].includes(key),
      )
    ) {
      throw new ToolInputError("read_batch arguments invalid");
    }
    const rawCursor = params.cursor;
    if (rawCursor !== undefined && (typeof rawCursor !== "string" || rawCursor.length === 0)) {
      throw new ToolInputError("cursor invalid");
    }
    return {
      operation,
      snapshotToken,
      batchId: requiredString(params, "batch_id"),
      cursor: rawCursor,
    };
  }
  if (
    Object.keys(params).some((key) => !["operation", "snapshot_token", "coverage"].includes(key))
  ) {
    throw new ToolInputError("reconcile arguments invalid");
  }
  const rawCoverage = params.coverage;
  if (!Array.isArray(rawCoverage)) {
    throw new ToolInputError("coverage required");
  }
  const coverage = rawCoverage.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ToolInputError("coverage entry invalid");
    }
    const item = entry as Record<string, unknown>;
    if (
      Object.keys(item).length !== 2 ||
      typeof item.batch_id !== "string" ||
      typeof item.coverage_digest !== "string"
    ) {
      throw new ToolInputError("coverage entry invalid");
    }
    return { batchId: item.batch_id, coverageDigest: item.coverage_digest };
  });
  return { operation, snapshotToken, coverage };
}

export function createKakaoworkPeriodRecordsTool(
  options?: Partial<KakaoworkPeriodRecordsOptions>,
): AnyAgentTool | null {
  if (process.env.JITECH_KWRAG_RUNTIME_PROFILE !== "openclaw") {
    return null;
  }
  const records = new KakaoworkPeriodRecords({
    ...options,
    packageDir: options?.packageDir ?? defaultKakaoworkPackageDir(),
  });
  return {
    label: "KakaoWork period records",
    name: "jitech_kakaowork_period_records",
    displaySummary: "Enumerate the authorized KakaoWork package with exact coverage.",
    description:
      "Enumerates every authorized KakaoWork message for rolling_7d or " +
      "previous_calendar_week. Call manifest first, read every returned batch page, then " +
      "reconcile with every final batch coverage digest. The tool does not accept a user, room, path, " +
      "SQL statement, or arbitrary date range.",
    parameters,
    execute: async (_toolCallId, params) => jsonResult(records.execute(parseRequest(params))),
  };
}
