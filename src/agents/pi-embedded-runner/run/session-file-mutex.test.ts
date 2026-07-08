import { describe, expect, it } from "vitest";

import { withSessionFileMutex } from "./session-file-mutex.ts";

async function microtasks(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await Promise.resolve();
  }
}

describe("withSessionFileMutex", () => {
  it("serializes calls for the same session file with no overlap (FIFO)", async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const guarded = (label: string) =>
      withSessionFileMutex("/tmp/openclaw-mutex-same.jsonl", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`${label}:start`);
        await microtasks(3);
        order.push(`${label}:end`);
        active -= 1;
      });

    await Promise.all([guarded("A"), guarded("B"), guarded("C")]);

    expect(maxActive).toBe(1);
    expect(order).toEqual(["A:start", "A:end", "B:start", "B:end", "C:start", "C:end"]);
  });

  it("runs calls for different session files in parallel", async () => {
    let active = 0;
    let maxActive = 0;
    const guarded = (file: string) =>
      withSessionFileMutex(file, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await microtasks(3);
        active -= 1;
      });

    await Promise.all([
      guarded("/tmp/openclaw-mutex-a.jsonl"),
      guarded("/tmp/openclaw-mutex-b.jsonl"),
      guarded("/tmp/openclaw-mutex-c.jsonl"),
    ]);

    expect(maxActive).toBeGreaterThan(1);
  });

  it("runs unguarded (no serialization) when the session file is empty", async () => {
    let active = 0;
    let maxActive = 0;
    const guarded = () =>
      withSessionFileMutex("", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await microtasks(3);
        active -= 1;
      });

    await Promise.all([guarded(), guarded()]);

    expect(maxActive).toBe(2);
  });

  it("releases the mutex when the guarded function throws", async () => {
    const file = "/tmp/openclaw-mutex-throw.jsonl";
    await expect(
      withSessionFileMutex(file, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A throwing run must not wedge the file for the next one.
    await expect(withSessionFileMutex(file, async () => "ok")).resolves.toBe("ok");
  });
});
