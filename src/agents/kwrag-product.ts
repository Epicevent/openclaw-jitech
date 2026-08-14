import {
  prepareKwragP1EvidenceForExplicitScope,
} from "./kwrag-p1-thin.js";
import type { KwragP1VerifiedEvidence } from "./kwrag-p1-thin.js";

export type KwragProductRetrievalRoom = { source: string; roomId: string };
export type KwragProductRetrievalScope = {
  sources?: string[];
  rooms?: KwragProductRetrievalRoom[];
};
export type KwragProductRetrievalRequest = {
  scope?: KwragProductRetrievalScope;
  query: string;
};

const SOURCE_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;
const MAX_SCOPE_ITEMS = 64;

function normalizeScope(value: unknown): KwragProductRetrievalScope | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("KWRAG retrieval violation: scope is invalid");
  }
  const scope = value as Record<string, unknown>;
  if (Object.keys(scope).some((key) => key !== "sources" && key !== "rooms")) {
    throw new Error("KWRAG retrieval violation: scope is invalid");
  }
  const normalizeNames = (raw: unknown): string[] | undefined => {
    if (raw === undefined) {
      return undefined;
    }
    if (!Array.isArray(raw) || raw.length > MAX_SCOPE_ITEMS) {
      throw new Error("KWRAG retrieval violation: scope sources are invalid");
    }
    const names = raw.map((item) => {
      if (typeof item !== "string" || !SOURCE_NAME.test(item)) {
        throw new Error("KWRAG retrieval violation: scope source is invalid");
      }
      return item;
    });
    if (new Set(names).size !== names.length) {
      throw new Error("KWRAG retrieval violation: scope sources are duplicated");
    }
    return names;
  };
  const sources = normalizeNames(scope.sources);
  let rooms: KwragProductRetrievalRoom[] | undefined;
  if (scope.rooms !== undefined) {
    if (!Array.isArray(scope.rooms) || scope.rooms.length > MAX_SCOPE_ITEMS) {
      throw new Error("KWRAG retrieval violation: scope rooms are invalid");
    }
    rooms = scope.rooms.map((raw) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("KWRAG retrieval violation: scope room is invalid");
      }
      const room = raw as Record<string, unknown>;
      if (Object.keys(room).some((key) => key !== "source" && key !== "roomId")) {
        throw new Error("KWRAG retrieval violation: scope room is invalid");
      }
      if (
        typeof room.source !== "string" ||
        !SOURCE_NAME.test(room.source) ||
        typeof room.roomId !== "string" ||
        !room.roomId.trim() ||
        room.roomId.length > 256
      ) {
        throw new Error("KWRAG retrieval violation: scope room is invalid");
      }
      return { source: room.source, roomId: room.roomId };
    });
  }
  if (sources === undefined && rooms === undefined) {
    return undefined;
  }
  return {
    ...(sources !== undefined ? { sources } : {}),
    ...(rooms !== undefined ? { rooms } : {}),
  };
}

export type { KwragP1VerifiedEvidence } from "./kwrag-p1-thin.js";

/**
 * Connect the actual caller to the installed fixed-producer seam. The
 * producer owns source/index/runtime admission; this adapter only validates
 * the caller envelope and translates its source-neutral scope.
 */
export async function prepareKwragProductEvidenceForExplicitQuery(params: {
  retrieval: KwragProductRetrievalRequest;
  runId: string;
  sessionId: string;
  slotInstanceId?: string;
  signal?: AbortSignal;
}): Promise<KwragP1VerifiedEvidence> {
  const scope = normalizeScope(params.retrieval?.scope);
  if (
    !params.retrieval ||
    typeof params.retrieval.query !== "string" ||
    !params.retrieval.query.trim() ||
    params.retrieval.query.length > 4_000 ||
    typeof params.runId !== "string" ||
    !params.runId.trim() ||
    typeof params.sessionId !== "string" ||
    !params.sessionId.trim()
  ) {
    throw new Error("KWRAG retrieval violation: explicit retrieval request is invalid");
  }
  void params.slotInstanceId;
  return prepareKwragP1EvidenceForExplicitScope({
    retrieval: {
      query: params.retrieval.query,
      ...(scope ? { scope } : {}),
    },
    runId: params.runId,
    signal: params.signal,
  });
}
