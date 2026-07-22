import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installClientErrorReporter, setClientErrorSink } from "./client-error-reporter.ts";

function dispatchError(err: Error): void {
  window.dispatchEvent(new ErrorEvent("error", { error: err, message: err.message }));
}

function dispatchRejection(reason: unknown): void {
  const evt = new Event("unhandledrejection");
  (evt as unknown as { reason: unknown }).reason = reason;
  window.dispatchEvent(evt);
}

describe("client error reporter", () => {
  beforeEach(() => {
    installClientErrorReporter();
  });
  afterEach(() => {
    setClientErrorSink(null);
  });

  it("forwards an uncaught error with message, stack and url", () => {
    const sink = vi.fn();
    setClientErrorSink(sink);
    dispatchError(new RangeError("Maximum call stack size exceeded [case-a]"));

    expect(sink).toHaveBeenCalledTimes(1);
    const report = sink.mock.calls[0]?.[0];
    expect(report.source).toBe("window.onerror");
    expect(report.message).toContain("Maximum call stack size exceeded [case-a]");
    expect(report.stack).toBeTruthy();
    expect(typeof report.url).toBe("string");
  });

  it("dedupes the same error within the window", () => {
    const sink = vi.fn();
    setClientErrorSink(sink);
    const message = "duplicate boom [case-b]";
    dispatchError(new Error(message));
    dispatchError(new Error(message));

    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("forwards an unhandled promise rejection", () => {
    const sink = vi.fn();
    setClientErrorSink(sink);
    dispatchRejection(new Error("rejected work [case-c]"));

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0].source).toBe("unhandledrejection");
  });

  it("does not throw when no sink is attached", () => {
    setClientErrorSink(null);
    expect(() => dispatchError(new Error("no sink [case-d]"))).not.toThrow();
  });
});
