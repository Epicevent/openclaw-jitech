import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import type { AppViewState } from "./app-view-state.ts";
import {
  deleteSessionFolder,
  moveSessionToFolder,
  renameSessionFolder,
} from "./controllers/sessions.ts";
import { icons } from "./icons.ts";
import type { GatewaySessionRow } from "./types.ts";

export type SessionFolderNode = {
  path: string;
  name: string;
  children: SessionFolderNode[];
  sessions: GatewaySessionRow[];
};

const SESSION_DRAG_MIME = "text/x-openclaw-session-key";

function folderCollapsed(state: AppViewState, path: string): boolean {
  return state.settings.sessionFolderCollapsed?.[path] ?? false;
}

function toggleFolderCollapsed(state: AppViewState, path: string) {
  const next = { ...state.settings.sessionFolderCollapsed };
  next[path] = !folderCollapsed(state, path);
  state.applySettings({ ...state.settings, sessionFolderCollapsed: next });
}

function pendingFolders(state: AppViewState): string[] {
  return state.settings.sessionPendingFolders ?? [];
}

function setPendingFolders(state: AppViewState, folders: string[]) {
  state.applySettings({ ...state.settings, sessionPendingFolders: folders });
}

/** Drop a pending folder once real sessions exist under it (or it was removed). */
function prunePendingFolders(state: AppViewState, rows: GatewaySessionRow[]) {
  const pending = pendingFolders(state);
  if (pending.length === 0) {
    return;
  }
  const kept = pending.filter(
    (path) =>
      !rows.some((row) => row.folderPath === path || row.folderPath?.startsWith(`${path}/`)),
  );
  if (kept.length !== pending.length) {
    setPendingFolders(state, kept);
  }
}

/** Build the nested folder tree from per-session folderPath values. */
export function buildSessionFolderTree(
  rows: GatewaySessionRow[],
  pending: string[],
): SessionFolderNode {
  const root: SessionFolderNode = { path: "", name: "", children: [], sessions: [] };
  const nodeFor = (path: string): SessionFolderNode => {
    let node = root;
    let current = "";
    for (const segment of path.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      let child = node.children.find((candidate) => candidate.path === current);
      if (!child) {
        child = { path: current, name: segment, children: [], sessions: [] };
        node.children.push(child);
      }
      node = child;
    }
    return node;
  };

  for (const path of pending) {
    nodeFor(path);
  }
  for (const row of rows) {
    if (row.folderPath) {
      nodeFor(row.folderPath).sessions.push(row);
    } else {
      root.sessions.push(row);
    }
  }

  const sortNode = (node: SessionFolderNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    node.sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    node.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

function handleSessionDragStart(event: DragEvent, row: GatewaySessionRow) {
  event.dataTransfer?.setData(SESSION_DRAG_MIME, row.key);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
  }
}

function draggedSessionKey(event: DragEvent): string | null {
  return event.dataTransfer?.getData(SESSION_DRAG_MIME) || null;
}

function handleFolderDrop(state: AppViewState, event: DragEvent, folderPath: string | null) {
  event.preventDefault();
  event.stopPropagation();
  (event.currentTarget as HTMLElement | null)?.classList.remove("session-tree__drop--over");
  const key = draggedSessionKey(event);
  if (!key) {
    return;
  }
  void moveSessionToFolder(state, key, folderPath);
}

function dropHandlers(state: AppViewState, folderPath: string | null) {
  return {
    dragover: (event: DragEvent) => {
      if (event.dataTransfer?.types.includes(SESSION_DRAG_MIME)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "move";
        }
        (event.currentTarget as HTMLElement | null)?.classList.add("session-tree__drop--over");
      }
    },
    dragleave: (event: DragEvent) => {
      (event.currentTarget as HTMLElement | null)?.classList.remove("session-tree__drop--over");
    },
    drop: (event: DragEvent) => handleFolderDrop(state, event, folderPath),
  };
}

function renderFolderNameEditor(params: {
  state: AppViewState;
  initial: string;
  placeholder: string;
  commit: (value: string) => void;
  cancel: () => void;
}): TemplateResult {
  const { state, initial, placeholder, commit, cancel } = params;
  const submit = (inputEl: HTMLInputElement) => {
    const value = inputEl.value.trim();
    if (!value || value === initial) {
      cancel();
      return;
    }
    commit(value);
  };
  return html`
    <form class="session-tree__folder-form" @submit=${(event: Event) => event.preventDefault()}>
      <input
        class="session-tree__folder-input"
        .value=${initial}
        placeholder=${placeholder}
        ?disabled=${state.sidebarRenameBusy}
        autofocus
        @click=${(event: MouseEvent) => event.stopPropagation()}
        @keydown=${(event: KeyboardEvent) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            submit(event.target as HTMLInputElement);
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
        @blur=${(event: FocusEvent) => submit(event.target as HTMLInputElement)}
      />
    </form>
  `;
}

function renderFolderNode(
  state: AppViewState,
  node: SessionFolderNode,
  renderRow: (state: AppViewState, row: GatewaySessionRow) => unknown,
): TemplateResult {
  const collapsed = folderCollapsed(state, node.path);
  const handlers = dropHandlers(state, node.path);
  const actionsDisabled = !state.connected || !state.client || state.sidebarRenameBusy;
  const parentPath = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";

  const header =
    state.sidebarFolderEditPath === node.path
      ? renderFolderNameEditor({
          state,
          initial: node.name,
          placeholder: t("chat.sidebar.folders.renamePlaceholder"),
          commit: (value) => {
            state.sidebarFolderEditPath = null;
            const toPath = parentPath ? `${parentPath}/${value}` : value;
            const pending = pendingFolders(state);
            if (pending.includes(node.path)) {
              setPendingFolders(
                state,
                pending.map((path) => (path === node.path ? toPath : path)),
              );
            }
            void renameSessionFolder(state, node.path, toPath);
          },
          cancel: () => {
            state.sidebarFolderEditPath = null;
          },
        })
      : html`
          <button
            type="button"
            class="session-tree__folder-toggle"
            aria-expanded=${!collapsed}
            @click=${() => toggleFolderCollapsed(state, node.path)}
          >
            <span class="session-tree__chevron ${collapsed ? "session-tree__chevron--closed" : ""}"
              >${icons.chevronDown}</span
            >
            <span class="session-tree__folder-name">${node.name}</span>
            <span class="session-tree__folder-count">${countSessions(node)}</span>
          </button>
          <span class="session-tree__folder-actions">
            <button
              type="button"
              class="session-tree__folder-action"
              title=${t("chat.sidebar.folders.newSubfolder")}
              aria-label=${t("chat.sidebar.folders.newSubfolder")}
              ?disabled=${actionsDisabled}
              @click=${() => {
                state.sidebarFolderCreateParent = node.path;
              }}
            >
              ${icons.plus}
            </button>
            <button
              type="button"
              class="session-tree__folder-action"
              title=${t("chat.sidebar.folders.rename")}
              aria-label=${t("chat.sidebar.folders.rename")}
              ?disabled=${actionsDisabled}
              @click=${() => {
                state.sidebarFolderEditPath = node.path;
              }}
            >
              ${icons.edit}
            </button>
            <button
              type="button"
              class="session-tree__folder-action"
              title=${t("chat.sidebar.folders.delete")}
              aria-label=${t("chat.sidebar.folders.delete")}
              ?disabled=${actionsDisabled}
              @click=${() => {
                if (!window.confirm(t("chat.sidebar.folders.deleteConfirm"))) {
                  return;
                }
                const pending = pendingFolders(state).filter(
                  (path) => path !== node.path && !path.startsWith(`${node.path}/`),
                );
                setPendingFolders(state, pending);
                void deleteSessionFolder(state, node.path);
              }}
            >
              ${icons.x}
            </button>
          </span>
        `;

  return html`
    <div class="session-tree__folder">
      <div
        class="session-tree__folder-header session-tree__drop"
        @dragover=${handlers.dragover}
        @dragleave=${handlers.dragleave}
        @drop=${handlers.drop}
      >
        ${header}
      </div>
      ${collapsed
        ? nothing
        : html`
            <div class="session-tree__folder-body">
              ${state.sidebarFolderCreateParent === node.path
                ? renderCreateFolderEditor(state, node.path)
                : nothing}
              ${node.children.map((child) => renderFolderNode(state, child, renderRow))}
              ${node.sessions.map(
                (row) => html`
                  <div
                    class="session-tree__item"
                    draggable="true"
                    @dragstart=${(event: DragEvent) => handleSessionDragStart(event, row)}
                  >
                    ${renderRow(state, row)}
                  </div>
                `,
              )}
            </div>
          `}
    </div>
  `;
}

function countSessions(node: SessionFolderNode): number {
  return (
    node.sessions.length + node.children.reduce((total, child) => total + countSessions(child), 0)
  );
}

function renderCreateFolderEditor(state: AppViewState, parentPath: string): TemplateResult {
  return renderFolderNameEditor({
    state,
    initial: "",
    placeholder: t("chat.sidebar.folders.newPlaceholder"),
    commit: (value) => {
      state.sidebarFolderCreateParent = null;
      const path = parentPath ? `${parentPath}/${value}` : value;
      const pending = pendingFolders(state);
      if (!pending.includes(path)) {
        setPendingFolders(state, [...pending, path]);
      }
    },
    cancel: () => {
      state.sidebarFolderCreateParent = null;
    },
  });
}

/**
 * The sidebar session tree: every non-archived direct session grouped by its
 * server-persisted folderPath, with drag-and-drop assignment. Root drops clear
 * the folder. Folder collapse state and not-yet-used folders live in UI settings.
 */
export function renderSessionFolderTree(
  state: AppViewState,
  rows: GatewaySessionRow[],
  renderRow: (state: AppViewState, row: GatewaySessionRow) => unknown,
): TemplateResult {
  prunePendingFolders(state, rows);
  const tree = buildSessionFolderTree(rows, pendingFolders(state));
  const rootHandlers = dropHandlers(state, null);
  const actionsDisabled = !state.connected || !state.client || state.sidebarRenameBusy;
  // Cap applies to ROOT-LEVEL sessions only: folders are the user's own
  // organization, so their contents always render in full. 0 = unlimited
  // (upstream's original sidebar showed the 5 most recent; the cap restores
  // that default while the tree keeps every foldered session reachable).
  const rootLimit = state.settings.sidebarSessionLimit ?? 5;
  const rootExpanded = state.sidebarRootSessionsExpanded;
  const visibleRootSessions =
    rootLimit > 0 && !rootExpanded ? tree.sessions.slice(0, rootLimit) : tree.sessions;
  const hiddenRootCount = tree.sessions.length - visibleRootSessions.length;
  const showCollapseControl = rootLimit > 0 && rootExpanded && tree.sessions.length > rootLimit;

  return html`
    <div class="session-tree" aria-label=${t("chat.sidebar.folders.treeLabel")}>
      <div
        class="session-tree__root-header session-tree__drop"
        @dragover=${rootHandlers.dragover}
        @dragleave=${rootHandlers.dragleave}
        @drop=${rootHandlers.drop}
      >
        <span class="session-tree__root-label">${t("chat.sidebar.folders.treeLabel")}</span>
        <button
          type="button"
          class="session-tree__folder-action"
          title=${t("chat.sidebar.folders.new")}
          aria-label=${t("chat.sidebar.folders.new")}
          ?disabled=${actionsDisabled}
          @click=${() => {
            state.sidebarFolderCreateParent = "";
          }}
        >
          ${icons.plus}
        </button>
      </div>
      ${state.sidebarFolderCreateParent === "" ? renderCreateFolderEditor(state, "") : nothing}
      ${tree.children.map((child) => renderFolderNode(state, child, renderRow))}
      ${visibleRootSessions.map(
        (row) => html`
          <div
            class="session-tree__item"
            draggable="true"
            @dragstart=${(event: DragEvent) => handleSessionDragStart(event, row)}
          >
            ${renderRow(state, row)}
          </div>
        `,
      )}
      ${hiddenRootCount > 0
        ? html`
            <button
              type="button"
              class="session-tree__show-more"
              @click=${() => {
                state.sidebarRootSessionsExpanded = true;
              }}
            >
              ${t("chat.sidebar.folders.showMore", { count: String(hiddenRootCount) })}
            </button>
          `
        : nothing}
      ${showCollapseControl
        ? html`
            <button
              type="button"
              class="session-tree__show-more"
              @click=${() => {
                state.sidebarRootSessionsExpanded = false;
              }}
            >
              ${t("chat.sidebar.folders.showLess")}
            </button>
          `
        : nothing}
    </div>
  `;
}
