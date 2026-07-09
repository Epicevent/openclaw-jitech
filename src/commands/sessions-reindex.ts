import { reindexSessionStoreFromTranscripts } from "../config/sessions/store-reindex.js";
import { getRuntimeConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { writeRuntimeJson } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { resolveSessionStoreTargetsOrExit } from "./session-store-targets.js";

export type SessionsReindexOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
  write?: boolean;
  json?: boolean;
};

export async function sessionsReindexCommand(
  opts: SessionsReindexOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = getRuntimeConfig();
  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: { store: opts.store, agent: opts.agent, allAgents: opts.allAgents },
    runtime,
  });
  if (!targets) {
    return;
  }

  const reports = [];
  for (const target of targets) {
    const report = await reindexSessionStoreFromTranscripts({
      storePath: target.storePath,
      agentId: target.agentId,
      write: Boolean(opts.write),
    });
    reports.push({ agentId: target.agentId, ...report });
  }

  if (opts.json) {
    writeRuntimeJson(runtime, reports);
    return;
  }

  for (const report of reports) {
    runtime.log(`Session store: ${report.storePath}`);
    if (report.storeUnreadable) {
      runtime.log(
        theme.warn(
          "  store file exists but is unreadable — rebuilding the index from transcripts",
        ),
      );
    }
    runtime.log(
      `  scanned=${report.scanned} orphans=${report.orphans} ` +
        `recoverable=${report.additions.length} skipped=${report.skipped.length}`,
    );
    for (const addition of report.additions) {
      runtime.log(
        `  add   ${addition.kind.padEnd(9)} ${addition.key}` +
          (addition.headerMismatch ? "  (header.id != filename — trusting filename)" : ""),
      );
    }
    for (const skip of report.skipped) {
      runtime.log(`  skip  ${skip.file}  (${skip.reason})`);
    }
    if (report.wrote) {
      if (report.backupPath) {
        runtime.log(`  pre-reindex backup: ${report.backupPath}`);
      }
      if (report.corruptCopyPath) {
        runtime.log(`  corrupt store preserved: ${report.corruptCopyPath}`);
      }
      runtime.log(theme.success(`  wrote ${report.additions.length} recovered entries.`));
    } else if (report.additions.length > 0) {
      runtime.log(
        theme.warn(
          `  DRY RUN — would add ${report.additions.length} entries. Re-run with --write to apply.`,
        ),
      );
    } else {
      runtime.log("  nothing to recover.");
    }
  }
}
