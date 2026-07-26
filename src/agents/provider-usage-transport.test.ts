import { describe, expect, it, vi } from "vitest";
import { wrapFetchWithProviderUsageAttempts } from "./provider-usage-transport.js";

describe("wrapFetchWithProviderUsageAttempts", () => {
  it("reports each physical SDK fetch and marks later fetches as retries", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("retry", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const onAttemptStarted = vi.fn();
    const onAttemptFailed = vi.fn();
    const wrapped = wrapFetchWithProviderUsageAttempts(fetchFn, {
      onAttemptStarted,
      onAttemptFailed,
    });

    await expect(wrapped("https://provider.invalid")).resolves.toMatchObject({ status: 429 });
    await expect(wrapped("https://provider.invalid")).resolves.toMatchObject({ status: 200 });

    expect(onAttemptStarted.mock.calls).toEqual([[{ retry: false }], [{ retry: true }]]);
    expect(onAttemptFailed).toHaveBeenCalledOnce();
    expect(onAttemptFailed).toHaveBeenCalledWith({ errorCategory: "http_429" });
  });

  it("records a thrown physical fetch before a later retry", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const onAttemptStarted = vi.fn();
    const onAttemptFailed = vi.fn();
    const wrapped = wrapFetchWithProviderUsageAttempts(fetchFn, {
      onAttemptStarted,
      onAttemptFailed,
    });

    await expect(wrapped("https://provider.invalid")).rejects.toThrow("network down");
    await expect(wrapped("https://provider.invalid")).resolves.toMatchObject({ status: 200 });

    expect(onAttemptStarted.mock.calls).toEqual([[{ retry: false }], [{ retry: true }]]);
    expect(onAttemptFailed).toHaveBeenCalledWith({ errorCategory: "TypeError" });
  });
});
