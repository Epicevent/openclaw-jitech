import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export function resolveProviderUsageReceiptDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "usage");
}

export function resolveProviderUsageReceiptDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveProviderUsageReceiptDir(env), "provider-calls.sqlite");
}
