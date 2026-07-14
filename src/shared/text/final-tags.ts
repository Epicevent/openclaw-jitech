export type FinalTagMatch = {
  index: number;
  text: string;
  isClose: boolean;
  isSelfClosing: boolean;
};

const FINAL_TAG_CANDIDATE_RE = /<[^<>]*>/g;

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function parseAttributeList(text: string): boolean {
  let index = 0;
  while (index < text.length) {
    while (index < text.length && isWhitespace(text[index] ?? "")) {
      index += 1;
    }
    if (index >= text.length) {
      return true;
    }

    const nameStart = index;
    while (index < text.length) {
      const char = text[index] ?? "";
      if (isWhitespace(char) || char === "=") {
        break;
      }
      if (char === "/" || char === '"' || char === "'" || char === "<" || char === ">") {
        return false;
      }
      index += 1;
    }
    if (index === nameStart) {
      return false;
    }

    while (index < text.length && isWhitespace(text[index] ?? "")) {
      index += 1;
    }
    if (text[index] !== "=") {
      continue;
    }
    index += 1;
    while (index < text.length && isWhitespace(text[index] ?? "")) {
      index += 1;
    }
    if (index >= text.length) {
      return false;
    }

    const quote = text[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      const end = text.indexOf(quote, index);
      if (end === -1) {
        return false;
      }
      index = end + 1;
      continue;
    }

    const valueStart = index;
    while (index < text.length && !isWhitespace(text[index] ?? "")) {
      const char = text[index] ?? "";
      if (char === '"' || char === "'" || char === "<" || char === ">") {
        return false;
      }
      index += 1;
    }
    if (index === valueStart) {
      return false;
    }
  }
  return true;
}

export function parseFinalTag(text: string): Omit<FinalTagMatch, "index" | "text"> | null {
  if (!text.startsWith("<") || !text.endsWith(">")) {
    return null;
  }

  let body = text.slice(1, -1).trimStart();
  let isClose = false;
  if (body.startsWith("/")) {
    isClose = true;
    body = body.slice(1).trimStart();
  }

  if (!body.toLowerCase().startsWith("final")) {
    return null;
  }
  const boundary = body[5] ?? "";
  if (boundary && !isWhitespace(boundary) && boundary !== "/") {
    return null;
  }

  let rest = body.slice(5);
  if (isClose) {
    return rest.trim().length === 0 ? { isClose: true, isSelfClosing: false } : null;
  }

  const trimmedRest = rest.trimEnd();
  const isSelfClosing = trimmedRest.endsWith("/");
  rest = isSelfClosing ? trimmedRest.slice(0, -1) : rest;
  if (!parseAttributeList(rest)) {
    return null;
  }
  return { isClose: false, isSelfClosing };
}

export function findFinalTagMatches(text: string): FinalTagMatch[] {
  const matches: FinalTagMatch[] = [];
  for (const match of text.matchAll(FINAL_TAG_CANDIDATE_RE)) {
    const tagText = match[0];
    const parsed = parseFinalTag(tagText);
    if (!parsed) {
      continue;
    }
    matches.push({
      index: match.index ?? 0,
      text: tagText,
      ...parsed,
    });
  }
  return matches;
}

export function containsFinalTag(text: string): boolean {
  return findFinalTagMatches(text).length > 0;
}

/**
 * Unwrap a whole-message bare `<text>…</text>` scaffold wrapper (issue #59). Some
 * models wrap their final answer in `<text>…</text>` the way others use
 * `<final>…</final>`, and it leaks into the dashboard as raw tags.
 *
 * We ONLY strip it when a bare `<text>` (no attributes) sits at the very start and a
 * matching `</text>` at the very end — i.e. it brackets the ENTIRE content. That is
 * the safe discriminator against SVG: attribute-checking alone is not enough because
 * an SVG's *closing* `</text>` is also bare, so a naive per-tag strip would delete
 * the closers of `<svg><text x=…>label</text></svg>` and corrupt the diagram. An
 * embedded SVG never brackets the whole message, so this wrapper-only rule leaves it
 * (opener, label, and closer) completely intact.
 */
export function stripBareTextWrapper(text: string): string {
  const open = /^\s*<\s*text\s*>/i.exec(text);
  if (!open) {
    return text;
  }
  const close = /<\s*\/\s*text\s*>\s*$/i.exec(text);
  if (!close) {
    return text;
  }
  const innerStart = open[0].length;
  const innerEnd = close.index;
  if (innerEnd < innerStart) {
    return text;
  }
  return text.slice(innerStart, innerEnd);
}

export function stripFinalTags(text: string): string {
  let output = "";
  let lastIndex = 0;
  for (const match of findFinalTagMatches(text)) {
    output += text.slice(lastIndex, match.index);
    lastIndex = match.index + match.text.length;
  }
  output += text.slice(lastIndex);
  return output;
}
