// W1b: the fence-tripped diagnostic must name exactly which stat fields
// changed, so the concurrent writer's shape is identifiable in logs (issue #35).
import { describe, expect, it } from "vitest";
import { describeSessionFileFingerprintDelta } from "./attempt.session-lock.js";

const base = {
  exists: true as const,
  dev: 1n,
  ino: 100n,
  size: 500n,
  mtimeNs: 1000n,
  ctimeNs: 1000n,
};

describe("describeSessionFileFingerprintDelta (issue #35 W1b)", () => {
  it("reports an in-place append as size+mtime (another writer added bytes)", () => {
    const after = { ...base, size: 912n, mtimeNs: 2000n };
    expect(describeSessionFileFingerprintDelta(base, after)).toBe("size(500->912),mtime");
  });

  it("reports an atomic temp+rename replacement as an ino change", () => {
    const after = { ...base, ino: 101n, size: 480n, mtimeNs: 2000n, ctimeNs: 2000n };
    expect(describeSessionFileFingerprintDelta(base, after)).toContain("ino(100->101)");
  });

  it("reports a metadata-only touch as ctime alone (open-for-write, no bytes)", () => {
    const after = { ...base, ctimeNs: 2000n };
    expect(describeSessionFileFingerprintDelta(base, after)).toBe("ctime");
  });

  it("reports file removal and (re)creation", () => {
    expect(describeSessionFileFingerprintDelta(base, { exists: false })).toBe("file-removed");
    expect(describeSessionFileFingerprintDelta({ exists: false }, base)).toBe("file-created");
  });

  it("returns none when nothing changed and no-baseline when unarmed", () => {
    expect(describeSessionFileFingerprintDelta(base, { ...base })).toBe("none");
    expect(describeSessionFileFingerprintDelta(undefined, base)).toBe("no-baseline");
  });
});
