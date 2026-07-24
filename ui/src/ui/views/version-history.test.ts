import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../app-view-state.ts";
import { renderVersionHistoryModal, type VersionsData } from "./version-history.ts";

function renderHistory(mode: VersionsData["mode"]) {
  const container = document.createElement("div");
  const state = {
    versionsOpen: true,
    versionsData: {
      mode,
      versions: [
        {
          version: "customer-v1",
          date: "2026-07-24T01:02:03.000Z",
          note: "이미지 전달 오탐을 제거했습니다.",
          pr: 70,
          prUrl: "https://github.com/Epicevent/openclaw-jitech/pull/70",
        },
      ],
    },
    closeVersions: vi.fn(),
  } as unknown as AppViewState;
  render(renderVersionHistoryModal(state), container);
  return container;
}

describe("version history", () => {
  it.each(["customer", "owner"] as const)(
    "renders the user patch note read-only in %s build data",
    (mode) => {
      const container = renderHistory(mode);

      expect(container.querySelector("textarea")).toBeNull();
      expect(container.querySelector(".version-row__note")?.textContent).toBe(
        "이미지 전달 오탐을 제거했습니다.",
      );
    },
  );

  it("keeps private source links out of the customer projection", () => {
    expect(renderHistory("customer").querySelector(".version-row__pr")).toBeNull();
    expect(renderHistory("owner").querySelector(".version-row__pr")?.textContent?.trim()).toBe(
      "PR #70 ↗",
    );
  });
});
