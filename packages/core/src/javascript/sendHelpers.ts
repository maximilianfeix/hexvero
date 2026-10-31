/**
 * Send helpers of the main process whose IPC object and channel are both parameters (#280):
 *
 *     function send(webContents, channel, ...args) {
 *       if (webContents.isDestroyed()) log.error(`failed to send on ${channel}`);
 *       else webContents.send(channel, ...args);
 *     }
 *     send(this.window.webContents, "menu-event", e);
 *
 * Minified, the object is a bare parameter (`function ut(e,t,...n){… e.send(t,...n)}`), so the
 * call inside is no `webContents.send` by its name. A call of the helper gives a `webContents.send`
 * row only where the argument it passes for the object is a webContents by what is written: a
 * member `….webContents`, a name bound to one (`const w = win.webContents`, `const { webContents:
 * r } = n`), or the result of a parameter called without arguments that the one call of its
 * function (`function (get) {…}(() => win?.webContents)`) binds to an arrow returning one. Any
 * other argument gives no row: an object that is not read is not taken for a webContents.
 *
 * Calls are bound to the helper by scope (`ExpressionResolver.binding`), so a call of another
 * function of the same (minified) name is not one. Nothing is evaluated or run; every search is
 * bounded.
 */
import type { ExpressionResolver, FnDef } from "./resolve.js";
import type { Token } from "./scan.js";
import { writesName } from "./writes.js";

/** `P.send(C, …)` calls on a parameter read per file. */
const MAX_CANDIDATES = 2000;
/** Helpers read per file. */
const MAX_HELPERS = 64;
/** Call sites read per helper; one past it makes the helper capped. */
export const MAX_SEND_HELPER_SITES = 256;
/** Links followed from a name to the webContents it is bound to. */
const MAX_DEPTH = 4;

/** A call of a send helper whose object argument is a webContents. */
export interface SendHelperCall {
  /** The helper's name, as the row's `wrapper`. */
  helper: string;
  /** Token of the helper's name at the call. */
  at: number;
  /** Token where the channel argument starts. */
  arg: number;
  /** Token of the channel argument of the `P.send(C, …)` inside the helper. */
  inner: number;
  /** The scan reads that call itself as an IPC call (`webContents.send` by its name). */
  named: boolean;
}

export interface SendHelperResult {
  calls: SendHelperCall[];
  /**
   * Helpers with at least one such call that have more call sites than are read, with the token of
   * the `P.send(` inside: the calls past the cap are not read.
   */
  capped: Array<{ helper: string; at: number }>;
}

/**
 * The calls of the file's send helpers (see above). `isIpcCall(k)` says whether the scan already
 * reads `X.send(` at k as an IPC call (`webContents.send` by its name or another name for it):
 * the resolver reads such a helper's channel there first, and its calls are marked `named`.
 */
export function sendHelperCalls(
  tokens: readonly Token[],
  resolver: ExpressionResolver,
  isIpcCall: (k: number) => boolean,
): SendHelperResult {
  const out: SendHelperResult = { calls: [], capped: [] };
  const is = (k: number, type: Token["type"], value?: string): boolean => {
    const t = tokens[k];
    return !!t && t.type === type && (value === undefined || t.value === value);
  };
  const punct = (k: number, v: string): boolean => is(k, "punct", v);
  const nameAt = (k: number): string | null => (is(k, "ident") ? tokens[k]!.value : null);

  // `P.send(C,` / `P.send(C)` with P and C parameters of the same function, neither written there
  const helpers = new Map<FnDef, { object: number; channel: number; at: number; named: boolean }>();
  let candidates = 0;
  for (let k = 0; k + 5 < tokens.length; k++) {
    if (
      !is(k, "ident") ||
      !punct(k + 1, ".") ||
      !is(k + 2, "ident", "send") ||
      !punct(k + 3, "(") ||
      !is(k + 4, "ident") ||
      !(punct(k + 5, ",") || punct(k + 5, ")")) ||
      punct(k - 1, ".") ||
      punct(k - 1, "?.")
    )
      continue;
    if (++candidates > MAX_CANDIDATES || helpers.size >= MAX_HELPERS) break;
    const objectName = tokens[k]!.value;
    const channelName = tokens[k + 4]!.value;
    if (objectName === channelName || !resolver.paramAround(k, objectName)) continue;
    const o = resolver.binding(k, objectName);
    const c = resolver.binding(k + 4, channelName);
    if (o?.kind !== "param" || c?.kind !== "param" || o.def !== c.def) continue;
    const def = o.def;
    if (def.name === null || def.owner !== null || def.member) continue;
    if (helpers.has(def)) continue;
    if (written(def, objectName, o.index) || written(def, channelName, c.index)) continue;
    helpers.set(def, { object: o.index, channel: c.index, at: k, named: isIpcCall(k) });
  }

  /** Whether the body of def writes its parameter `name` (at `index`) anywhere it means it. */
  function written(def: FnDef, name: string, index: number): boolean {
    for (const j of resolver.namePositions(name, def.body[0], def.body[1])) {
      if (punct(j - 1, ".") || punct(j - 1, "?.")) continue;
      if (!writesName(tokens, j)) continue;
      const b = resolver.binding(j, name, true);
      if (b === null || (b.kind === "param" && b.def === def && b.index === index)) return true;
    }
    return false;
  }

  for (const [def, { object, channel, at, named }] of helpers) {
    const name = def.name!;
    // a function declared inside another one is visible only there
    const outer = resolver.outerOf(def);
    const [from, to] = outer ? outer.body : [0, tokens.length];
    let sites = 0;
    let found = false;
    let capped = false;
    for (const j of resolver.namePositions(name, from, to)) {
      if (!punct(j + 1, "(") || j + 1 === def.paramsAt) continue;
      if (punct(j - 1, ".") || punct(j - 1, "?.") || is(j - 1, "ident", "function")) continue;
      const b = resolver.binding(j, name);
      const bound =
        (b?.kind === "function" && b.def === def) ||
        (b?.kind === "value" && resolver.functionWithParamsAt(valueParams(b.range[0])) === def);
      if (!bound) continue;
      if (++sites > MAX_SEND_HELPER_SITES) {
        capped = true;
        break;
      }
      const objArg = resolver.argumentAt(j + 1, object);
      const chArg = resolver.argumentAt(j + 1, channel);
      if (objArg === null || chArg === null || punct(objArg, ")") || punct(chArg, ")")) continue;
      if (punct(objArg, "...") || punct(chArg, "...")) continue;
      // an argument spread before them moves them: the positions are not known
      if (spreadBefore(j + 1, Math.max(object, channel))) continue;
      if (!webContentsAt(objArg, resolver.endOf(objArg), 0)) continue;
      found = true;
      out.calls.push({ helper: name, at: j, arg: chArg, inner: at + 4, named });
    }
    if (capped && found) out.capped.push({ helper: name, at });
  }
  return out;

  /** The parameter list of the function value starting at a: `(…) =>`, `function (…)`, `async …`. */
  function valueParams(a: number): number {
    let v = a;
    if (is(v, "ident", "async")) v++;
    if (is(v, "ident", "function")) {
      v++;
      if (is(v, "ident")) v++;
    }
    return v;
  }

  /** Whether one of the first `count + 1` arguments of the call at `open` is a spread. */
  function spreadBefore(open: number, count: number): boolean {
    for (let i = 0; i <= count; i++) {
      const a = resolver.argumentAt(open, i);
      if (a === null) return false;
      if (punct(a, "...")) return true;
    }
    return false;
  }

  /** `a.b?.webContents`, `this.window.webContents`: names joined by `.`/`?.`, the last `webContents`. */
  function memberChain(start: number, end: number): boolean {
    if (end - start < 3 || !is(end - 1, "ident", "webContents")) return false;
    if (!(punct(end - 2, ".") || punct(end - 2, "?."))) return false;
    for (let j = start; j < end - 1; j += 2) {
      if (!is(j, "ident")) return false;
      if (!(punct(j + 1, ".") || punct(j + 1, "?."))) return false;
    }
    return true;
  }

  /** Whether the expression [start, end) is a webContents by what is written (see above). */
  function webContentsAt(start: number, end: number, depth: number): boolean {
    if (depth > MAX_DEPTH || end <= start) return false;
    if (memberChain(start, end)) return true;
    const name = nameAt(start);
    if (name === null || punct(start - 1, ".") || punct(start - 1, "?.")) return false;
    // `NAME`
    if (end === start + 1) {
      const b = resolver.binding(start, name);
      if (b?.kind === "pattern") return b.key === "webContents";
      if (b?.kind === "value") return webContentsAt(b.range[0], trimmed(b.range), depth + 1);
      return false;
    }
    // `NAME()`: a parameter called without arguments, of a function called once where it is written
    if (end === start + 3 && punct(start + 1, "(") && punct(start + 2, ")")) {
      const b = resolver.binding(start, name);
      if (b?.kind !== "param") return false;
      const arg = immediateArgument(b.def, b.index);
      if (arg === null) return false;
      const fn = resolver.functionWithParamsAt(arg);
      // `() => EXPR`
      if (!fn || !fn.arrow || fn.block || fn.params.length) return false;
      return webContentsAt(fn.body[0], fn.body[1], depth + 1);
    }
    return false;
  }

  /** A declaration's value without the `;` or `,` that ends it. */
  function trimmed([a, b]: [number, number]): number {
    let e = b;
    while (e > a && (punct(e - 1, ";") || punct(e - 1, ","))) e--;
    return e;
  }

  /**
   * The argument at `index` of the one call of def made where it is written: `function (…) {…}(…)`
   * as minifiers write it, or `(function (…) {…})(…)`.
   */
  function immediateArgument(def: FnDef, index: number): number | null {
    if (!def.block || def.arrow || def.owner !== null || def.member) return null;
    // a function expression, also one with a name of its own: `function (…)`, `function g(…)`
    const start = is(def.paramsAt - 1, "ident", "function")
      ? def.paramsAt - 1
      : is(def.paramsAt - 1, "ident") && is(def.paramsAt - 2, "ident", "function")
        ? def.paramsAt - 2
        : -1;
    if (start === -1) return null;
    // where an expression stands, not a declaration followed by a group (`function f(){}(x)`)
    const before = tokens[start - 1];
    const expression =
      before !== undefined &&
      ((before.type === "punct" && !/^(;|\{|\}|\))$/.test(before.value)) ||
        (before.type === "ident" && /^(return|void|typeof|await|yield)$/.test(before.value)));
    if (!expression) return null;
    const close = resolver.closeOf(def.body[0]);
    if (close === -1) return null;
    let open = close + 1;
    if (punct(open, ")")) {
      // `(function (…) {…})(…)`: the group must hold the function and nothing else
      const group = resolver.openOf(open);
      if (group === -1 || group !== start - 1) return null;
      open++;
    }
    if (!punct(open, "(")) return null;
    const arg = resolver.argumentAt(open, index);
    return arg === null || punct(arg, ")") || punct(arg, "...") ? null : arg;
  }
}
