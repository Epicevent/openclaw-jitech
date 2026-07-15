import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { icons } from "../icons.ts";
import "../components/modal-dialog.ts";

export type VersionEntry = {
  version: string;
  date: string | null;
  /** Owner-written one-line key point (the "변경" cell); absent for older builds. */
  note?: string | null;
  pr?: number | null;
  shortCommit?: string;
  commitUrl?: string;
  prUrl?: string;
};

export type VersionsData = { mode: "owner" | "customer"; versions: VersionEntry[] };

function formatDate(iso: string | null): string {
  if (!iso) {
    return "";
  }
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}` : iso.slice(0, 10);
}

function renderRow(v: VersionEntry, owner: boolean) {
  return html`
    <div class="version-row">
      <span class="version-row__date">${formatDate(v.date)}</span>
      <span class="version-row__name">${v.version}</span>
      ${owner
        ? html`<span class="version-row__note">${v.note ?? ""}</span>
            ${v.prUrl
              ? html`<a
                  class="version-row__pr"
                  href=${v.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  >PR #${v.pr} ↗</a
                >`
              : nothing}`
        : nothing}
    </div>
  `;
}

export function renderVersionHistoryModal(state: AppViewState): TemplateResult | typeof nothing {
  if (!state.versionsOpen) {
    return nothing;
  }
  const data = state.versionsData;
  const versions = data?.versions ?? [];
  const owner = data?.mode === "owner";
  return html`
    <openclaw-modal-dialog label="버전 기록" @modal-cancel=${() => state.closeVersions()}>
      <div class="version-history">
        <div class="version-history__header">
          <span class="version-history__title">버전 기록</span>
          <button
            type="button"
            class="version-history__close"
            aria-label="닫기"
            @click=${() => state.closeVersions()}
          >
            ${icons.x}
          </button>
        </div>
        <div class="version-history__cols" aria-hidden="true">
          <span>버전</span><span>빌드</span>${owner ? html`<span>변경</span>` : nothing}
        </div>
        ${versions.length === 0
          ? html`<div class="version-history__empty">기록 없음</div>`
          : versions.map((v) => renderRow(v, owner))}
      </div>
    </openclaw-modal-dialog>
  `;
}
