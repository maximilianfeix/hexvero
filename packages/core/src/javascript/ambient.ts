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
import { PayloadReader } from "./payload.js";
import type { IpcUsage, Token } from "./scan.js";

export type IpcTarget = "ipcMain" | "ipcRenderer";

export interface AmbientDefinition {
  name: string;
  /** `other`: the name is assigned something that is not an IPC object. */
  target: IpcTarget | "other";
  /** `global`: assigned on a global object. `top-level`: used at the top of a file. */
  kind: "global" | "top-level";
  /** For a global: `page` when assigned on window/self, `all` on global/globalThis. */
  reach?: "page" | "all";
  line: number;
}

export interface AmbientCall {
  name: string;
  method: string;
  channel: string;
  line: number;
  /**
   * The file binds the name more than once and also uses it at its top as an IPC object: which
   * binding this call means was not read. It is reported, never resolved.
   */
  local?: true;
}

export interface AmbientFacts {
  defines?: AmbientDefinition[];
  calls?: AmbientCall[];
  /**
   * `<x>.sender.send("channel")` and `<x>.webContents.postMessage("channel")`. Their shape alone
   * does not make them Electron IPC (`mailer.sender.send(…)`), so they wait here and become rows
   * only if the file turns out to use Electron's IPC.
   */
  replies?: IpcUsage[];
}

export interface UnresolvedCall extends AmbientCall {
  file: string;
  /**
   * Why it was not resolved: no definition was read, the definitions name different objects (or
   * the file itself binds the name twice), or the definition found names an object that has no
   * such method (`ipcMain.send`), which means it is probably not the one the file uses.
   */
  reason: "undefined" | "ambiguous" | "mismatch";
}

const METHODS: Record<IpcTarget, ReadonlySet<string>> = {
  ipcMain: new Set(["on", "once", "handle", "handleOnce"]),
  ipcRenderer: new Set(["on", "once", "send", "invoke", "sendSync", "sendToHost", "postMessage"]),
};
const ANY_METHOD = new Set([...METHODS.ipcMain, ...METHODS.ipcRenderer]);
const PAGE_OBJECTS = new Set(["window", "self"]);
const GLOBAL_OBJECTS = new Set(["window", "self", "globalThis", "global"]);
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
/** Per file: open calls, rows and definitions kept. Beyond them the file is marked as cut. */
const MAX_PER_FILE = 500;
/** Unresolved calls kept with their location; the total is counted beyond that. */
const MAX_UNRESOLVED = 1000;

const literal = (t: Token | undefined): string | null =>
  t && (t.type === "string" || (t.type === "template" && !t.value.includes("${"))) ? t.value : null;

/**
 * What one file defines for others, the IPC-shaped calls it makes on names it does not bind, and
 * the IPC rows only this reader sees. `aliases` is the file's own alias resolution.
 */
export function collectAmbient(
  tokens: Token[],
  aliases: Map<number, string>,
): { facts: AmbientFacts; ipc: IpcUsage[]; truncated: boolean } {
  const is = (i: number, value: string): boolean =>
    tokens[i]?.type === "punct" && tokens[i]!.value === value;
  /**
   * The IPC object a token names: another name the file resolved, or the member of the electron
   * module itself (`electron.ipcRenderer`, `require("electron").ipcRenderer`). A property of
   * any other object (`mocks.ipcRenderer`) is not it.
   */
  const targetAt = (i: number): IpcTarget | null => {
    const t = tokens[i];
    if (t?.type !== "ident") return null;
    const resolved = aliases.get(i);
    if (resolved === "ipcMain" || resolved === "ipcRenderer") return resolved;
    if (!is(i - 1, ".") || (t.value !== "ipcMain" && t.value !== "ipcRenderer")) return null;
    const owner = tokens[i - 2];
    const fromModule =
      (owner?.type === "ident" && owner.value === "electron") ||
      (is(i - 2, ")") &&
        /^electron(\/|$)/.test(literal(tokens[i - 3]) ?? "") &&
        is(i - 4, "(") &&
        tokens[i - 5]?.type === "ident" &&
        tokens[i - 5]!.value === "require");
    return fromModule ? t.value : null;
  };

  // A name the file binds or hands around is not left open: any occurrence that is not a
  // property access (`name.x`) counts as that. This also covers parameters and destructuring,
  // and it over-counts plain uses (`f(name)`), which is why a count above one is reported
  // rather than resolved.
  // Counted only for names that are called as `name.method("literal"`, the only ones the count
  // is read for; counting every identifier of a large bundle costs more than the rest of this.
  const called = new Set<string>();
  for (let i = 0; i + 4 < tokens.length; i++) {
    const t = tokens[i]!;
    if (
      t.type === "ident" &&
      is(i + 1, ".") &&
      tokens[i + 2]!.type === "ident" &&
      ANY_METHOD.has(tokens[i + 2]!.value) &&
      is(i + 3, "(") &&
      literal(tokens[i + 4]) !== null
    )
      called.add(t.value);
  }
  const bound = new Map<string, number>();
  if (called.size)
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.type === "ident" && called.has(t.value) && !is(i - 1, ".") && !is(i + 1, "."))
        bound.set(t.value, (bound.get(t.value) ?? 0) + 1);
    }

  const defines = new Map<string, AmbientDefinition>();
  const calls: AmbientCall[] = [];
  /** Calls on a name the file binds itself, not resolved by the file's own alias resolution. */
  const own: Array<AmbientCall & { bindings: number }> = [];
  const ipc: IpcUsage[] = [];
  const replies: IpcUsage[] = [];
  let payload: PayloadReader | undefined;
  let truncated = false;
  const room = <T>(list: T[]): boolean => {
    if (list.length < MAX_PER_FILE) return true;
    truncated = true;
    return false;
  };
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

    // `window.name = …`: every such assignment is recorded, an IPC object as that and anything
    // else as `other`, so a name that means two things is known to be ambiguous.
    if (
      !property &&
      GLOBAL_OBJECTS.has(t.value) &&
      is(i + 1, ".") &&
      tokens[i + 2]?.type === "ident" &&
      is(i + 3, "=") &&
      !is(i + 4, "=") &&
      !is(i + 4, "=>")
    ) {
      const name = tokens[i + 2]!.value;
      // The assigned expression must BE the object (`ipcRenderer`, `electron.ipcRenderer`,
      // `require("electron").ipcRenderer`), not merely mention it (`wrap(ipcRenderer)`): its last
      // token, before the `;`, the `,` or the next statement's line, has to name the object.
      let last = i + 4;
      let nested = 0;
      for (let j = i + 4; j < tokens.length && j < i + 14; j++) {
        const p = tokens[j]!;
        if (p.type === "punct") {
          if (p.value === "(" || p.value === "[" || p.value === "{") nested++;
          else if (p.value === ")" || p.value === "]" || p.value === "}") {
            if (nested === 0) break;
            nested--;
          } else if (nested === 0 && (p.value === ";" || p.value === ",")) break;
        }
        if (nested === 0 && p.line !== tokens[j - 1]!.line && !is(j, ".")) break;
        last = j;
      }
      const target = targetAt(last) ?? "other";
      const reach = PAGE_OBJECTS.has(t.value) ? "page" : "all";
      const known = defines.get(name);
      if (!known) {
        if (defines.size < MAX_PER_FILE)
          defines.set(name, { name, target, kind: "global", reach, line: tokens[i + 2]!.line });
        else truncated = true;
      } else if (known.target !== target) known.target = "other";
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
      if (channel !== null && room(ipc))
        ipc.push({ api: `ipcMain.${t.value}`, channel, line: t.line, via: "webContents" });
    }
    // Replies and port transfers from the main process that the per-file scanner only sees inside
    // a listener registered on a written-out `ipcMain`: `<event>.sender.send("channel")` and
    // `<x>.webContents.postMessage("channel")`. They are kept apart: see `AmbientFacts.replies`.
    if (property && is(i + 1, "(") && tokens[i - 2]?.type === "ident") {
      const owner = tokens[i - 2]!.value;
      const api =
        t.value === "send" && owner === "sender" && is(i - 3, ".")
          ? "event.sender.send"
          : t.value === "postMessage" && owner === "webContents"
            ? "webContents.postMessage"
            : null;
      const channel = api ? literal(tokens[i + 2]) : null;
      if (api && channel !== null && room(replies))
        replies.push({
          api,
          channel,
          line: t.line,
          args: (payload ??= new PayloadReader(tokens)).shapeAt(i + 1),
        });
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

    // `name.on("channel", …)` on a name the file's own alias resolution did not resolve. A
    // top-level name of the file that is not an IPC object maps to itself: still not resolved.
    if (
      (resolved === undefined || resolved === t.value) &&
      is(i + 1, ".") &&
      tokens[i + 2]?.type === "ident" &&
      ANY_METHOD.has(tokens[i + 2]!.value) &&
      is(i + 3, "(") &&
      !NOT_A_BINDING.has(t.value) &&
      t.value !== "ipcMain" &&
      t.value !== "ipcRenderer"
    ) {
      const channel = literal(tokens[i + 4]);
      if (channel === null) continue;
      const call = { name: t.value, method: tokens[i + 2]!.value, channel, line: t.line };
      const bindings = bound.get(t.value) ?? 0;
      if (bindings === 0) {
        if (room(calls)) calls.push(call);
      } else if (room(own)) own.push({ ...call, bindings });
    }
  }
  for (const { bindings, ...call } of own) {
    // Only a name the file uses at its top as an IPC object is of interest here; any other
    // name the file binds is an ordinary local.
    const definition = defines.get(call.name);
    if (definition?.kind !== "top-level" || definition.target === "other") continue;
    if (bindings > 1) {
      // Bound more than once (a parameter of the same name, or a plain use that the count cannot
      // tell from a binding): which one the call means was not read. Reported, not resolved.
      if (room(calls)) calls.push({ ...call, local: true });
      continue;
    }
    // Bound exactly once: a function body written above the top-level binding it uses.
    if (METHODS[definition.target].has(call.method) && room(ipc))
      ipc.push({
        api: `${definition.target}.${call.method}`,
        channel: call.channel,
        line: call.line,
        via: "alias",
      });
  }
  // A global this file assigns itself and then uses by its bare name, further down.
  const open = calls.filter((call) => {
    const definition = defines.get(call.name);
    if (
      call.local ||
      definition?.kind !== "global" ||
      definition.target === "other" ||
      call.line <= definition.line ||
      !METHODS[definition.target].has(call.method)
    )
      return true;
    if (room(ipc))
      ipc.push({
        api: `${definition.target}.${call.method}`,
        channel: call.channel,
        line: call.line,
        via: "global",
      });
    return false;
  });
  const facts: AmbientFacts = {};
  if (defines.size) facts.defines = [...defines.values()];
  if (open.length) facts.calls = open;
  if (replies.length) facts.replies = replies;
  return { facts, ipc, truncated };
}

const directoryOf = (file: string): string => file.slice(0, Math.max(0, file.lastIndexOf("/")));

/** How many leading directories two files share. */
function shared(a: string, b: string): number {
  const x = directoryOf(a).split("/").filter(Boolean);
  const y = directoryOf(b).split("/").filter(Boolean);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/**
 * Joins open calls with the definitions of other files and moves what can be decided into the
 * module's IPC list (`via: "global"`).
 *
 * A name bound at the top of a file reaches another file only when there is evidence that the
 * two are built into one script: both sit in the same directory, and no file imports or
 * requires the using file as a module (`imported`). Sharing a parent directory such as `src/`
 * is the norm for unrelated files and is no such evidence.
 *
 * A global assigned on `window` or `self` reaches the scripts of pages, not main-process files;
 * one assigned on `global` or `globalThis` reaches every file. The nearest definition decides.
 * Definitions that disagree, including one that assigns the name something that is not an IPC
 * object, decide nothing.
 *
 * Calls that stay open remain on the module, so a continued scan that reads the defining file
 * later resolves them then.
 */
export function resolveAmbient(
  modules: Array<{ id: string; role?: string; ipc: IpcUsage[]; ambient?: AmbientFacts }>,
  imported: ReadonlySet<string> = new Set(),
): { resolved: number; unresolved: UnresolvedCall[]; unresolvedTotal: number } {
  const definitions = new Map<string, Array<AmbientDefinition & { file: string }>>();
  for (const m of modules)
    for (const d of m.ambient?.defines ?? []) {
      const list = definitions.get(d.name) ?? [];
      list.push({ ...d, file: m.id });
      definitions.set(d.name, list);
    }
  let resolved = 0;
  let unresolvedTotal = 0;
  const unresolved: UnresolvedCall[] = [];
  const report = (call: AmbientCall, file: string, reason: UnresolvedCall["reason"]): void => {
    unresolvedTotal++;
    if (unresolved.length < MAX_UNRESOLVED) unresolved.push({ ...call, file, reason });
  };
  /** What a name means in a file: an IPC object, something else, nothing known, or unclear. */
  type Meaning = IpcTarget | "other" | "undefined" | "ambiguous";
  const meaningOf = (name: string, file: string, role: string | undefined): Meaning => {
    const all = definitions.get(name);
    if (!all) return "undefined";
    // More definitions of one name than any application has: nothing is decided, and the work
    // per call stays bounded.
    if (all.length > 200) return "ambiguous";
    let nearest = -1;
    let targets = new Set<IpcTarget | "other">();
    for (const d of all) {
      if (d.file === file) continue;
      let near: number;
      if (d.kind === "top-level") {
        if (directoryOf(d.file) !== directoryOf(file) || imported.has(file)) continue;
        // the same directory is nearer than any global
        near = Number.MAX_SAFE_INTEGER;
      } else {
        if (d.reach === "page" && role === "main") continue;
        near = shared(file, d.file);
      }
      if (near > nearest) {
        nearest = near;
        targets = new Set([d.target]);
      } else if (near === nearest) targets.add(d.target);
    }
    if (!targets.size) return "undefined";
    return targets.size === 1 ? [...targets][0]! : "ambiguous";
  };
  for (const m of modules) {
    const calls = m.ambient?.calls;
    if (!calls?.length) continue;
    const open: AmbientCall[] = [];
    const meanings = new Map<string, Meaning>();
    for (const call of calls)
      if (!meanings.has(call.name)) meanings.set(call.name, meaningOf(call.name, m.id, m.role));
    // One call the object cannot take (`ipcMain.send`) means the definition found is probably
    // not the one this file uses: then none of the file's calls on that name is resolved.
    const mismatched = new Set<string>();
    for (const call of calls) {
      const meaning = meanings.get(call.name)!;
      if (
        (meaning === "ipcMain" || meaning === "ipcRenderer") &&
        !METHODS[meaning].has(call.method)
      )
        mismatched.add(call.name);
    }
    let added = false;
    for (const call of calls) {
      const meaning = meanings.get(call.name)!;
      if (call.local) {
        open.push(call);
        report(call, m.id, "ambiguous");
      } else if (meaning === "other") {
        // a global of that name that is not an IPC object: not IPC, nothing to report
      } else if (meaning === "undefined") {
        open.push(call);
        // Only a name that says what it is counts as a likely miss; `emitter.on("x")` does not.
        if (/ipc/i.test(call.name)) report(call, m.id, "undefined");
      } else if (meaning === "ambiguous") {
        open.push(call);
        report(call, m.id, "ambiguous");
      } else if (mismatched.has(call.name)) {
        open.push(call);
        report(call, m.id, "mismatch");
      } else {
        m.ipc.push({
          api: `${meaning}.${call.method}`,
          channel: call.channel,
          line: call.line,
          via: "global",
        });
        added = true;
        resolved++;
      }
    }
    if (added) m.ipc.sort((a, b) => a.line - b.line);
    if (m.ambient) {
      if (open.length) m.ambient.calls = open;
      else delete m.ambient.calls;
    }
  }
  return { resolved, unresolved, unresolvedTotal };
}
