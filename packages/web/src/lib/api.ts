/** Typed client for the hexvero HTTP API. The session token travels in the URL hash. */

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

const token = (): string => {
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (fromHash) return fromHash;
  try {
    return localStorage.getItem("hexvero.token") ?? "";
  } catch {
    return "";
  }
};
try {
  const t = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (t) localStorage.setItem("hexvero.token", t);
} catch {
  /* storage unavailable */
}

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
    throw new HttpError(res.status, error.code, error.message);
  }
  return (await res.json()) as T;
}

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
  exportJson: async (id: string): Promise<void> => {
    const res = await fetch(`/api/targets/${id}/export`, {
      headers: { authorization: `Bearer ${token()}` },
    });
    if (!res.ok) throw new HttpError(res.status, String(res.status), res.statusText);
    const name =
      /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ??
      "analysis.hexvero.json";
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
  },
};

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
