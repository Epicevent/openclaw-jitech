// Server WS maxPayload. The client receives this value in the connect handshake, so it
// stays aligned automatically. Raised from 25MB to 200MB to allow large file attachments:
// the 25MB cap rejected them with "Max payload size exceeded" (WS close), while the browser
// handles payloads this size comfortably (measured ~0.5GB heap at 200MB) and real
// attachments are far smaller.
export const MAX_PAYLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_BUFFERED_BYTES = 400 * 1024 * 1024; // per-connection send buffer limit (2x max payload)
export const MAX_PREAUTH_PAYLOAD_BYTES = 64 * 1024;

const DEFAULT_MAX_CHAT_HISTORY_MESSAGES_BYTES = 6 * 1024 * 1024; // keep history responses comfortably under client WS limits
let maxChatHistoryMessagesBytes = DEFAULT_MAX_CHAT_HISTORY_MESSAGES_BYTES;

export const getMaxChatHistoryMessagesBytes = () => maxChatHistoryMessagesBytes;

export const setMaxChatHistoryMessagesBytesForTest = (value?: number) => {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    return;
  }
  if (value === undefined) {
    maxChatHistoryMessagesBytes = DEFAULT_MAX_CHAT_HISTORY_MESSAGES_BYTES;
    return;
  }
  if (Number.isFinite(value) && value > 0) {
    maxChatHistoryMessagesBytes = value;
  }
};
export const TICK_INTERVAL_MS = 30_000;
export const HEALTH_REFRESH_INTERVAL_MS = 60_000;
export const DEDUPE_TTL_MS = 5 * 60_000;
export const DEDUPE_MAX = 1000;
