// Forward uncaught browser errors (e.g. "RangeError: Maximum call stack size exceeded")
// to the gateway so their stack + context land in the server log. Client crashes never
// reach the server on their own, so without this they are invisible after the browser
// tab is gone. Rate-limited and deduped so a render loop can't flood the log.

export type ClientErrorReport = {
  source: string;
  message: string;
  stack?: string;
  url: string;
};

type Sink = (report: ClientErrorReport) => void;

let sink: Sink | null = null;
let installed = false;
const recent = new Map<string, number>();
const DEDUPE_WINDOW_MS = 30_000;
const MAX_RECENT = 50;

/** Wire the transport once the gateway client exists; pass null to detach. */
export function setClientErrorSink(fn: Sink | null): void {
  sink = fn;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function reportClientError(source: string, message: string, stack?: string): void {
  if (!sink || !message) {
    return;
  }
  const key = `${source}:${message.slice(0, 160)}`;
  const now = Date.now();
  const last = recent.get(key);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
    return;
  }
  if (recent.size >= MAX_RECENT) {
    recent.clear();
  }
  recent.set(key, now);
  try {
    sink({
      source,
      message: truncate(message, 2000),
      ...(stack ? { stack: truncate(stack, 8000) } : {}),
      url: truncate(window.location.href, 500),
    });
  } catch {
    // Reporting must never throw — it would create a feedback loop.
  }
}

/** Register global error listeners. Safe to call more than once. */
export function installClientErrorReporter(): void {
  if (installed || typeof window === "undefined") {
    return;
  }
  installed = true;
  window.addEventListener("error", (event) => {
    const err: unknown = event.error;
    const message = err instanceof Error ? err.message : event.message || "unknown error";
    const stack = err instanceof Error ? err.stack : undefined;
    reportClientError("window.onerror", message, stack);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    const message =
      reason instanceof Error ? reason.message : typeof reason === "string" ? reason : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    reportClientError("unhandledrejection", message, stack);
  });
}
