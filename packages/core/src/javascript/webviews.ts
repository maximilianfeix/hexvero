/**
 * `<webview>` tags and `will-attach-webview` listeners, the `webviews` collection:
 *
 * - `html`: a `<webview>` tag in an HTML file of the app (`webviewHtmlRows`);
 * - `markup`: a `<webview>` tag in a string or template of the code (HTML set through
 *   `innerHTML`, a template literal);
 * - `element`: a webview created in code: `document.createElement("webview")` with the
 *   `setAttribute(…)` calls and attribute properties written on the name it is assigned to, or a
 *   framework's element call with a props object (`createElement("webview", { … })`,
 *   `jsx("webview", { … })`, Vue's `createElementVNode("webview", { … })`);
 * - `attach-listener`: a listener for `will-attach-webview` on a webContents, with whether it
 *   calls `event.preventDefault()`, deletes `webPreferences.preload` and sets
 *   `webPreferences.nodeIntegration = false`, where that is written as a literal.
 *
 * What the attributes do is Electron's (lib/browser/guest-view-manager.ts, makeWebPreferences):
 * the boolean attributes (`nodeintegration`, `nodeintegrationinsubframes`, `allowpopups`,
 * `disablewebsecurity`) are on when present, whatever their value; `webpreferences` is a
 * comma-separated `key=value` list (values `true`/`1`/`yes`/none are true, `false`/`0`/`no` false)
 * that overrides them; nodeIntegration, nodeIntegrationInSubFrames, contextIsolation and sandbox
 * are taken from the hosting window wherever it has the safe value. Nothing is run; a comment is
 * never a tag or a call. See docs/electron-findings.md ("Webviews").
 */
import type { Constants } from "./aliases.js";
import type { ExpressionResolver, FnDef } from "./resolve.js";
import type { Token } from "./scan.js";
import {
  FileReader,
  htmlStartTags,
  keepRows,
  lineCounter,
  MAX_SECURITY_ROWS_PER_FILE,
  short,
} from "./security.js";

export interface WebviewRow {
  kind: "html" | "markup" | "element" | "attach-listener";
  /** The webview's `src` as written; null when it has none or it is not read. */
  src: string | null;
  /**
   * The attributes hexvero reads (`ATTRIBUTES`), lowercased, as written: `""` for one written
   * without a value, null for one that is set but whose value is not read. Empty for
   * `attach-listener`.
   */
  attributes: Record<string, string | null>;
  /**
   * Settings the webview's attributes weaken that take effect as written (`allowpopups`,
   * `disablewebsecurity`, `webpreferences` keys for webSecurity, allowRunningInsecureContent,
   * experimentalFeatures, enableBlinkFeatures, and `blinkfeatures`), each named by where it is
   * written.
   */
  insecure: string[];
  /**
   * Settings the attributes weaken that Electron takes from the hosting window wherever that has
   * the safe value (nodeIntegration, nodeIntegrationInSubFrames, contextIsolation, sandbox): they
   * take effect only in a window that has the same setting itself.
   */
  hostDependent: string[];
  /**
   * Attributes that may be set but are not read: `webpreferences` with a value computed at run
   * time, a framework prop whose value is not a string literal, `*` for a `setAttribute` with a
   * computed name, an object spread in the props or a template substitution inside the tag.
   */
  unread?: string[];
  /** For `attach-listener`: the receiver as written, shortened. */
  target?: string;
  /**
   * For `attach-listener`, each of `event.preventDefault()`, `delete webPreferences.preload` and
   * `webPreferences.nodeIntegration = false`: `always` when it runs whenever the listener runs,
   * `conditional` behind a condition, `unknown` in a nested function or when the listener is not
   * a function literal written there, `no` when it is not written in the listener.
   */
  preventsDefault?: Effect;
  deletesPreload?: Effect;
  disablesNodeIntegration?: Effect;
  evidence: string;
  file: string;
  line: number;
}

export type Effect = "always" | "conditional" | "unknown" | "no";

/** The attributes of `<webview>` the collection keeps. */
const ATTRIBUTES = new Set([
  "src",
  "preload",
  "partition",
  "nodeintegration",
  "nodeintegrationinsubframes",
  "allowpopups",
  "disablewebsecurity",
  "webpreferences",
  "blinkfeatures",
]);
/** Attributes Electron reads as on when they are present, whatever their value. */
const BOOLEAN_ATTRIBUTES = [
  "nodeintegration",
  "nodeintegrationinsubframes",
  "allowpopups",
  "disablewebsecurity",
] as const;

/** A webviews row the cap may drop: one with nothing insecure and nothing unread. */
export const harmlessWebview = (r: WebviewRow): boolean =>
  r.kind !== "attach-listener" &&
  r.insecure.length === 0 &&
  r.hostDependent.length === 0 &&
  !r.unread?.length;

/** `webpreferences` values as Electron coerces them (parse-features-string.ts, `coerce`). */
function coerce(value: string | undefined): boolean | string {
  switch (value) {
    case undefined:
    case "true":
    case "1":
    case "yes":
      return true;
    case "false":
    case "0":
    case "no":
      return false;
    default:
      return value;
  }
}

/** A `webpreferences` attribute as Electron parses it: `key=value` pairs split at `,`. */
export function parseWebPreferences(
  source: string,
): Map<string, { value: boolean | string; raw: string }> {
  const out = new Map<string, { value: boolean | string; raw: string }>();
  for (const pair of source.split(",")) {
    const [key, value] = pair.split("=").map((s) => s.trim());
    if (key) out.set(key, { value: coerce(value), raw: pair.trim() });
  }
  return out;
}

/**
 * What a webview's attributes weaken: the webPreferences Electron builds from them, in its order
 * (the boolean attributes, then `webpreferences` over them), judged key by key.
 */
export function webviewWeaknesses(
  attributes: Readonly<Record<string, string | null>>,
): Pick<WebviewRow, "insecure" | "hostDependent"> {
  const prefs = new Map<string, { value: boolean | string; via: string }>();
  const has = (name: string): boolean => name in attributes;
  if (has("nodeintegration")) prefs.set("nodeIntegration", { value: true, via: "nodeintegration" });
  if (has("nodeintegrationinsubframes"))
    prefs.set("nodeIntegrationInSubFrames", { value: true, via: "nodeintegrationinsubframes" });
  if (has("allowpopups")) prefs.set("disablePopups", { value: false, via: "allowpopups" });
  if (has("disablewebsecurity"))
    prefs.set("webSecurity", { value: false, via: "disablewebsecurity" });
  const blink = attributes["blinkfeatures"];
  if (typeof blink === "string" && blink !== "")
    prefs.set("enableBlinkFeatures", { value: blink, via: `blinkfeatures="${short(blink)}"` });
  const written = attributes["webpreferences"];
  if (typeof written === "string")
    for (const [key, { value, raw }] of parseWebPreferences(written))
      prefs.set(key, { value, via: `webpreferences ${short(raw)}` });
  const insecure: string[] = [];
  const hostDependent: string[] = [];
  const is = (key: string, value: boolean | string): string | null => {
    const p = prefs.get(key);
    return p && p.value === value ? p.via : null;
  };
  for (const [key, value] of [
    ["nodeIntegration", true],
    ["nodeIntegrationInSubFrames", true],
    ["contextIsolation", false],
    ["sandbox", false],
  ] as const) {
    const via = is(key, value);
    if (via) hostDependent.push(via);
  }
  for (const [key, value] of [
    ["disablePopups", false],
    ["webSecurity", false],
    ["allowRunningInsecureContent", true],
    ["experimentalFeatures", true],
  ] as const) {
    const via = is(key, value);
    if (via) insecure.push(via);
  }
  const features = prefs.get("enableBlinkFeatures");
  if (features && typeof features.value === "string" && features.value !== "")
    insecure.push(features.via);
  return { insecure, hostDependent };
}

/** Attributes whose value decides what `webviewWeaknesses` reports. */
const JUDGED = new Set<string>([...BOOLEAN_ATTRIBUTES, "webpreferences", "blinkfeatures"]);

/**
 * An attribute whose value is not read. `maybe`: whether it is set at all is not known either
 * (a framework prop). A judged attribute goes to `unread` unless it is a boolean one that is set
 * (then its value does not matter); any other one is kept with a null value when it is set.
 */
function notRead(
  attributes: Record<string, string | null>,
  unread: string[],
  name: string,
  maybe: boolean,
): void {
  const boolean = BOOLEAN_ATTRIBUTES.includes(name as never);
  if (!maybe) attributes[name] = null;
  if (JUDGED.has(name) && (maybe || !boolean)) unread.push(name);
}

/** A row of a tag or element from its attributes. */
function tagRow(
  kind: WebviewRow["kind"],
  attributes: Record<string, string | null>,
  unread: string[],
  evidence: string,
  file: string,
  line: number,
): WebviewRow {
  const src = attributes["src"];
  return {
    kind,
    src: typeof src === "string" && src !== "" ? src : null,
    attributes,
    ...webviewWeaknesses(attributes),
    ...(unread.length ? { unread: [...new Set(unread)].toSorted() } : {}),
    evidence,
    file,
    line,
  };
}

/** The attributes of a parsed tag hexvero keeps, with values holding `${` not read. */
function keptAttributes(
  attrs: ReadonlyMap<string, string>,
  unread: string[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [name, value] of attrs) {
    if (!ATTRIBUTES.has(name)) continue;
    if (value.includes("${")) {
      out[name] = null;
      if (name === "webpreferences" || name === "blinkfeatures") unread.push(name);
    } else out[name] = value;
  }
  return out;
}

/** Per HTML file or JavaScript file at most this many rows; more is `webviews_truncated`. */
export const MAX_WEBVIEWS_PER_FILE = MAX_SECURITY_ROWS_PER_FILE;

/**
 * `<webview>` tags of an HTML text (`htmlStartTags`, also inside `<template>`, whose content a
 * script may clone). `kind` is `html` for an HTML file, `markup` for a string of the code; `line`
 * is added to the tag's own line within the text.
 */
export function webviewTagRows(
  text: string,
  file: string,
  kind: "html" | "markup" = "html",
  firstLine = 1,
  /** The text is cut (a template literal up to its first substitution). */
  cut = false,
): { rows: WebviewRow[]; capped: boolean } {
  const rows: WebviewRow[] = [];
  let capped = false;
  const lineAt = lineCounter(text);
  for (const tag of htmlStartTags(text, { inert: true })) {
    if (tag.name !== "webview") continue;
    if (rows.length >= MAX_WEBVIEWS_PER_FILE) {
      capped = true;
      break;
    }
    const unread: string[] = [];
    const attributes = keptAttributes(tag.attrs, unread);
    // a tag a string of the code ends inside (concatenated, or cut at a template substitution):
    // attributes after it are not read, and the last value read may be cut
    if ((cut || kind === "markup") && tag.end >= text.length) {
      unread.push("*");
      for (const name of Object.keys(attributes)) {
        attributes[name] = null;
        if (name === "webpreferences" || name === "blinkfeatures") unread.push(name);
      }
    }
    rows.push(
      tagRow(
        kind,
        attributes,
        unread,
        short(text.slice(tag.start, Math.min(tag.end + 1, tag.start + 200)).replace(/\s+/g, " ")),
        file,
        firstLine - 1 + lineAt(tag.start),
      ),
    );
  }
  return { rows, capped };
}

/** Webviews created by `createElement("webview")` alone read per file; more is `webviews_truncated`. */
const MAX_CREATED = 1000;
const LISTEN_METHODS = new Set(["on", "once", "addListener", "prependListener"]);
/** Functions that make an element of the name they are given with a props object. */
const ELEMENT_CALLS = new Set([
  "createElement",
  "jsx",
  "jsxs",
  "jsxDEV",
  "_jsx",
  "_jsxs",
  "createVNode",
  "createElementVNode",
  "createElementBlock",
  "createBlock",
  "_createVNode",
  "_createElementVNode",
  "_createElementBlock",
  "_createBlock",
]);

/**
 * `<webview>` markup in the strings of a file, webviews created in code and `will-attach-webview`
 * listeners.
 */
export function webviewCodeRows(
  tokens: Token[],
  file: string,
  resolver: ExpressionResolver,
  constants: Constants,
): { rows: WebviewRow[]; capped: boolean } {
  const r = new FileReader(tokens, resolver, constants);
  const rows: WebviewRow[] = [];
  let capped = false;
  const push = (row: WebviewRow): void => {
    if (keepRows(rows, [row], MAX_WEBVIEWS_PER_FILE, harmlessWebview)) capped = true;
  };

  /** The string or literal at [a, b) as written; null when it is not one. */
  const literal = (a: number, b: number): string | null => r.stringAt(a, b);

  /** An element created by `X.createElement("webview")` alone, by the name it is assigned to. */
  interface Created {
    at: number;
    name: string | null;
    attributes: Record<string, string | null>;
    unread: string[];
    evidence: string;
    line: number;
  }
  const created: Created[] = [];
  const createdAtToken = new Map<number, Created>();
  const createdByName = new Map<string, Created[]>();

  /** A props object at `open`: its keys as attributes. */
  const propsOf = (open: number, attributes: Record<string, string | null>, unread: string[]) => {
    const close = resolver.closeOf(open);
    if (close < 0) {
      unread.push("*");
      return;
    }
    for (let j = open + 1, d = 0; j < close; j++) {
      if (!r.spend()) {
        unread.push("*");
        return;
      }
      if (r.is(j, "(") || r.is(j, "[") || r.is(j, "{")) {
        if (d === 0 && r.is(j, "[") && (r.is(j - 1, "{") || r.is(j - 1, ","))) unread.push("*");
        d++;
        continue;
      }
      if (r.is(j, ")") || r.is(j, "]") || r.is(j, "}")) {
        d--;
        continue;
      }
      if (d !== 0 || !(r.is(j - 1, "{") || r.is(j - 1, ","))) continue;
      if (r.is(j, "...")) {
        unread.push("*");
        continue;
      }
      const t = tokens[j]!;
      if (t.type !== "ident" && t.type !== "string") continue;
      const name = t.value.toLowerCase();
      if (!ATTRIBUTES.has(name)) continue;
      // `{ src }`: a shorthand, its value is a name
      if (!r.is(j + 1, ":")) {
        notRead(attributes, unread, name, true);
        continue;
      }
      const end = r.exprEnd(j + 2);
      if (end < 0) {
        notRead(attributes, unread, name, true);
        continue;
      }
      const value = literal(j + 2, end);
      if (value !== null) {
        attributes[name] = value;
        continue;
      }
      const bool = end === j + 3 ? r.ident(j + 2) : null;
      // `false`, `null`, `undefined`: the attribute is not set
      if (bool === "false" || bool === "null" || bool === "undefined") continue;
      if (end === j + 4 && r.is(j + 2, "!") && tokens[j + 3]?.type === "number") {
        // `!1` is false, `!0` true
        if (tokens[j + 3]!.value !== "0") continue;
      }
      // a value that is not a string literal: a framework may set it, drop it (React drops a
      // boolean on an unknown attribute) or stringify it
      notRead(attributes, unread, name, true);
    }
  };

  for (let k = 1; k + 1 < tokens.length; k++) {
    if (r.work <= 0) {
      capped = true;
      break;
    }
    const t = tokens[k]!;
    // markup in a string or template
    if ((t.type === "string" || t.type === "template") && /<webview(?![\w-])/i.test(t.value)) {
      const cut = t.type === "template" && t.value.endsWith("${…}");
      const text = cut ? t.value.slice(0, -"${…}".length) : t.value;
      const found = webviewTagRows(text, file, "markup", t.line, cut);
      for (const row of found.rows) push(row);
      if (found.capped) capped = true;
      continue;
    }
    if (t.type !== "string" || t.value.toLowerCase() !== "webview" || !r.is(k - 1, "(")) continue;
    // `X.createElement("webview")`, `createElement("webview", …)`, `(0, r.jsx)("webview", …)`
    let at = k - 2;
    let from = -1;
    if (r.is(at, ")")) {
      // a callee in parentheses, as bundlers write imported functions
      from = resolver.openOf(at);
      at--;
      if (from < 0 || !r.is(from, "(")) continue;
    }
    const callee = r.ident(at);
    if (!callee || !ELEMENT_CALLS.has(callee)) continue;
    const open = k - 1;
    const close = resolver.closeOf(open);
    if (close < 0) continue;
    const attributes: Record<string, string | null> = {};
    const unread: string[] = [];
    if (from < 0) from = r.dot(at - 1) ? r.chainStart(at - 1) : at;
    const evidence = r.text(from, Math.min(close + 1, k + 10));
    if (r.is(k + 1, ",")) {
      const end = r.exprEnd(k + 2);
      if (r.is(k + 2, "{") && resolver.closeOf(k + 2) === end - 1)
        propsOf(k + 2, attributes, unread);
      else if (!(end === k + 3 && (r.ident(k + 2) === "null" || r.ident(k + 2) === "undefined")))
        // props passed by name, or document.createElement's options: not read
        unread.push("*");
      push(tagRow("element", attributes, unread, evidence, file, t.line));
      continue;
    }
    if (!r.is(k + 1, ")")) continue;
    // `name = X.createElement("webview")`: its setAttribute calls are read below
    let name: string | null = null;
    if (r.is(from - 1, "=") && !r.is(from - 2, "=") && r.ident(from - 2) && !r.dot(from - 3))
      name = r.ident(from - 2);
    // past the cap a webview created this way is not read: a limitation, never a silent stop
    if (created.length >= MAX_CREATED) {
      capped = true;
      continue;
    }
    const c: Created = { at: from, name, attributes, unread, evidence, line: t.line };
    created.push(c);
    createdAtToken.set(from, c);
    if (name !== null) {
      const list = createdByName.get(name);
      if (list) list.push(c);
      else createdByName.set(name, [c]);
    }
  }

  // setAttribute calls and attribute properties on a name bound or assigned to a created webview
  if (createdByName.size > 0)
    for (let k = 2; k + 3 < tokens.length; k++) {
      if (r.work <= 0) {
        capped = true;
        break;
      }
      const base = r.ident(k);
      if (!base || r.dot(k - 1) || !r.dot(k + 1)) continue;
      if (!createdByName.has(base)) continue;
      const method = r.ident(k + 2);
      if (!method) continue;
      const call = method === "setAttribute" && r.is(k + 3, "(");
      const property =
        ATTRIBUTES.has(method) && r.is(k + 3, "=") && !r.is(k + 4, "=") && !r.is(k + 4, ">");
      if (!call && !property) continue;
      const element = createdAt(k, base);
      if (!element) continue;
      if (call) {
        const close = resolver.closeOf(k + 3);
        const nameEnd = close < 0 ? -1 : r.exprEnd(k + 4);
        const attr = nameEnd < 0 ? null : literal(k + 4, nameEnd);
        if (attr === null) {
          element.unread.push("*");
          continue;
        }
        const lower = attr.toLowerCase();
        if (!ATTRIBUTES.has(lower)) continue;
        const valueEnd = r.is(nameEnd, ",") ? r.exprEnd(nameEnd + 1) : -1;
        const value = valueEnd < 0 ? null : literal(nameEnd + 1, valueEnd);
        // setAttribute sets the attribute whatever the value: a boolean attribute is on
        if (value !== null) element.attributes[lower] = value;
        else notRead(element.attributes, element.unread, lower, false);
        continue;
      }
      // `wv.allowpopups = true`: Electron's property sets a boolean attribute for a truthy value
      // and removes it for a falsy one; another property sets the attribute to the value
      const boolean = BOOLEAN_ATTRIBUTES.includes(method as never);
      const end = r.exprEnd(k + 4, true);
      const value = end < 0 ? null : literal(k + 4, end);
      if (value !== null) {
        if (!boolean) element.attributes[method] = value;
        else if (value !== "") element.attributes[method] = "";
        else delete element.attributes[method];
        continue;
      }
      const truthy = end < 0 ? null : r.boolAt(k + 4, end);
      if (boolean && truthy === true) element.attributes[method] = "";
      else if (boolean && truthy === false) delete element.attributes[method];
      else notRead(element.attributes, element.unread, method, boolean);
    }
  for (const c of created)
    push(tagRow("element", c.attributes, c.unread, c.evidence, file, c.line));

  /**
   * The created webview the name at k stands for: the one its binding's value is, else the
   * nearest assignment of one to it before k in the same function, with no other assignment of
   * the name between.
   */
  function createdAt(k: number, name: string): Created | null {
    if (!r.spend()) return null;
    if (resolver.boundAround(k, name)?.kind === "param") return null;
    const bound = resolver.binding(k, name);
    if (bound?.kind === "value") {
      const [a] = r.trim(bound.range[0], bound.range[1]);
      const c = createdAtToken.get(a);
      return c?.name === name ? c : null;
    }
    const list = createdByName.get(name) ?? [];
    // the last creation before k: the list is in token order
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.at < k) lo = mid + 1;
      else hi = mid;
    }
    const fn = resolver.functionAt(k);
    let best: Created | null = null;
    for (let i = lo - 1; i >= 0; i--) {
      if (!r.spend()) return null;
      if (resolver.functionAt(list[i]!.at) === fn) {
        best = list[i]!;
        break;
      }
    }
    if (!best) return null;
    // another assignment of the name between the creation and k
    for (let j = best.at + 1; j < k; j++) {
      if (!r.spend()) return null;
      if (r.ident(j) === name && !r.dot(j - 1) && r.is(j + 1, "=") && !r.is(j + 2, "="))
        return null;
    }
    return best;
  }

  // will-attach-webview listeners
  for (let k = 1; k + 4 < tokens.length; k++) {
    if (!r.dot(k) || !LISTEN_METHODS.has(r.ident(k + 1) ?? "") || !r.is(k + 2, "(")) continue;
    const ev = tokens[k + 3];
    if (ev?.type !== "string" || ev.value !== "will-attach-webview" || !r.is(k + 4, ",")) continue;
    if (r.work <= 0) {
      capped = true;
      break;
    }
    const from = r.is(k - 1, ")") ? k - 1 : r.chainStart(k);
    const def = r.handlerAt(k + 5);
    const effects = def
      ? listenerEffects(def)
      : {
          preventsDefault: "unknown",
          deletesPreload: "unknown",
          disablesNodeIntegration: "unknown",
        };
    push({
      kind: "attach-listener",
      src: null,
      attributes: {},
      insecure: [],
      hostDependent: [],
      target: r.ident(from) ? r.text(from, k) : "?",
      ...(effects as Pick<
        WebviewRow,
        "preventsDefault" | "deletesPreload" | "disablesNodeIntegration"
      >),
      evidence: `${r.ident(from) ? r.text(from, k + 2) : `…${r.text(k, k + 2)}`}("will-attach-webview", …)`,
      file,
      line: ev.line,
    });
  }

  /** What a will-attach-webview listener does with its event and webPreferences. */
  function listenerEffects(
    def: FnDef,
  ): Pick<WebviewRow, "preventsDefault" | "deletesPreload" | "disablesNodeIntegration"> {
    const event = r.callbackParam(def, 0);
    const prefs = r.callbackParam(def, 1);
    const out: Record<"preventsDefault" | "deletesPreload" | "disablesNodeIntegration", Effect> = {
      preventsDefault: event === null ? "unknown" : "no",
      deletesPreload: prefs === null ? "unknown" : "no",
      disablesNodeIntegration: prefs === null ? "unknown" : "no",
    };
    const RANK: Effect[] = ["always", "unknown", "conditional", "no"];
    const note = (key: keyof typeof out, at: number): void => {
      const reach = r.reach(def, at);
      if (RANK.indexOf(reach) < RANK.indexOf(out[key])) out[key] = reach;
    };
    /** The name at j is the listener's own parameter `param`. */
    const own = (j: number, param: string): boolean => {
      let owner = resolver.functionAt(j);
      while (
        owner &&
        owner !== def &&
        !owner.params.some((p) => p.kind === "name" && p.name === param)
      )
        owner = resolver.outerOf(owner);
      return owner === def;
    };
    /** `NAME.key` or `NAME["key"]` at j; the token after it, else -1. */
    const member = (j: number, key: string): number => {
      if (r.dot(j + 1) && r.ident(j + 2) === key) return j + 3;
      if (
        r.is(j + 1, "[") &&
        tokens[j + 2]?.type === "string" &&
        tokens[j + 2]!.value === key &&
        r.is(j + 3, "]")
      )
        return j + 4;
      return -1;
    };
    for (let j = def.body[0]; j <= def.body[1] && j < tokens.length; j++) {
      if (!r.spend()) {
        for (const key of Object.keys(out) as Array<keyof typeof out>)
          if (out[key] === "no") out[key] = "unknown";
        break;
      }
      const name = r.ident(j);
      if (!name || r.dot(j - 1)) continue;
      if (typeof event === "string" && name === event && own(j, event)) {
        const after = member(j, "preventDefault");
        if (after > 0 && r.is(after, "(")) note("preventsDefault", j);
      }
      if (typeof prefs !== "string" || name !== prefs || !own(j, prefs)) continue;
      // `delete webPreferences.preload` (and `preloadURL`, read by older Electron versions)
      if (
        r.ident(j - 1) === "delete" &&
        (member(j, "preload") > 0 || member(j, "preloadURL") > 0)
      ) {
        note("deletesPreload", j);
        continue;
      }
      for (const key of ["preload", "nodeIntegration"] as const) {
        const after = member(j, key);
        if (after < 0 || !r.is(after, "=") || r.is(after + 1, "=")) continue;
        const end = r.exprEnd(after + 1, true);
        const value = end < 0 ? null : r.boolAt(after + 1, end);
        // `webPreferences.preload = undefined` (or "") drops it; nodeIntegration = false/!1/0
        if (value === false)
          note(key === "preload" ? "deletesPreload" : "disablesNodeIntegration", j);
      }
    }
    return out;
  }

  if (r.capped) capped = true;
  return { rows, capped };
}
