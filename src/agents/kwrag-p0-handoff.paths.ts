import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export function resolveKwragP0HandoffReceiptDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "retrieval");
}

export function resolveKwragP0HandoffReceiptDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveKwragP0HandoffReceiptDir(env), "kwrag-p0-handoffs.sqlite");
}
