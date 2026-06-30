// Shared prompt + sanitizer for AI-suggested session titles (sessions.suggestLabel).
// The product owns this logic; opsctl/UI never call a model directly.

export const SESSION_TITLE_SYSTEM_PROMPT =
  "You name chat sessions. Given a conversation, reply with a short, specific title " +
  "(at most 6 words) that captures its topic, written in the same language as the " +
  "conversation. Reply with ONLY the title — no quotes, no surrounding punctuation, no preamble.";

// Headroom, not a target: it caps the completion. Non-thinking models emit the
// short title and stop early; thinking models (e.g. gemini-2.5-flash) spend
// tokens on reasoning first, so a small cap (e.g. 24) leaves no room for the
// visible title and yields an empty suggestion. 512 covers both.
export const SESSION_TITLE_MAX_TOKENS = 512;
export const SESSION_TITLE_TIMEOUT_MS = 10_000;

const MAX_TITLE_CHARS = 60;
const FIRST_MESSAGE_MAX_CHARS = 800;
const LAST_MESSAGE_MAX_CHARS = 400;

export type SessionTitleContextFields = {
  firstUserMessage?: string | null;
  lastMessagePreview?: string | null;
};

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Build the user prompt from the transcript-derived title fields. Returns null
 * when there is no usable context (so the caller can no-op with an empty suggestion).
 */
export function buildSessionTitleUserPrompt(fields: SessionTitleContextFields): string | null {
  const first = fields.firstUserMessage?.trim() ?? "";
  const last = fields.lastMessagePreview?.trim() ?? "";
  const parts: string[] = [];
  if (first) {
    parts.push(`First user message:\n${truncate(first, FIRST_MESSAGE_MAX_CHARS)}`);
  }
  if (last && last !== first) {
    parts.push(`Most recent message:\n${truncate(last, LAST_MESSAGE_MAX_CHARS)}`);
  }
  if (parts.length === 0) {
    return null;
  }
  return `${parts.join("\n\n")}\n\nGenerate a short title (max 6 words) for this conversation. Reply with only the title.`;
}

/**
 * Normalize a raw model completion into a safe single-line session title:
 * first line only, quotes/backticks stripped, whitespace collapsed, trailing
 * punctuation removed, length-capped. Returns "" when nothing usable remains.
 */
export function sanitizeSuggestedSessionTitle(raw: string): string {
  if (!raw) {
    return "";
  }
  let title = raw.trim();
  const newlineIndex = title.search(/\r?\n/);
  if (newlineIndex >= 0) {
    title = title.slice(0, newlineIndex).trim();
  }
  // Strip wrapping straight/smart quotes and backticks.
  title = title.replace(/^["'`“”‘’]+/, "").replace(/["'`“”‘’]+$/, "");
  title = title.replace(/\s+/g, " ").trim();
  // Drop trailing sentence punctuation a model may append.
  title = title.replace(/[.,;:!?]+$/, "").trim();
  if (title.length > MAX_TITLE_CHARS) {
    title = title.slice(0, MAX_TITLE_CHARS).trim();
  }
  return title;
}
