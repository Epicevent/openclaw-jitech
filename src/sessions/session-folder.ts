export const SESSION_FOLDER_MAX_DEPTH = 4;
export const SESSION_FOLDER_SEGMENT_MAX_LENGTH = 60;
export const SESSION_FOLDER_MAX_LENGTH = 200;

export type ParsedSessionFolderPath =
  | { ok: true; folderPath: string }
  | { ok: false; error: string };

// Walk by code point rather than regex — the no-control-regex lint rule
// forbids control characters inside character classes.
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a user-supplied session folder path ("전구체/액상") into its canonical
 * stored form: NFC-normalized, "/"-joined trimmed segments. Folder trees in the
 * control UI are derived purely from these per-session paths, so this parser is
 * the single place that defines what a valid folder location is.
 */
export function parseSessionFolderPath(raw: unknown): ParsedSessionFolderPath {
  if (typeof raw !== "string") {
    return { ok: false, error: "invalid folderPath: must be a string" };
  }
  const normalized = raw.normalize("NFC");
  if (hasControlChars(normalized)) {
    return { ok: false, error: "invalid folderPath: control characters are not allowed" };
  }
  const segments = normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return { ok: false, error: "invalid folderPath: empty" };
  }
  if (segments.length > SESSION_FOLDER_MAX_DEPTH) {
    return {
      ok: false,
      error: `invalid folderPath: too deep (max ${SESSION_FOLDER_MAX_DEPTH} levels)`,
    };
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      return { ok: false, error: "invalid folderPath: '.' and '..' segments are not allowed" };
    }
    if (segment.length > SESSION_FOLDER_SEGMENT_MAX_LENGTH) {
      return {
        ok: false,
        error: `invalid folderPath: segment too long (max ${SESSION_FOLDER_SEGMENT_MAX_LENGTH})`,
      };
    }
  }
  const folderPath = segments.join("/");
  if (folderPath.length > SESSION_FOLDER_MAX_LENGTH) {
    return {
      ok: false,
      error: `invalid folderPath: too long (max ${SESSION_FOLDER_MAX_LENGTH})`,
    };
  }
  return { ok: true, folderPath };
}
