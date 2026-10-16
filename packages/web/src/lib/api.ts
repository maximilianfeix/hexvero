/**
 * Typed client for the hexvero HTTP API. The session token arrives once in the URL hash
 * (`#token=…`, printed by `hexvero ui`); it is moved to storage and removed from the address bar
 * on load, so it is not in copied links, history entries, screenshots of the URL or reports.
 */

export interface TargetInfo {
  path: string;
  size: number;
  sha256: string;
  format: string;
}
export interface TargetRecord {
  id: string;
  info: TargetInfo;
  openedAt: string;
  analyzed: boolean;
}
export interface Finding {
  kind: string;
  title: string;
  detail?: string;
  confidence: "confirmed" | "inferred";
  /** Where the fact was read: a path, section or byte offset, when the parser recorded one. */
  location?: string;
}
export interface Limitation {
  code: string;
  message: string;
}
export interface AnalysisResponse {
  target: TargetRecord;
  summary: string;
  durationMs: number;
  findings: Finding[];
  limitations: Limitation[];
  collections: Record<string, number>;
  /** Present for JavaScript applications: how much of the code has been read. */
  coverage?: {
    total: number;
    scanned: number;
    remaining: number;
    skipped: number;
    complete: boolean;
    resumed: boolean;
    nextFiles: string[];
  };
  data: Record<string, unknown> & { kind: string };
}
export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  truncated: boolean;
  collection: string;
  bytes: number;
  /** Offset of the following page; null on the last one. Pages hold fewer rows than asked for when the byte budget runs out. */
  next?: number | null;
  /** The first row was too large for the page and is shortened; `itemBytes` is its full size. */
  itemTruncated?: boolean;
  itemBytes?: number;
}
export interface StringItem {
  offset: number;
  encoding: string;
  value: string;
  /** Full length when the value was cut to 4096 characters. */
  length?: number;
  tags: string[];
}
export interface ByteWindow {
  offset: number;
  length: number;
  hex: string;
  ascii: string;
  total: number;
}
/** Mirrors `ReleaseComparison` of @hexvero/core (the UI does not import server code). */
export interface Place {
  side: "a" | "b";
  file: string;
  line?: number;
  role?: string;
}
export interface ChangeRow {
  /** Stable id (contract C3); the client fills it in when an older server leaves it out. */
  id: string;
  collection: string;
  change: "added" | "removed" | "changed" | "unknown";
  key: string;
  /** In b for added and changed rows, in a for removed ones; `[]` when no position is known. */
  where: Place[];
  /** Changed rows: where the item was read in a (C3). Absent from older servers. */
  whereBefore?: Place[];
  basis?: string;
  fields?: Array<{ field: string; before: unknown; after: unknown }>;
  reason?: string;
}
/** How much of one collection was compared (contract C1). */
export interface CompareCompleteness {
  compared: { a: number; b: number };
  total: { a: number; b: number };
  complete: boolean;
  gaps: string[];
}
/** Which rows of the comparison `changes` holds (contract C3). */
export interface ComparisonPage {
  offset: number;
  limit: number;
  total: number;
  next: number | null;
}
export interface CollectionComparison {
  collection: string;
  key: string | null;
  added: number;
  removed: number;
  changed: number;
  relocated: number;
  unknown: number;
  unchanged: number;
  totals: { a: number; b: number };
  partial: boolean;
}
export interface ReleaseComparison {
  hexvero: string;
  a: TargetRecord;
  b: TargetRecord;
  overview: {
    collections: CollectionComparison[];
    onlyA: string[];
    onlyB: string[];
    partialScan: { a: boolean; b: boolean };
    windowChanges: Array<{
      window: string;
      setting: string;
      before: string;
      after: string;
      direction: "more permissive" | "less permissive" | "unclear";
    }>;
  };
  changes: ChangeRow[];
  cut: Array<{ collection: string; shown: number; total: number }>;
  limitations: { a: Limitation[]; b: Limitation[] };
  /** Per collection (C3); absent from older servers. */
  completeness?: Record<string, CompareCompleteness>;
  page: ComparisonPage;
}
export interface SourceWindow {
  file: string;
  line: number;
  start: number;
  lines: string[];
  totalLines: number;
  cut: Array<{ line: number; length: number }>;
}
export interface ApiError {
  code: string;
  message: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = "hexvero.token";
/** Kept in memory as well, for a browser that refuses storage. */
let memoryToken = "";

/**
 * Moves `#token=…` out of the address bar. The token goes to localStorage (same origin only: the
 * loopback port of this server) so a reload and a link opened in a new tab keep working; it is
 * left in the URL only when storage refuses it, because a reload would otherwise lock the page.
 * Exported for the unit test; runs once when this module loads.
 */
export function adoptHashToken(
  location: Pick<Location, "hash" | "pathname" | "search">,
  storage: Pick<Storage, "setItem"> | null,
  replace: (url: string) => void,
): string {
  const hash = new URLSearchParams(location.hash.slice(1));
  const t = hash.get("token");
  if (!t) return "";
  memoryToken = t;
  try {
    if (!storage) return t;
    storage.setItem(TOKEN_KEY, t);
  } catch {
    return t;
  }
  hash.delete("token");
  replace(`${location.pathname}${location.search}${hash.size ? `#${hash}` : ""}`);
  return t;
}

const token = (): string => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
};
if (typeof window !== "undefined")
  adoptHashToken(
    window.location,
    (() => {
      try {
        return window.localStorage;
      } catch {
        return null;
      }
    })(),
    (url) => window.history.replaceState(window.history.state, "", url),
  );

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token()}`, ...init.headers },
  });
  if (!res.ok) {
    let error: ApiError = { code: String(res.status), message: res.statusText };
    try {
      error = ((await res.json()) as { error: ApiError }).error;
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401)
      error.message = `${error.message}. Open the link that \`hexvero ui\` printed in the terminal again.`;
    throw new HttpError(res.status, error.code, error.message);
  }
  return (await res.json()) as T;
}

/** A short, stable id for a row from a server that does not send one (before contract C3). */
export function fallbackRowId(row: Pick<ChangeRow, "collection" | "change" | "key">): string {
  // FNV-1a, 64 bit: not a security hash, only a key for the URL and React.
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(`${row.collection}\0${row.change}\0${row.key}`)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

type WireComparison = Omit<ReleaseComparison, "changes" | "page"> & {
  changes: Array<Omit<ChangeRow, "id"> & { id?: string }>;
  page?: ComparisonPage;
};

/**
 * Fills in what an older server leaves out (row ids, the page) so the views code against
 * contract C3 only. Rows without a page were all sent at once.
 */
export function normalizeComparison(wire: WireComparison, offset = 0): ReleaseComparison {
  const changes = wire.changes.map((row) => ({ ...row, id: row.id ?? fallbackRowId(row) }));
  const cutRows = wire.cut.reduce((n, c) => n + Math.max(0, c.total - c.shown), 0);
  return {
    ...wire,
    changes,
    page: wire.page ?? {
      offset,
      limit: changes.length,
      total: offset + changes.length + cutRows,
      next: null,
    },
  };
}

/** Comparison pages that arrived; a pending or failed request is not kept. */
const comparisons = new Map<string, ReleaseComparison>();

const cache = new Map<string, Promise<unknown>>();
const CACHE_LIMIT = 400;

/** Drops cached responses for one target (after close) or everything. */
export function evictCache(prefix = ""): void {
  const stale = Array.from(cache.keys()).filter((key) => key.startsWith(prefix));
  for (const key of stale) cache.delete(key);
}

/** GET with an in-memory promise cache; analysis results are immutable per target id. */
export function cached<T>(path: string): Promise<T> {
  let hit = cache.get(path) as Promise<T> | undefined;
  if (!hit) {
    hit = request<T>(path).catch((error: unknown) => {
      cache.delete(path);
      throw error;
    });
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(path, hit);
  }
  return hit;
}

export const api = {
  targets: () => request<{ targets: TargetRecord[] }>("/targets"),
  openPath: (path: string) =>
    request<TargetRecord>("/targets", {
      method: "POST",
      body: JSON.stringify({ path }),
      headers: { "content-type": "application/json" },
    }),
  upload: (file: File) =>
    request<TargetRecord>(`/uploads?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      body: file,
    }),
  close: (id: string) => {
    evictCache(`/targets/${id}`);
    return request<{ closed: boolean }>(`/targets/${id}`, { method: "DELETE" });
  },
  analysis: (id: string) => cached<AnalysisResponse>(`/targets/${id}/analysis`),
  /** Reads more of a partially scanned JavaScript app; everything cached for the target is stale after it. */
  scanMore: async (id: string, mode: "continue" | "all") => {
    const result = await request<AnalysisResponse>(`/targets/${id}/analysis?scan=${mode}`);
    evictCache(`/targets/${id}`);
    return result;
  },
  collection: <T = Record<string, unknown>>(
    id: string,
    name: string,
    q: { offset?: number; limit?: number; text?: string },
  ) => cached<Page<T>>(`/targets/${id}/collections/${encodeURIComponent(name)}?${params(q)}`),
  strings: (
    id: string,
    q: {
      offset?: number;
      limit?: number;
      text?: string;
      tag?: string;
      minLength?: number;
      utf16?: boolean;
    },
  ) =>
    cached<Page<StringItem>>(
      `/targets/${id}/strings?${params({ ...q, utf16: q.utf16 ? 1 : undefined })}`,
    ),
  bytes: (id: string, offset: number, length: number) =>
    cached<ByteWindow>(`/targets/${id}/bytes?offset=${offset}&length=${length}`),
  /**
   * Downloads the full analysis. Fetched with the Authorization header like every other call and
   * saved from a Blob, so the session token never appears in a URL, history or a server log.
   */
  exportJson: (id: string): Promise<void> =>
    download(`/api/targets/${id}/export`, "analysis.hexvero.json"),
  /** Opens the two example builds that ship with hexvero. */
  demo: () => request<{ a: TargetRecord; b: TargetRecord }>("/demo", { method: "POST" }),
  /** One page of the comparison; `signal` cancels the wait (the server finishes its work). */
  compare: async (
    a: string,
    b: string,
    q: { offset?: number; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ReleaseComparison> => {
    const path = `/compare?${params({ a, b, offset: q.offset, limit: q.limit })}`;
    const hit = comparisons.get(path);
    if (hit) return hit;
    const init: RequestInit = q.signal ? { signal: q.signal } : {};
    const result = normalizeComparison(await request<WireComparison>(path, init), q.offset ?? 0);
    if (comparisons.size >= 40) comparisons.delete(comparisons.keys().next().value!);
    comparisons.set(path, result);
    return result;
  },
  /** The comparison as a Markdown report, saved like the JSON export. */
  downloadReport: (a: string, b: string): Promise<void> =>
    download(`/api/compare/report?${params({ a, b })}`, "hexvero-report.md"),
  source: (id: string, file: string, line: number, context = 14) =>
    cached<SourceWindow>(`/targets/${id}/source?${params({ file, line, context })}`),
};

/**
 * Fetches with the Authorization header like every other call and saves the body from a Blob,
 * so the session token never appears in a URL, history or a server log.
 */
async function download(path: string, fallback: string): Promise<void> {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token()}` } });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { error: ApiError }).error.message;
    } catch {
      /* non-JSON error body */
    }
    throw new HttpError(res.status, String(res.status), message);
  }
  const name =
    /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallback;
  const url = URL.createObjectURL(await res.blob());
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // the click has handed the Blob to the browser's download by now
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

function params(q: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q))
    if (v !== undefined && v !== "" && v !== false) p.set(k, String(v));
  return p.toString();
}

export const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};

export const formatCount = (n: number): string => n.toLocaleString("en-US");
