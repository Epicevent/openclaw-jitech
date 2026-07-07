import { describe, expect, it } from "vitest";
import { versionFooterText } from "./control-ui-release.ts";

describe("versionFooterText", () => {
  it("shows the dev label for a non-release (source/dev) build regardless of server version", () => {
    expect(versionFooterText("2026.5.19", false, "개발")).toBe("개발");
    expect(versionFooterText("", false, "개발")).toBe("개발");
  });

  it("shows the server version for a release build", () => {
    expect(versionFooterText("2026.7.7", true, "개발")).toBe("v2026.7.7");
  });

  it("shows nothing for a release build before the server version is known", () => {
    expect(versionFooterText("", true, "개발")).toBeNull();
  });
});
