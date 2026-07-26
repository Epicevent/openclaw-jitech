import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import {
  exportProviderUsageReceipts,
  MAX_PROVIDER_USAGE_EXPORT_LIMIT,
} from "../agents/provider-usage-receipts.store.js";

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("Expected a non-negative safe integer.");
  }
  return parsed;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Expected a positive safe integer.");
  }
  return parsed;
}

export function registerUsageReceiptsCli(program: Command): void {
  const usageReceipts = program
    .command("usage-receipts")
    .description("Export content-free provider usage call receipts");

  usageReceipts
    .command("export")
    .description("Read immutable receipts after a monotonic ledger cursor")
    .option(
      "--after <ledgerSeq>",
      "Export rows after this ledger sequence",
      parseNonNegativeInteger,
      0,
    )
    .option(
      "--limit <count>",
      `Maximum receipts to return (max ${MAX_PROVIDER_USAGE_EXPORT_LIMIT})`,
      parsePositiveInteger,
      MAX_PROVIDER_USAGE_EXPORT_LIMIT,
    )
    .action((opts: { after: number; limit: number }) => {
      const result = exportProviderUsageReceipts({ after: opts.after, limit: opts.limit });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    });
}
