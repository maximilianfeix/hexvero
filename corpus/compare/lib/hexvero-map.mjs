/**
 * Reduces what hexvero returns to a caller (the JSON of `collection`, `compare` and `calls`, or the
 * same payloads from the MCP tools) to the corpus's neutral observation format. The reductions are
 * the ones of corpus/observe-hexvero.mjs at the commit under test, applied to the returned pages
 * instead of to the library: nothing is added that the caller did not receive.
 */
const STORAGE_KINDS = ["localStorage", "sessionStorage", "indexedDB", "cache", "cookie", "electron-store"];

export function collectionToNeutral(name, items) {
  if (name === "ipcChannels") return { ipcChannels: items.map((i) => ({ channel: i.channel, senders: i.senders, receivers: i.receivers })) };
  if (name === "webPreferences") return { webPreferences: items.map((w) => ({ key: w.key, value: w.value, file: w.file })) };
  if (name === "contextBridge") return { contextBridge: items.map((b) => ({ api: b.api, member: b.member, channel: b.channel })) };
  if (name === "endpoints")
    return {
      endpoints: items.filter((e) => e.value !== null).map((e) => ({ value: e.value, kind: e.kind, method: e.method ?? null })),
      endpointsUnreadable: items.filter((e) => e.value === null).length,
    };
  if (name === "storage") {
    const storage = new Map();
    for (const row of items) {
      if (row.value === null) continue;
      const key = `${row.kind}\u0000${row.value}`;
      const entry = storage.get(key) ?? { kind: row.kind, value: row.value, ops: [] };
      if (row.op && !entry.ops.includes(row.op)) entry.ops.push(row.op);
      storage.set(key, entry);
    }
    return { storage: [...storage.values()] };
  }
  throw new Error(`no reduction for collection ${name}`);
}

/** One `compare` result. */
export function compareToNeutral(name, diff) {
  const last = (text) => String(text).split("::").at(-1);
  const label = (text) => {
    const parts = String(text).split("::");
    if (name === "contextBridge") return parts.join(".");
    if (name === "storage") {
      const at = parts.findIndex((part) => STORAGE_KINDS.includes(part));
      return at === -1 ? String(text) : `${parts[at]} ${parts[at + 1]}`;
    }
    if (["endpoints", "ipcChannels", "imports", "symbols"].includes(name)) return last(text);
    return String(text);
  };
  const keyOf = (x) => (x && typeof x === "object" ? (x.key ?? x.name ?? JSON.stringify(x)) : x);
  // The command line returns the lists; the MCP tool returns { count, sample } per list. A sample
  // shorter than its count is an answer the caller did not fully receive, and is reported as such.
  const list = (x) => (Array.isArray(x) ? x : (x?.sample ?? []));
  const cut = ["added", "removed", "changed"].filter((k) => !Array.isArray(diff[k]) && (diff[k]?.count ?? 0) > list(diff[k]).length);
  return {
    key: diff.key,
    listsCutToSample: cut,
    added: list(diff.added).map((x) => label(keyOf(x))),
    removed: list(diff.removed).map((x) => label(keyOf(x))),
    changed: list(diff.changed).flatMap((c) =>
      name === "webPreferences"
        ? c.fields.map((f) => `${last(c.key)}: ${f.before} -> ${f.after}`)
        : [label(c.key)],
    ),
    relocated: diff.relocated?.count ?? diff.relocated,
    unchanged: diff.unchanged,
    partial: diff.partial ?? diff.complete === false,
  };
}

/** One `calls … --goal` answer, or its error. */
export function pathToNeutral(question, answer) {
  if (!answer || answer.code || answer.error || !answer.status)
    return { from: question.from, to: question.to, found: false, hedged: false, unresolved: answer?.message ?? "no answer" };
  const bare = (n) => String(n).replace(/^(sym\.imp\.|sym\.|imp\.|dbg\.|fcn\.)/, "").replace(/^_+/, "");
  return {
    from: question.from,
    to: question.to,
    found: answer.status === "found",
    path: answer.path?.map(bare) ?? null,
    hedged: (answer.limitations ?? []).length > 0,
    limitations: (answer.limitations ?? []).map((l) => l.code ?? l),
  };
}
