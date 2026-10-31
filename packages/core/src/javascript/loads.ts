/**
 * Pages and resources the app loads, the `loads` collection (Electronegativity's
 * HTTP_RESOURCES_JS_CHECK, HTTP_RESOURCES_HTML_CHECK and
 * HTTP_RESOURCES_WITH_NODE_INTEGRATION_GLOBAL_CHECK; Electron's security guide, section 1):
 *
 * - `loadURL`: `X.loadURL(url)` with the receiver read as a window of the file (`win.loadURL`,
 *   `win.webContents.loadURL`), another webContents (`X.webContents.loadURL`, a BrowserView's or
 *   a WebContentsView's) or unknown (a parameter, a `<webview>` element, a name not read), and the
 *   URL as a literal (also through a constant), its known start (a template or a concatenation),
 *   its possible values (a conditional of literals) or unknown;
 * - `script`, `stylesheet`, `iframe`: `<script src>`, `<link rel="stylesheet" href>` and
 *   `<iframe src>` of the app's HTML files with an absolute URL (resolved against the file's
 *   `<base href>` when that is absolute). Relative and protocol-relative sources load from
 *   wherever the page itself came from and give no row.
 *
 * Nothing is fetched or run.
 */
import type { Constants } from "./aliases.js";
import type { ExpressionResolver } from "./resolve.js";
import type { Token } from "./scan.js";
import {
  FileReader,
  htmlStartTags,
  keepRows,
  lineCounter,
  MAX_SECURITY_ROWS_PER_FILE,
  schemeOf,
  short,
  urlArgument,
} from "./security.js";

export interface LoadRow {
  kind: "loadURL" | "script" | "stylesheet" | "iframe";
  /**
   * For `loadURL`: `window` (a window of the file by name, `win.loadURL` or
   * `win.webContents.loadURL`), `webContents` (`X.webContents.loadURL` with X not read as a window
   * of the file) or `unknown` (any other receiver). `html` for a tag of an HTML file.
   */
  targetKind: "window" | "webContents" | "unknown" | "html";
  /** The receiver as written, shortened (the tag, `<script>`, for an HTML row). */
  target: string;
  /** The window's name as `windows` gives it, for `targetKind: window`; else null. */
  window: string | null;
  /**
   * `literal`: the URL is one string read whole (every HTML row); `inferred`: only its start (a
   * template or a concatenation that begins with a literal) or a short list of possible values
   * is known; `unknown`: nothing of it is read.
   */
  argumentKind: "literal" | "inferred" | "unknown";
  /** The URL (literal; for an HTML row resolved against `<base href>`), its known start, or null. */
  argument: string | null;
  /** For `inferred` from a list of possible values: those values (at most 8). */
  values?: string[];
  /** The URL scheme, lowercased without `:`, when the known part names one; else null. */
  scheme: string | null;
  evidence: string;
  file: string;
  line: number;
}

/** URLs longer than this are cut (with `…`): a `data:` URL may be megabytes. */
const MAX_URL = 300;
const clip = (url: string): string => (url.length > MAX_URL ? `${url.slice(0, MAX_URL)}…` : url);

/**
 * How a URL loads over plain http: `remote` (an `http:` URL whose host is not this machine),
 * `local` (`localhost`, a name under `.localhost`, `127.0.0.0/8`, `[::1]` or `0.0.0.0`: a dev
 * server, which no one on the network path sits between), `maybe` (`http:` whose host is not in
 * the known start of the URL), or null (another scheme, or none read). `whole`: the text is the
 * whole URL, not only its start.
 */
export function httpLoad(text: string, whole: boolean): "remote" | "local" | "maybe" | null {
  if (schemeOf(text) !== "http") return null;
  // as a WHATWG parser reads it: leading C0 controls and spaces dropped, tabs and newlines anywhere
  let start = 0;
  while (start < text.length && text.charCodeAt(start) <= 0x20) start++;
  const flat = text.slice(start).replace(/[\t\n\r]/g, "");
  let host: string | null = null;
  if (whole) {
    try {
      host = new URL(flat).hostname.toLowerCase();
    } catch {
      return null;
    }
  } else {
    // `http://host:…`, `http://host/…`, `http://user@host?…`: the host ends before one of
    // `:/\?#` in the known part; without one it may go on (`http://` + host)
    const m = /^http:[/\\]*(?:[^@/\\?#]*@)?(\[[^\]]*\]|[^:/\\?#@]*)[:/\\?#]/i.exec(flat);
    if (!m) return "maybe";
    host = m[1]!.toLowerCase();
  }
  if (!host) return "maybe";
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  )
    return "local";
  return "remote";
}

/** How the URLs a row may load go over plain http: the worst of its literal or its values. */
export function loadHttp(
  row: Pick<LoadRow, "argumentKind" | "argument" | "values">,
): "remote" | "local" | "maybe" | null {
  if (row.argumentKind === "literal")
    return row.argument === null ? null : httpLoad(row.argument, true);
  if (row.argumentKind !== "inferred") return null;
  if (row.values) {
    const all = row.values.map((v) => httpLoad(v, true));
    return all.includes("remote") ? "remote" : all.includes("local") ? "local" : null;
  }
  return row.argument === null ? null : httpLoad(row.argument, false);
}

const harmless = new WeakMap<LoadRow, boolean>();
/**
 * A loads row the cap may drop: one that loads nothing over plain http from another host. The
 * verdict is kept per row: a full list asks it of every kept row for each row that comes in.
 */
export const harmlessLoad = (r: LoadRow): boolean => {
  let known = harmless.get(r);
  if (known === undefined) {
    const http = loadHttp(r);
    known = http === null || http === "local";
    harmless.set(r, known);
  }
  return known;
};

/** `X.loadURL(url)` calls of a file. `windowNames`: the names of the windows the file creates. */
export function loadUrlRows(
  tokens: Token[],
  file: string,
  resolver: ExpressionResolver,
  constants: Constants,
  windowNames: ReadonlySet<string>,
): { rows: LoadRow[]; capped: boolean } {
  const r = new FileReader(tokens, resolver, constants);
  const rows: LoadRow[] = [];
  let capped = false;
  const push = (row: LoadRow): void => {
    if (keepRows(rows, [row], MAX_SECURITY_ROWS_PER_FILE, harmlessLoad)) capped = true;
  };
  /**
   * The name at k is the file's window there: not a parameter or another local of that name, and
   * bound (if at all in scope) to a `new …` expression. A member (`this.win`) is taken by name.
   */
  const windowAt = (k: number, member: boolean): boolean => {
    const name = r.ident(k);
    if (!name || !windowNames.has(name)) return false;
    if (member || !r.spend()) return member;
    if (resolver.paramAround(k, name)) return false;
    const bound = resolver.binding(k, name, true);
    if (bound && bound.kind !== "value") return false;
    return !(bound?.kind === "value" && r.ident(bound.range[0]) !== "new");
  };
  for (let k = 1; k + 1 < tokens.length; k++) {
    const t = tokens[k]!;
    const bracketed = t.type === "string" && r.is(k - 1, "[") && r.is(k + 1, "]");
    if ((t.type !== "ident" && !bracketed) || t.value !== "loadURL") continue;
    if (!(bracketed || r.dot(k - 1))) continue;
    if (r.work <= 0) {
      capped = true;
      break;
    }
    const after = bracketed ? k + 2 : k + 1;
    const open = r.is(after, "(")
      ? after
      : r.is(after, "?.") && r.is(after + 1, "(")
        ? after + 1
        : -1;
    if (open < 0) continue;
    const d = k - 1;
    const from = r.chainStart(d);
    // a function of an object literal of the file: a look-alike, no row
    if (r.ident(from) && r.ownLiteralMethod(from, d, "loadURL")) continue;
    const close = resolver.closeOf(open);
    if (close < 0) continue;
    let targetKind: LoadRow["targetKind"] = "unknown";
    let window: string | null = null;
    const last = r.ident(d - 1);
    if (last === "webContents" && r.dot(d - 2)) {
      // `win.webContents.loadURL`, `this.win.webContents.loadURL`
      const owner = d - 3;
      targetKind = windowAt(owner, r.dot(owner - 1)) ? "window" : "webContents";
      if (targetKind === "window") window = r.ident(owner);
    } else if (last && windowAt(d - 1, r.dot(d - 2))) {
      targetKind = "window";
      window = last;
    }
    const end = r.is(open + 1, ")") ? -1 : r.exprEnd(open + 1);
    const read =
      end < 0
        ? { argumentKind: "unknown" as const, argument: null, scheme: null }
        : urlArgument(r, open + 1, end);
    push({
      kind: "loadURL",
      targetKind,
      target: r.ident(from) ? r.text(from, d) : "?",
      window,
      ...read,
      argument: read.argument === null ? null : clip(read.argument),
      ...(read.values ? { values: read.values.map(clip) } : {}),
      evidence: `${r.ident(from) ? r.text(from, open + 1) : `…${r.text(d, open + 1)}`}${r.text(open + 1, Math.min(close, open + 12))}${close > open + 12 ? "…" : ""})`,
      file,
      line: t.line,
    });
  }
  if (r.capped) capped = true;
  return { rows, capped };
}

/** An absolute URL: one that names a scheme. */
const absolute = (url: string): boolean => schemeOf(url) !== null;

/**
 * `<script src>`, `<link rel="stylesheet" href>` and `<iframe src>` of an HTML file with an
 * absolute URL, read with `htmlStartTags` (comments, raw text and the content of `<template>` and
 * `<noscript>` are not read as markup). The first `<base href>` with an absolute URL resolves
 * relative sources, as in HTML.
 */
export function htmlLoadRows(text: string, file: string): { rows: LoadRow[]; capped: boolean } {
  const rows: LoadRow[] = [];
  let capped = false;
  const tags = [...htmlStartTags(text)];
  let base: string | null = null;
  for (const tag of tags) {
    if (tag.name !== "base" || !tag.attrs.has("href")) continue;
    // the first base element with an href sets the document's base URL
    const href = tag.attrs.get("href")!.trim();
    base = absolute(href) ? href : null;
    break;
  }
  const lineAt = lineCounter(text);
  for (const tag of tags) {
    let kind: LoadRow["kind"] | null = null;
    let attr = "src";
    if (tag.name === "script") kind = "script";
    else if (tag.name === "iframe") kind = "iframe";
    else if (tag.name === "link") {
      const rel = (tag.attrs.get("rel") ?? "").toLowerCase().split(/[\t\n\f\r ]+/);
      if (rel.includes("stylesheet")) {
        kind = "stylesheet";
        attr = "href";
      }
    }
    if (!kind) continue;
    const written = tag.attrs.get(attr)?.trim();
    if (!written) continue;
    let url: string | null = absolute(written) ? written : null;
    if (url === null && base !== null)
      try {
        url = new URL(written, base).href;
      } catch {
        url = null;
      }
    if (url === null) continue;
    const row: LoadRow = {
      kind,
      targetKind: "html",
      target: `<${tag.name}>`,
      window: null,
      argumentKind: "literal",
      argument: clip(url),
      scheme: schemeOf(url),
      evidence: short(
        text.slice(tag.start, Math.min(tag.end + 1, tag.start + 200)).replace(/\s+/g, " "),
      ),
      file,
      line: lineAt(tag.start),
    };
    if (keepRows(rows, [row], MAX_SECURITY_ROWS_PER_FILE, harmlessLoad)) capped = true;
  }
  return { rows, capped };
}
