import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

// Owner-authored patch notes for the version-tracking modal. The build timeline
// (versions.json) is baked into the image and immutable; the notes are a live,
// editable overlay keyed by build version. Stored in the state dir (a mounted
// volume that survives restart and container recreation) so the owner can edit
// notes — new or retroactive — straight from the modal without a rebuild.
function versionNotesPath(): string {
  return path.join(resolveStateDir(), "version-notes.json");
}

export function readVersionNotes(): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(versionNotesPath(), "utf8");
  } catch {
    return {}; // no notes authored yet
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [version, note] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof note === "string") {
      out[version] = note;
    }
  }
  return out;
}

export function setVersionNote(version: string, note: string): void {
  const notes = readVersionNotes();
  const trimmed = note.trim();
  if (trimmed) {
    notes[version] = trimmed;
  } else {
    delete notes[version]; // empty note clears the override (falls back to the baked note)
  }
  const file = versionNotesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(notes, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
