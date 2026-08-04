import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { readKwragP0Status } from "../agents/kwrag-p0-status.js";
import { readKwragP1AttachmentStatus, runKwragP1UserTurnProof } from "../agents/kwrag-p1-thin.js";

function requireJson(opts: { json: boolean }): void {
  if (!opts.json) {
    throw new InvalidArgumentError("The command requires --json.");
  }
}

export function registerKwragP0Cli(program: Command): void {
  const kwragP0 = program
    .command("kwrag-p0")
    .description("Inspect the default-off content-free KWRAG P0 handoff ledger");

  kwragP0
    .command("status")
    .description("Read the current source binding and latest immutable P0 receipt")
    .option("--json", "Emit the exact machine-readable status contract", false)
    .action((opts: { json: boolean }) => {
      requireJson(opts);
      process.stdout.write(`${JSON.stringify(readKwragP0Status())}\n`);
    });

  kwragP0
    .command("p1-attachment-status")
    .option("--json", "Emit the exact machine status", false)
    .action((opts: { json: boolean }) => {
      requireJson(opts);
      process.stdout.write(`${JSON.stringify(readKwragP1AttachmentStatus())}\n`);
    });

  kwragP0
    .command("p1-user-turn-proof")
    .requiredOption("--query <text>", "Caller-explicit bounded retrieval query")
    .option("--json", "Emit the actual user-turn retrieval proof", false)
    .action(async (opts: { json: boolean; query: string }) => {
      requireJson(opts);
      process.stdout.write(`${JSON.stringify(await runKwragP1UserTurnProof(opts.query))}\n`);
    });
}
