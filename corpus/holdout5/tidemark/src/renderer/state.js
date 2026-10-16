// Pure functions over a release draft. No DOM, no storage, no IPC.

export const SECTIONS = ["Added", "Changed", "Fixed", "Removed", "Security"];

let counter = 0;
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export function createDraft() {
  return { id: newId("rel"), version: "", title: "", entries: [] };
}

export function addEntry(release, section, text) {
  const entry = { id: newId("entry"), section: SECTIONS.includes(section) ? section : "Changed", text };
  return { ...release, entries: [...release.entries, entry] };
}

export function removeEntry(release, entryId) {
  return { ...release, entries: release.entries.filter((entry) => entry.id !== entryId) };
}

export function groupBySection(entries) {
  const groups = {};
  for (const entry of entries) (groups[entry.section] ??= []).push(entry);
  return groups;
}
