import { describe, expect, it, vi } from "vitest";
import {
  renameSidebarSession,
  suggestAndApplySessionLabel,
  type SidebarSessionLabelState,
} from "./sessions.ts";

type RequestHandler = (params: Record<string, unknown>) => unknown;

function makeState(handlers: Record<string, RequestHandler>) {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    const handler = handlers[method];
    return handler ? await handler(params) : undefined;
  });
  const state = {
    client: { request },
    connected: true,
    sessionsLoading: false,
    sessionsResult: null,
    sessionsError: null,
    sessionsFilterActive: "",
    sessionsFilterLimit: "",
    sessionsIncludeGlobal: true,
    sessionsIncludeUnknown: true,
    sessionsShowArchived: false,
    sessionsExpandedCheckpointKey: null,
    sessionsCheckpointItemsByKey: {},
    sessionsCheckpointLoadingKey: null,
    sessionsCheckpointBusyKey: null,
    sessionsCheckpointErrorByKey: {},
    sidebarRenameBusy: false,
    sidebarRenameError: null,
    sidebarSuggestKey: null,
  } as unknown as SidebarSessionLabelState;
  return { state, request };
}

describe("suggestAndApplySessionLabel", () => {
  it("applies a non-empty suggestion via sessions.patch", async () => {
    const { state, request } = makeState({
      "sessions.suggestLabel": () => ({ ok: true, key: "main", suggestion: "Cobalt run" }),
      "sessions.patch": () => ({ ok: true }),
      "sessions.list": () => undefined,
    });

    await suggestAndApplySessionLabel(state, "main");

    expect(request).toHaveBeenCalledWith("sessions.suggestLabel", { key: "main" });
    expect(request).toHaveBeenCalledWith("sessions.patch", { key: "main", label: "Cobalt run" });
    expect(state.sidebarSuggestKey).toBeNull();
    expect(state.sidebarRenameError).toBeNull();
  });

  it("does not patch and reports an error when the suggestion is empty", async () => {
    const { state, request } = makeState({
      "sessions.suggestLabel": () => ({ ok: true, key: "main", suggestion: "   " }),
      "sessions.list": () => undefined,
    });

    await suggestAndApplySessionLabel(state, "main");

    expect(request).not.toHaveBeenCalledWith("sessions.patch", expect.anything());
    expect(state.sidebarRenameError).toBe("autoNameFailed");
    expect(state.sidebarSuggestKey).toBeNull();
  });

  it("marks the row busy while the suggestion is in flight", async () => {
    let resolveSuggest: (value: { suggestion: string }) => void = () => undefined;
    const { state } = makeState({
      "sessions.suggestLabel": () =>
        new Promise((resolve) => {
          resolveSuggest = resolve;
        }),
      "sessions.patch": () => ({ ok: true }),
      "sessions.list": () => undefined,
    });

    const pending = suggestAndApplySessionLabel(state, "main");
    expect(state.sidebarSuggestKey).toBe("main");
    resolveSuggest({ suggestion: "Done" });
    await pending;
    expect(state.sidebarSuggestKey).toBeNull();
  });
});

describe("renameSidebarSession", () => {
  it("patches the label and clears busy on success", async () => {
    const { state, request } = makeState({
      "sessions.patch": () => ({ ok: true }),
      "sessions.list": () => undefined,
    });

    const ok = await renameSidebarSession(state, "main", "New name");

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith("sessions.patch", { key: "main", label: "New name" });
    expect(state.sidebarRenameBusy).toBe(false);
    expect(state.sidebarRenameError).toBeNull();
  });

  it("classifies a duplicate-label error", async () => {
    const { state } = makeState({
      "sessions.patch": () => {
        throw new Error("label already in use: New name");
      },
    });

    const ok = await renameSidebarSession(state, "main", "New name");

    expect(ok).toBe(false);
    expect(state.sidebarRenameError).toBe("duplicate");
    expect(state.sidebarRenameBusy).toBe(false);
  });

  it("classifies an unexpected error as generic", async () => {
    const { state } = makeState({
      "sessions.patch": () => {
        throw new Error("network exploded");
      },
    });

    const ok = await renameSidebarSession(state, "main", "New name");

    expect(ok).toBe(false);
    expect(state.sidebarRenameError).toBe("generic");
  });
});
