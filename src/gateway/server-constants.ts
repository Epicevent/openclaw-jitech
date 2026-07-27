const MEBIBYTE = 1024 * 1024;

// Chat attachments travel inside a JSON WebSocket frame as base64. The transport
// ceiling therefore has to cover the encoded bytes, not just the source file.
export const DEFAULT_CHAT_ATTACHMENT_MAX_MB = 200;
export const DEFAULT_CHAT_ATTACHMENT_MAX_BYTES = DEFAULT_CHAT_ATTACHMENT_MAX_MB * MEBIBYTE;
export const CHAT_ATTACHMENT_WS_ENVELOPE_HEADROOM_BYTES = 8 * MEBIBYTE;

export function estimateBase64EncodedBytes(decodedBytes: number): number {
  return 4 * Math.ceil(decodedBytes / 3);
}

export const MAX_PAYLOAD_BYTES =
  estimateBase64EncodedBytes(DEFAULT_CHAT_ATTACHMENT_MAX_BYTES) +
  CHAT_ATTACHMENT_WS_ENVELOPE_HEADROOM_BYTES;
export const MAX_BUFFERED_BYTES = MAX_PAYLOAD_BYTES * 2;
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
