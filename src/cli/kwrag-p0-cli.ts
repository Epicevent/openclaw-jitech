import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { readKwragP0Status } from "../agents/kwrag-p0-status.js";

export function registerKwragP0Cli(program: Command): void {
  const kwragP0 = program
    .command("kwrag-p0")
    .description("Inspect the default-off content-free KWRAG P0 handoff ledger");

  kwragP0
    .command("status")
    .description("Read the current source binding and latest immutable P0 receipt")
    .option("--json", "Emit the exact machine-readable status contract", false)
    .action((opts: { json: boolean }) => {
      if (!opts.json) {
        throw new InvalidArgumentError("The status command requires --json.");
      }
      process.stdout.write(`${JSON.stringify(readKwragP0Status())}\n`);
    });
}
