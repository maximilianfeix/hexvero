/**
 * Maps REA 6.4.0 output to the corpus's neutral observation format.
 *
 * Every decision in here is listed in README.md ("Mapping decisions"). The rule: REA gets credit
 * for a fact it reports, in whatever shape it reports it; it gets no credit for a fact it does not
 * report, and a fact it reports under another heading keeps REA's heading.
 */

/** The four window settings the corpus scores (corpus/validation/chat-app/expected.json, "method"). */
export const SCORED_PREFERENCES = new Set(["preload", "contextIsolation", "nodeIntegration", "sandbox"]);
const STORAGE_KIND = {
  "local-storage": "localStorage",
  "session-storage": "sessionStorage",
  "indexed-db": "indexedDB",
  cookie: "cookie",
  cookies: "cookie",
  "electron-store": "electron-store",
};
const HTTP_VERBS = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);
const lastName = (mechanism) => String(mechanism ?? "").replace(/^call:/, "").split(".").at(-1);
const where = (o) => o.evidence?.location?.value?.source ?? null;
const startLine = (o) => o.evidence?.location?.value?.start?.line ?? null;
const observationsOf = (nodes, ...kinds) =>
  nodes.filter((n) => kinds.includes(n.kind)).flatMap((n) => n.observations ?? []);

function storageOp(mechanism) {
  const name = lastName(mechanism);
  if (/^(getItem|get|has|key)$/.test(name)) return "read";
  if (/^(setItem|set|put|add)$/.test(name)) return "write";
  if (/^(removeItem|delete|remove|clear|deleteDatabase)$/.test(name)) return "delete";
  return null;
}
const looksLikeAddress = (value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("/");

/** The window settings of one browser-window observation, the four scored keys with literal values. */
function preferences(o) {
  const p = o.properties;
  const settings = [];
  const unread = [];
  for (const w of p.web_preferences ?? []) {
    if (!SCORED_PREFERENCES.has(w.name)) {
      if (w.value?.status !== "literal") unread.push(`${w.name} (${w.value?.status}: ${w.value?.expression ?? ""})`);
      continue;
    }
    if (w.value?.status === "literal") settings.push({ key: w.name, value: w.value.value, file: p.source_path });
    else unread.push(`${w.name} (${w.value?.status})`);
  }
  return { settings, unread, status: p.web_preferences_status, line: startLine(o) };
}

/**
 * One Electron input.
 * `evidence` is the complete Evidence of analyze-javascript-application, or the part of it that
 * `--filter-output normalized_result.graph.nodes` returns (then `nodesOnly` is the node array).
 * storeCallsAsStorage: the alternative reading of README.md, never the default.
 */
export function electronFromRea(evidence, { nodesOnly = null, storeCallsAsStorage = false } = {}) {
  const result = evidence?.normalized_result ?? null;
  const nodes = nodesOnly ?? result?.graph?.nodes ?? [];
  const notes = [];

  const channels = new Map();
  let unresolvedChannelOperations = 0;
  for (const o of observationsOf(nodes, "ipc-channel", "ipc-handler")) {
    const p = o.properties;
    if (typeof p.channel !== "string" || (p.resolution && p.resolution !== "literal")) {
      unresolvedChannelOperations++;
      continue;
    }
    const entry = channels.get(p.channel) ?? { channel: p.channel, senders: [], receivers: [] };
    const role =
      p.mode === "send" || p.mode === "invoke" ? "senders" : p.mode === "listen" || p.mode === "handle" ? "receivers" : null;
    const file = where(o);
    if (role && file && !entry[role].includes(file)) entry[role].push(file);
    if (!role) notes.push(`ipc mode ${p.mode} not mapped`);
    channels.set(p.channel, entry);
  }

  const webPreferences = [];
  const windowsUnread = [];
  for (const o of observationsOf(nodes, "browser-window")) {
    const w = preferences(o);
    webPreferences.push(...w.settings);
    if (w.status !== "object-literal" || w.unread.length)
      windowsUnread.push({ line: w.line, status: w.status, unread: w.unread });
  }

  const contextBridge = [];
  for (const o of observationsOf(nodes, "context-bridge-api")) {
    const p = o.properties;
    // REA lists the member names of an exposed API; it does not say which channel a member uses.
    for (const member of p.members ?? []) contextBridge.push({ api: p.api_key, member, channel: null });
    for (let i = 0; i < (p.unknown_members ?? 0); i++)
      contextBridge.push({ api: p.api_key ?? null, member: null, channel: null });
    if (p.api_key === null && !(p.unknown_members > 0)) contextBridge.push({ api: null, member: null, channel: null });
  }

  const endpoints = new Map();
  const routes = [];
  const storage = new Map();
  const addStorage = (kind, value, op) => {
    const key = `${kind}\u0000${value}`;
    const entry = storage.get(key) ?? { kind, value, ops: [] };
    if (op && !entry.ops.includes(op)) entry.ops.push(op);
    storage.set(key, entry);
  };
  const endpointLines = new Set();
  for (const o of observationsOf(nodes, "endpoint")) {
    const p = o.properties;
    endpointLines.add(`${where(o)}:${startLine(o)}`);
    if (typeof p.value !== "string") continue;
    if (p.endpoint_kind !== "network") {
      // REA's own heading for these is "route", not a request: they are kept out of the endpoints.
      routes.push({ value: p.value, kind: p.endpoint_kind, mechanism: p.mechanism });
      continue;
    }
    const name = lastName(p.mechanism).toLowerCase();
    if (storeCallsAsStorage && /^(get|set|delete|has)$/.test(name) && !looksLikeAddress(String(p.value))) {
      addStorage("electron-store", p.value, storageOp(p.mechanism));
      continue;
    }
    const method = HTTP_VERBS.has(name) ? name.toUpperCase() : null;
    const key = `${p.value}\u0000${method}`;
    if (!endpoints.has(key)) endpoints.set(key, { value: p.value, method, mechanism: p.mechanism });
  }
  let storageKeysUnread = 0;
  for (const o of observationsOf(nodes, "storage")) {
    const p = o.properties;
    // An access whose key REA could not read has no name: it is no key, and no false one either.
    if (typeof p.name !== "string") {
      storageKeysUnread++;
      continue;
    }
    addStorage(STORAGE_KIND[p.storage_kind] ?? p.storage_kind, p.name, storageOp(p.mechanism));
  }

  // A request REA shows without an address: a `request` node of the semantic graph whose endpoint is
  // null and for which the application graph has no endpoint at the same place.
  let endpointsUnreadable = null;
  const semantic = result?.semantic_graph?.nodes;
  if (semantic) {
    endpointsUnreadable = 0;
    for (const n of semantic) {
      if (n.kind !== "request" || n.properties?.operation_kind !== "request" || n.properties.endpoint !== null) continue;
      const loc = n.evidence?.location?.value;
      if (!endpointLines.has(`${loc?.source}:${loc?.start?.line}`)) endpointsUnreadable++;
    }
  }

  return {
    complete: result ? result.graph?.coverage?.status === "complete" : null,
    coverage: result?.graph?.coverage?.status ?? null,
    limitations: (result?.limitations ?? []).length,
    ipcChannels: [...channels.values()],
    unresolvedChannelOperations,
    webPreferences,
    windowsUnread,
    contextBridge,
    endpoints: [...endpoints.values()],
    routes,
    endpointsUnreadable: endpointsUnreadable ?? 0,
    endpointsUnreadableKnown: endpointsUnreadable !== null,
    storage: [...storage.values()],
    storageKeysUnread,
    notes,
  };
}

/** The facts of one graph node in the names the expectations use, per collection. */
function facts(node) {
  const out = { ipcChannels: [], contextBridge: [], endpoints: [], storage: [], windows: [] };
  for (const o of node.observations ?? []) {
    const p = o.properties ?? {};
    if (node.kind === "ipc-channel" || node.kind === "ipc-handler") {
      if (typeof p.channel === "string") out.ipcChannels.push(p.channel);
    } else if (node.kind === "context-bridge-api") {
      for (const m of p.members ?? []) out.contextBridge.push(`${p.api_key}.${m}`);
    } else if (node.kind === "endpoint") {
      if (p.endpoint_kind === "network" && typeof p.value === "string") out.endpoints.push(p.value);
    } else if (node.kind === "storage") {
      if (typeof p.name === "string") out.storage.push(`${STORAGE_KIND[p.storage_kind] ?? p.storage_kind} ${p.name}`);
    } else if (node.kind === "browser-window") {
      out.windows.push(preferences(o));
    }
  }
  return out;
}

/**
 * A version comparison (compare-application-versions), reduced to added / removed / changed names.
 *
 * REA classifies an item as unchanged, added, removed, changed or unknown. On this corpus it never
 * says added or removed: both graphs have partial coverage, and REA then reports a one-sided item
 * as `unknown`. The mapping is generous on three points (README.md):
 *   - `changed` with the single dimension `location` is a fact that moved, not a change;
 *   - an `unknown` item present on one side only counts as removed (left) or added (right);
 *   - a name that is both removed and added is the same fact under a new identity (REA's identity
 *     of a window or a handler contains its line), and counts as neither.
 * `literal` is REA's own summary, unmapped.
 */
export function compareFromRea(evidence, collections) {
  const n = evidence.normalized_result;
  const nodes = new Map();
  const collect = (o) => {
    if (Array.isArray(o)) o.forEach(collect);
    else if (o && typeof o === "object") {
      if (typeof o.node_id === "string" && o.kind && o.observations) nodes.set(o.node_id, o);
      Object.values(o).forEach(collect);
    }
  };
  collect(n.graph);
  const sets = {};
  for (const name of ["ipcChannels", "contextBridge", "endpoints", "storage"])
    sets[name] = { added: new Set(), removed: new Set(), changed: new Set(), relocated: 0 };
  const windows = { left: [], right: [], changed: [], relocated: 0 };
  for (const item of n.items) {
    const left = item.left_node_id ? nodes.get(item.left_node_id) : null;
    const right = item.right_node_id ? nodes.get(item.right_node_id) : null;
    const l = left ? facts(left) : null;
    const r = right ? facts(right) : null;
    const dims = item.dimensions ?? [];
    const moved = item.status === "changed" && dims.length === 1 && dims[0] === "location";
    const oneSided = (l === null) !== (r === null);
    if (item.status === "unchanged") continue;
    if (moved) {
      for (const name of Object.keys(sets)) if ((l?.[name] ?? []).length) sets[name].relocated++;
      if (l?.windows.length) windows.relocated++;
      continue;
    }
    if (oneSided && (item.status === "unknown" || item.status === "added" || item.status === "removed")) {
      for (const name of Object.keys(sets)) {
        for (const f of l?.[name] ?? []) sets[name].removed.add(f);
        for (const f of r?.[name] ?? []) sets[name].added.add(f);
      }
      windows.left.push(...(l?.windows ?? []));
      windows.right.push(...(r?.windows ?? []));
      continue;
    }
    if (item.status === "changed" && l && r) {
      for (const name of Object.keys(sets)) {
        const a = new Set(l[name]);
        const b = new Set(r[name]);
        let differs = false;
        for (const f of a) if (!b.has(f)) (sets[name].removed.add(f), (differs = true));
        for (const f of b) if (!a.has(f)) (sets[name].added.add(f), (differs = true));
        // The same names on both sides and REA says the properties differ: a changed item.
        if (!differs && a.size && dims.includes("properties") && name !== "contextBridge")
          for (const f of a) sets[name].changed.add(f);
      }
      if (l.windows.length || r.windows.length) windows.changed.push([l.windows, r.windows]);
    }
    // `unknown` with both sides matched: REA states that coverage is unknown, not a difference.
  }
  const result = {};
  for (const [name, s] of Object.entries(sets)) {
    if (!collections.includes(name)) continue;
    const both = [...s.added].filter((f) => s.removed.has(f));
    result[name] = {
      added: [...s.added].filter((f) => !both.includes(f)).toSorted(),
      removed: [...s.removed].filter((f) => !both.includes(f)).toSorted(),
      changed: [...s.changed].toSorted(),
      relocated: s.relocated,
      sameNameOnBothSides: both.length,
    };
  }
  if (collections.includes("webPreferences")) {
    // Windows are paired in source order; a window REA lists as gone on the left and new on the right
    // is one window whose identity moved.
    const added = [];
    const removed = [];
    const changed = [];
    const diff = (a, b) => {
      const before = new Map(a.settings.map((s) => [s.key, s.value]));
      const after = new Map(b.settings.map((s) => [s.key, s.value]));
      for (const [k, v] of before) {
        if (!after.has(k)) removed.push(`${k}=${v}`);
        else if (after.get(k) !== v) changed.push(`${k}: ${v} -> ${after.get(k)}`);
      }
      for (const [k, v] of after) if (!before.has(k)) added.push(`${k}=${v}`);
    };
    const byLine = (a, b) => (a.line ?? 0) - (b.line ?? 0);
    const L = windows.left.toSorted(byLine);
    const R = windows.right.toSorted(byLine);
    for (let i = 0; i < Math.max(L.length, R.length); i++) {
      if (L[i] && R[i]) diff(L[i], R[i]);
      else if (L[i]) removed.push(...L[i].settings.map((s) => `${s.key}=${s.value}`));
      else added.push(...R[i].settings.map((s) => `${s.key}=${s.value}`));
    }
    for (const [l, r] of windows.changed)
      for (let i = 0; i < Math.max(l.length, r.length); i++)
        diff(l[i] ?? { settings: [] }, r[i] ?? { settings: [] });
    result.webPreferences = {
      added,
      removed,
      changed,
      relocated: windows.relocated,
      windowsLeftOnly: L.length,
      windowsRightOnly: R.length,
      windowsUnread: [...L, ...R].filter((w) => w.status !== "object-literal" || w.unread.length).length,
    };
  }
  result.literal = { summary: n.summary, coverage: n.coverage?.status ?? null, matching: n.matching };
  return result;
}

/** inspect-macho: the import names. Nothing else the corpus asks about is in this output. */
export function importsFromRea(evidence) {
  const r = evidence.normalized_result;
  return {
    imports: (r.imports?.items ?? []).map((i) => i.name),
    exports: (r.exports?.items ?? []).map((e) => e.name),
    limitations: [...(r.imports?.limitations ?? []), ...(r.limitations ?? [])],
  };
}

/**
 * A damaged input. `error`: REA refused with a structured error. `flagged`: it returned a result
 * that names what is missing (a parse failure, an integrity contradiction, an unreadable file).
 * The limitations REA attaches to every result, also for an intact input, do not count as a flag.
 */
export function robustFromRea(run) {
  if (run.timedOut) return { outcome: "timeout", message: "no result within the time limit" };
  let parsed = null;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    /* not JSON */
  }
  if (run.exit !== 0) {
    if (parsed && typeof parsed.code === "string")
      return {
        outcome: "error",
        code: parsed.code,
        message: String(parsed.details?.detail ?? parsed.details?.reason ?? parsed.message).slice(0, 300),
      };
    return { outcome: "crash", message: String(run.stderr || run.stdout).slice(0, 400), exit: run.exit, signal: run.signal };
  }
  const r = parsed?.normalized_result;
  const s = r?.statistics ?? {};
  const flags = [];
  if (s.parse_failures) flags.push(`parse_failures ${s.parse_failures}`);
  if (s.invalid_utf8_files) flags.push(`invalid_utf8_files ${s.invalid_utf8_files}`);
  if (r?.integrity_contradictions?.length) flags.push(`integrity_contradictions ${r.integrity_contradictions.length}`);
  for (const key of ["imports", "exports", "segments", "load_commands"])
    if (r?.[key]?.exhaustive === false && (r[key].items ?? []).length === 0) flags.push(`${key} empty and not exhaustive`);
  return flags.length ? { outcome: "flagged", limitations: flags } : { outcome: "clean" };
}
