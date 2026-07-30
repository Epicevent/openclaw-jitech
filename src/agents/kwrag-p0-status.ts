import { resolveExactCommitHash } from "../infra/git-commit.js";
import { KwragP0HandoffContractError, KWRAG_P1_UNRESOLVED_IDENTITY } from "./kwrag-p0-handoff.js";
import {
  readKwragP0HandoffLedgerSnapshot,
  type StoredKwragP0HandoffReceipt,
} from "./kwrag-p0-handoff.store.js";

export const KWRAG_P0_STATUS_SCHEMA = "jitech-openclaw-kwrag-p0-status/v1" as const;
const EXACT_COMMIT_RE = /^[0-9a-f]{40}$/u;

export type KwragP0Status = Readonly<{
  schema: typeof KWRAG_P0_STATUS_SCHEMA;
  invocationMode: "caller_explicit";
  defaultEnabled: false;
  currentProductSourceCommit: string;
  ledgerAvailable: boolean;
  highWatermark: number | null;
  latest: StoredKwragP0HandoffReceipt | null;
  p1Identity: typeof KWRAG_P1_UNRESOLVED_IDENTITY;
}>;

export function readKwragP0Status(
  params: {
    env?: NodeJS.ProcessEnv;
    currentProductSourceCommit?: string | null;
  } = {},
): KwragP0Status {
  const currentProductSourceCommit =
    params.currentProductSourceCommit ??
    resolveExactCommitHash({ moduleUrl: import.meta.url, env: params.env });
  if (!currentProductSourceCommit || !EXACT_COMMIT_RE.test(currentProductSourceCommit)) {
    throw new KwragP0HandoffContractError("status requires an exact product source commit");
  }
  const ledger = readKwragP0HandoffLedgerSnapshot(params.env);
  return Object.freeze({
    schema: KWRAG_P0_STATUS_SCHEMA,
    invocationMode: "caller_explicit",
    defaultEnabled: false,
    currentProductSourceCommit,
    ledgerAvailable: ledger.ledgerAvailable,
    highWatermark: ledger.highWatermark,
    latest: ledger.latest,
    p1Identity: KWRAG_P1_UNRESOLVED_IDENTITY,
  });
}
