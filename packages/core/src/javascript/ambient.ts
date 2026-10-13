/**
 * IPC through names that one file defines and other files use without declaring them.
 *
 * Two ways this happens in real applications:
 * - a renderer script assigns the object to a global (`window.ipc = electron.ipcRenderer`) and
 *   every later script of the page calls `ipc.send(…)`;
 * - a main process is written as several files that a build step concatenates, so a name bound
 *   at the top of one file (`const { ipcMain: ipc } = electron`) is in scope in its siblings.
 *
 * A file is read on its own, so such a call cannot be resolved while reading it. Each file
 * therefore reports what it defines and which calls it leaves open; `resolveAmbient` joins them
 * once the files are known. A call whose name has no definition, or definitions that disagree,
 * is never guessed: it is returned as unresolved with its location.
 *
 * Also here, because it is IPC that no call on a written-out ipcMain shows: handlers registered
 * on one page's own channel object (`webContents.ipc.on`), replies through `event.sender.send`
 * in listeners registered under another name, and `webContents.postMessage`.
 */
import type { IpcUsage, Token } from "./scan.js";

export type IpcTarget = "ipcMain" | "ipcRenderer";

export interface AmbientDefinition {
  name: string;
  target: IpcTarget;
  /** `global`: assigned to window/globalThis/global/self. `top-level`: used at the top of a file. */
  kind: "global" | "top-level";
  line: number;
}

export interface AmbientCall {
  name: string;
  method: string;
  channel: string;
  line: number;
}

export interface AmbientFacts {
  defines?: AmbientDefinition[];
  calls?: AmbientCall[];
}

export interface UnresolvedCall extends AmbientCall {
  file: string;
  /** Why it was not resolved: no definition was read, or the definitions name different objects. */
  reason: "undefined" | "ambiguous";
}

const METHODS: Record<IpcTarget, ReadonlySet<string>> = {
  ipcMain: new Set(["on", "once", "handle", "handleOnce"]),
  ipcRenderer: new Set(["on", "once", "send", "invoke", "sendSync", "sendToHost", "postMessage"]),
};
const ANY_METHOD = new Set([...METHODS.ipcMain, ...METHODS.ipcRenderer]);
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "global", "self"]);
/** Names that are never an application's own binding for an IPC object. */
const NOT_A_BINDING = new Set([
  "this",
  "super",
  "document",
  "process",
  "console",
  "module",
  "exports",
  ...GLOBAL_OBJECTS,
]);
const MAX_CALLS_PER_FILE = 500;

const literal = (t: Token | undefined): string | null =>
  t && (t.type === "string" || (t.type === "template" && !t.value.includes("${"))) ? t.value : null;

/**
 * What one file defines for others, the IPC-shaped calls it makes on names it does not bind, and
 * the handlers it registers on a page's own channel object. `aliases` is the file's own alias
 * resolution.
 */
export function collectAmbient(
  tokens: Token[],
  aliases: Map<number, string>,
): { facts: AmbientFacts; ipc: IpcUsage[]; truncated: boolean } {
  const is = (i: number, value: string): boolean =>
    tokens[i]?.type === "punct" && tokens[i]!.value === value;
  const targetAt = (i: number): IpcTarget | null => {
    const t = tokens[i];
    if (t?.type !== "ident") return null;
    const name = aliases.get(i) ?? (is(i - 1, ".") ? t.value : null);
    return name === "ipcMain" || name === "ipcRenderer" ? name : null;
  };

  // A name the file binds or hands around is not left open: any occurrence that is not a
  // property access (`name.x`) counts as that. This also covers parameters and destructuring.
  const bound = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === "ident" && !is(i - 1, ".") && !is(i + 1, "."))
      bound.set(t.value, (bound.get(t.value) ?? 0) + 1);
  }

  const defines = new Map<string, AmbientDefinition>();
  const calls: AmbientCall[] = [];
  /** Calls on a name the file binds exactly once, read before that binding was seen. */
  const early: Array<AmbientCall & { at: number }> = [];
  const ipc: IpcUsage[] = [];
  let truncated = false;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === "punct") {
      if (t.value === "{" || t.value === "(" || t.value === "[") depth++;
      else if (t.value === "}" || t.value === ")" || t.value === "]")
        depth = Math.max(0, depth - 1);
      continue;
    }
    if (t.type !== "ident") continue;
    const property = is(i - 1, ".");

    // `window.name = <expression naming ipcMain or ipcRenderer>`
    if (
      !property &&
      GLOBAL_OBJECTS.has(t.value) &&
      is(i + 1, ".") &&
      tokens[i + 2]?.type === "ident" &&
      is(i + 3, "=") &&
      !is(i + 4, "=")
    ) {
      const name = tokens[i + 2]!.value;
      for (let j = i + 4; j < tokens.length && j < i + 14 && !is(j, ";") && !is(j, ","); j++) {
        const target = targetAt(j);
        if (!target) continue;
        if (!defines.has(name))
          defines.set(name, { name, target, kind: "global", line: tokens[i + 2]!.line });
        break;
      }
    }

    // `<x>.webContents.ipc.on("channel", …)`: a handler on one page's own channel object.
    if (
      property &&
      is(i + 1, "(") &&
      METHODS.ipcMain.has(t.value) &&
      tokens[i - 2]?.type === "ident" &&
      tokens[i - 2]!.value === "ipc" &&
      is(i - 3, ".") &&
      tokens[i - 4]?.type === "ident" &&
      tokens[i - 4]!.value === "webContents"
    ) {
      const channel = literal(tokens[i + 2]);
      if (channel !== null)
        ipc.push({ api: `ipcMain.${t.value}`, channel, line: t.line, via: "webContents" });
    }
    // Replies and port transfers from the main process that the per-file scanner only sees inside
    // a listener registered on a written-out `ipcMain`: `<event>.sender.send("channel")` and
    // `<x>.webContents.postMessage("channel")`. The caller drops rows the scanner already has.
    if (property && is(i + 1, "(") && tokens[i - 2]?.type === "ident") {
      const owner = tokens[i - 2]!.value;
      const api =
        t.value === "send" && owner === "sender" && is(i - 3, ".")
          ? "event.sender.send"
          : t.value === "postMessage" && owner === "webContents"
            ? "webContents.postMessage"
            : null;
      const channel = api ? literal(tokens[i + 2]) : null;
      if (api && channel !== null) ipc.push({ api, channel, line: t.line });
    }
    if (property) continue;

    const resolved = aliases.get(i);
    // Another name for an IPC object, used at the top of the file: in scope for files that are
    // concatenated with this one.
    if (
      depth === 0 &&
      (resolved === "ipcMain" || resolved === "ipcRenderer") &&
      resolved !== t.value &&
      is(i + 1, ".") &&
      !defines.has(t.value)
    )
      defines.set(t.value, { name: t.value, target: resolved, kind: "top-level", line: t.line });

    // `name.on("channel", …)` on a name this file neither binds nor resolves.
    // A top-level name of the file that is not an IPC object maps to itself: still not resolved.
    if (
      (resolved === undefined || resolved === t.value) &&
      is(i + 1, ".") &&
      tokens[i + 2]?.type === "ident" &&
      ANY_METHOD.has(tokens[i + 2]!.value) &&
      is(i + 3, "(") &&
      !NOT_A_BINDING.has(t.value) &&
      t.value !== "ipcMain" &&
      t.value !== "ipcRenderer" &&
      (bound.get(t.value) ?? 0) <= 1
    ) {
      const channel = literal(tokens[i + 4]);
      if (channel === null) continue;
      if (bound.has(t.value)) {
        // Bound once in this file, but not resolved here: a function body written above the
        // top-level binding it uses. Decided after the loop, when that binding is known.
        early.push({ name: t.value, method: tokens[i + 2]!.value, channel, line: t.line, at: i });
        continue;
      }
      if (calls.length >= MAX_CALLS_PER_FILE) {
        truncated = true;
        continue;
      }
      calls.push({ name: t.value, method: tokens[i + 2]!.value, channel, line: t.line });
    }
  }
  for (const call of early) {
    const definition = defines.get(call.name);
    if (definition?.kind !== "top-level" || !METHODS[definition.target].has(call.method)) continue;
    ipc.push({
      api: `${definition.target}.${call.method}`,
      channel: call.channel,
      line: call.line,
      via: "alias",
    });
  }
  const facts: AmbientFacts = {};
  if (defines.size) facts.defines = [...defines.values()];
  if (calls.length) facts.calls = calls;
  return { facts, ipc, truncated };
}

const directory = (file: string): string[] => file.split("/").slice(0, -1);

/** How many leading directories two files share. */
function shared(a: string, b: string): number {
  const x = directory(a);
  const y = directory(b);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/**
 * Joins open calls with the definitions of other files and moves what can be decided into the
 * module's IPC list (`via: "global"`). The definition in the nearest directory decides; a name
 * bound at the top of a file reaches only files of the same directory tree, because only files
 * that are built together share a scope. Calls that stay open remain on the module, so a
 * continued scan that reads the defining file later resolves them then.
 */
export function resolveAmbient(
  modules: Array<{ id: string; ipc: IpcUsage[]; ambient?: AmbientFacts }>,
): { resolved: number; unresolved: UnresolvedCall[] } {
  const definitions = new Map<string, Array<AmbientDefinition & { file: string }>>();
  for (const m of modules)
    for (const d of m.ambient?.defines ?? []) {
      const list = definitions.get(d.name) ?? [];
      list.push({ ...d, file: m.id });
      definitions.set(d.name, list);
    }
  let resolved = 0;
  const unresolved: UnresolvedCall[] = [];
  for (const m of modules) {
    const calls = m.ambient?.calls;
    if (!calls?.length) continue;
    const open: AmbientCall[] = [];
    let added = false;
    for (const call of calls) {
      const reachable = (definitions.get(call.name) ?? [])
        .filter((d) => d.file !== m.id)
        .map((d) => ({ d, near: shared(m.id, d.file) }))
        .filter(
          ({ d, near }) =>
            d.kind === "global" ||
            near > 0 ||
            (directory(m.id).length === 0 && directory(d.file).length === 0),
        );
      if (!reachable.length) {
        open.push(call);
        // Only a name that says what it is counts as a likely miss; `emitter.on("x")` does not.
        if (/ipc/i.test(call.name)) unresolved.push({ ...call, file: m.id, reason: "undefined" });
        continue;
      }
      const nearest = Math.max(...reachable.map((r) => r.near));
      const targets = new Set(reachable.filter((r) => r.near === nearest).map((r) => r.d.target));
      if (targets.size !== 1) {
        open.push(call);
        unresolved.push({ ...call, file: m.id, reason: "ambiguous" });
        continue;
      }
      const [target] = targets as Set<IpcTarget>;
      // A method the object does not have (`ipcMain.send`) is not a call on it: dropped.
      if (!METHODS[target!].has(call.method)) continue;
      m.ipc.push({
        api: `${target}.${call.method}`,
        channel: call.channel,
        line: call.line,
        via: "global",
      });
      added = true;
      resolved++;
    }
    if (added) m.ipc.sort((a, b) => a.line - b.line);
    if (m.ambient) {
      if (open.length) m.ambient.calls = open;
      else delete m.ambient.calls;
    }
  }
  return { resolved, unresolved };
}
