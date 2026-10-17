import type { Limitation } from "../model.js";
import type { JsAppInfo } from "./app.js";

/**
 * The Electron interface map: one row per member a preload script exposes through contextBridge,
 * joined to the windows that load that preload and to the main-process end of its IPC channel.
 *
 * Rows are joined only on identity: a window's resolved `preload` equals the bridge member's file,
 * and an IPC call's channel equals the member's channel character for character. Nothing is
 * matched by similar names, so the map has no heuristic links; what cannot be joined is
 * `unresolved` or `unknown`, with the reason.
 */
export interface InterfaceEnd {
  file: string;
  line: number;
  /** `ipcMain.handle`, `webContents.send`, … */
  api: string;
  /** How the end's channel was read when it was not a literal (see `IpcUsage.via`). */
  via?: string;
  /** For a call of a wrapper method: which one (`IpcMainManager.handle`). */
  wrapper?: string;
}

export interface InterfaceRow {
  /** `window.<api>.<member>` in the page. */
  api: string;
  member: string | null;
  world: "main" | "isolated";
  /** Where the member is exposed. */
  file: string;
  line: number;
  /**
   * Windows whose preload is this file, as `file:name` (the variable the window is assigned to, or
   * `#n` for the n-th unnamed window of the file). Empty when no window names it.
   */
  windows: string[];
  channel: string | null;
  /**
   * `to-main` when the other end receives in the main process (`ipcMain.*`), `to-renderer` when
   * it sends to the page (`webContents.send`, `event.reply`), both when both occur, null without
   * an end.
   */
  direction: "to-main" | "to-renderer" | "both" | null;
  /** IPC calls outside renderer code on the same channel: the first 20 by file and line. */
  ends: InterfaceEnd[];
  /** How many such calls exist; `direction` and `link` are computed from all of them. */
  endsTotal: number;
  /** True when `ends` holds fewer than `endsTotal` calls. */
  endsTruncated: boolean;
  /**
   * - `direct`: every end names the channel as a literal.
   * - `resolved`: an end was reached through a constant, an alias, a wrapper or the resolver.
   * - `unresolved`: the member's own channel could not be read.
   * - `unknown`: no end was found, but the analysis could not read every channel or file, so
   *   one may exist.
   * - `none`: no end in an analysis that read every file and every channel.
   */
  link: "direct" | "resolved" | "unresolved" | "unknown" | "none";
  /** Why the link is `unresolved`, `unknown` or `none`. */
  reason?: string;
}

/** Limitations after which a missing end is not evidence that there is none. */
const BLIND_SPOTS = new Set([
  "ipc_channel_unresolved",
  "ipc_receiver_unresolved",
  "ipc_open_calls_capped",
  "ipc_wrappers_capped",
  "scan_truncated",
  "js_files_skipped",
  "js_files_truncated",
  "directory_truncated",
  "symlinks_skipped",
]);

const MAX_ENDS = 20;

/** The parts of an application analysis the map reads. */
type AppParts = Pick<JsAppInfo, "modules" | "contextBridge" | "windows" | "coverage">;

export function interfaceMap(app: AppParts, limitations: readonly Limitation[]): InterfaceRow[] {
  const ends = new Map<string, InterfaceEnd[]>();
  for (const m of app.modules) {
    for (const u of m.ipc) {
      if (
        !u.channel ||
        u.api.startsWith("ipcRenderer.") ||
        u.api.startsWith("contextBridge.") ||
        // a method that is not read (`ipcMain[route.kind](…)`): no end of either kind
        u.api.endsWith(".[unknown]")
      )
        continue;
      const list = ends.get(u.channel) ?? [];
      list.push({
        file: m.id,
        line: u.line,
        api: u.api,
        ...(u.via ? { via: u.via } : {}),
        ...(u.wrapper ? { wrapper: u.wrapper } : {}),
      });
      ends.set(u.channel, list);
    }
  }
  // Per channel: its ends sorted once, and counts per file, so each bridge member costs the
  // ends it shows rather than a filter and sort of every end (20,000 copies of one preload
  // made that quadratic: 75 s in the regression test).
  type Counts = { all: number; main: number; via: number };
  const sorted = new Map<string, InterfaceEnd[]>();
  const totals = new Map<string, Counts>();
  const byFile = new Map<string, Counts>();
  const add = (map: Map<string, Counts>, key: string, e: InterfaceEnd): void => {
    const c = map.get(key) ?? { all: 0, main: 0, via: 0 };
    c.all++;
    if (e.api.startsWith("ipcMain.")) c.main++;
    if (e.via !== undefined) c.via++;
    map.set(key, c);
  };
  for (const [channel, list] of ends) {
    sorted.set(
      channel,
      list.toSorted((x, y) => x.file.localeCompare(y.file) || x.line - y.line),
    );
    for (const e of list) {
      add(totals, channel, e);
      add(byFile, `${channel}\u0000${e.file}`, e);
    }
  }
  const blind = [
    ...new Set(limitations.map((l) => l.code).filter((c) => BLIND_SPOTS.has(c))),
    ...(app.coverage.complete ? [] : ["scan_partial"]),
  ];
  return app.contextBridge.map((b) => {
    const windows = (app.windows ?? [])
      .filter((w) => w.preload === b.file)
      .map((w) => `${w.file}:${w.windowName}`);
    const base = {
      api: b.api,
      member: b.member,
      world: b.world,
      file: b.file,
      line: b.line,
      windows,
      channel: b.channel,
    };
    if (b.channel === null)
      return {
        ...base,
        direction: null,
        ends: [],
        endsTotal: 0,
        endsTruncated: false,
        link: "unresolved",
        reason:
          "the member names no IPC channel hexvero could read; it may not use IPC at all, or pass a channel built at run time",
      };
    const none: Counts = { all: 0, main: 0, via: 0 };
    const total = totals.get(b.channel) ?? none;
    const own = byFile.get(`${b.channel}\u0000${b.file}`) ?? none;
    // ends in other files than the member's own
    const count = total.all - own.all;
    const main = total.main - own.main;
    const via = total.via - own.via;
    const shown: InterfaceEnd[] = [];
    for (const e of sorted.get(b.channel) ?? []) {
      if (shown.length === MAX_ENDS) break;
      if (e.file !== b.file) shown.push(e);
    }
    if (count === 0)
      return {
        ...base,
        direction: null,
        ends: [],
        endsTotal: 0,
        endsTruncated: false,
        ...(blind.length
          ? {
              link: "unknown",
              reason: `no main-process end found, but the analysis has blind spots (${blind.join(", ")})`,
            }
          : {
              link: "none",
              reason: "no main-process end for this channel in any file read",
            }),
      };
    const toMain = main > 0;
    const toRenderer = count - main > 0;
    return {
      ...base,
      direction: toMain && toRenderer ? "both" : toMain ? "to-main" : "to-renderer",
      ends: shown,
      endsTotal: count,
      endsTruncated: count > MAX_ENDS,
      link: via === 0 ? "direct" : "resolved",
    };
  });
}
