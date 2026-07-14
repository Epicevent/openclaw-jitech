import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state.ts";

export type VersionEntry = {
  version: string;
  date: string | null;
  pr?: number | null;
  title?: string | null;
  body?: string | null;
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

function renderRow(state: AppViewState, v: VersionEntry, index: number, owner: boolean) {
  const canExpand = owner && Boolean(v.body);
  const expanded = canExpand && state.versionsExpanded === index;
  return html`
    <div class="version-row ${expanded ? "version-row--open" : ""}">
      <button
        type="button"
        class="version-row__head"
        ?disabled=${!canExpand}
        aria-expanded=${expanded ? "true" : "false"}
        @click=${() => (canExpand ? state.toggleVersionExpanded(index) : undefined)}
      >
        <span class="version-row__date">${formatDate(v.date)}</span>
        <span class="version-row__name">${v.version}</span>
        ${owner
          ? html`<span class="version-row__title">${v.title ?? ""}</span>
              ${canExpand
                ? html`<span class="version-row__chev" aria-hidden="true">${expanded ? "▾" : "▸"}</span>`
                : nothing}`
          : nothing}
      </button>
      ${expanded ? html`<pre class="version-row__body">${v.body}</pre>` : nothing}
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
        <div class="version-history__cols" aria-hidden="true">
          <span>버전</span><span>빌드</span>${owner ? html`<span>변경</span>` : nothing}
        </div>
        ${versions.length === 0
          ? html`<div class="version-history__empty">기록 없음</div>`
          : versions.map((v, i) => renderRow(state, v, i, owner))}
      </div>
    </openclaw-modal-dialog>
  `;
}
