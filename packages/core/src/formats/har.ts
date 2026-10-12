import type { Finding, Limitation } from "../model.js";
import { AnalysisError } from "../model.js";

export interface HarRequest {
  index: number;
  method: string;
  url: string;
  host: string;
  status: number;
  mimeType: string;
  requestBytes: number;
  responseBytes: number;
  timeMs: number;
  startedAt: string;
  hasAuth: boolean;
  hasCookie: boolean;
  setsCookie: boolean;
}

export interface HarInfo {
  creator: string;
  pages: number;
  entries: HarRequest[];
  hosts: Array<{ host: string; count: number; bytes: number }>;
  methods: Record<string, number>;
  statuses: Record<string, number>;
  mimeTypes: Record<string, number>;
  apiEndpoints: Array<{
    method: string;
    path: string;
    host: string;
    count: number;
  }>;
  secretsInUrls: Array<{ index: number; param: string }>;
  websockets: string[];
  findings: Finding[];
  limitations: Limitation[];
}

interface RawHeader {
  name?: string;
  value?: string;
}
interface RawEntry {
  startedDateTime?: string;
  time?: number;
  request?: {
    method?: string;
    url?: string;
    headers?: RawHeader[];
    bodySize?: number;
    headersSize?: number;
  };
  response?: {
    status?: number;
    content?: { mimeType?: string; size?: number };
    headers?: RawHeader[];
    bodySize?: number;
  };
  _webSocketMessages?: unknown[];
}

const SECRET_PARAMS =
  /^(api[_-]?key|token|access[_-]?token|auth|secret|password|pwd|sig|signature|key|session)$/i;

const header = (headers: RawHeader[] | undefined, name: string): string | undefined =>
  headers?.find((h) => h.name?.toLowerCase() === name)?.value;

export function parseHar(bytes: Uint8Array): HarInfo {
  let doc: {
    log?: {
      creator?: { name?: string; version?: string };
      pages?: unknown[];
      entries?: RawEntry[];
    };
  };
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new AnalysisError(
      "malformed",
      `HAR is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const log = doc.log;
  if (!log || !Array.isArray(log.entries))
    throw new AnalysisError("malformed", "HAR has no log.entries");
  const limitations: Limitation[] = [];
  const findings: Finding[] = [];
  const max = 50_000;
  const raw = log.entries.slice(0, max);
  if (log.entries.length > max)
    limitations.push({
      code: "har_truncated",
      message: `Only the first ${max} of ${log.entries.length} entries were read.`,
    });

  const hostStats = new Map<string, { count: number; bytes: number }>();
  const methods: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  const mimeTypes: Record<string, number> = {};
  const endpoints = new Map<
    string,
    { method: string; path: string; host: string; count: number }
  >();
  const secretsInUrls: HarInfo["secretsInUrls"] = [];
  const websockets: string[] = [];

  const entries: HarRequest[] = raw.map((e, index) => {
    const url = e.request?.url ?? "";
    let host = "";
    let path = "";
    try {
      const u = new URL(url);
      host = u.host;
      path = u.pathname;
      for (const key of u.searchParams.keys())
        if (SECRET_PARAMS.test(key)) secretsInUrls.push({ index, param: key });
    } catch {
      host = "(invalid url)";
    }
    const method = e.request?.method ?? "GET";
    const status = e.response?.status ?? 0;
    const mimeType = (e.response?.content?.mimeType ?? "").split(";")[0]!.trim();
    const responseBytes = e.response?.content?.size ?? e.response?.bodySize ?? 0;
    methods[method] = (methods[method] ?? 0) + 1;
    const bucket = status ? `${Math.floor(status / 100)}xx` : "none";
    statuses[bucket] = (statuses[bucket] ?? 0) + 1;
    if (mimeType) mimeTypes[mimeType] = (mimeTypes[mimeType] ?? 0) + 1;
    const hs = hostStats.get(host) ?? { count: 0, bytes: 0 };
    hs.count++;
    hs.bytes += Math.max(0, responseBytes);
    hostStats.set(host, hs);
    if (mimeType.includes("json") || method !== "GET") {
      const normalized = path
        .replace(/\/\d+(?=\/|$)/g, "/{id}")
        .replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, "/{hash}");
      const key = `${method} ${host}${normalized}`;
      const ep = endpoints.get(key) ?? {
        method,
        path: normalized,
        host,
        count: 0,
      };
      ep.count++;
      endpoints.set(key, ep);
    }
    if (url.startsWith("ws") || e["_webSocketMessages"]) websockets.push(url);
    return {
      index,
      method,
      url,
      host,
      status,
      mimeType,
      requestBytes: Math.max(0, e.request?.bodySize ?? 0),
      responseBytes: Math.max(0, responseBytes),
      timeMs: Math.round(e.time ?? 0),
      startedAt: e.startedDateTime ?? "",
      hasAuth: header(e.request?.headers, "authorization") !== undefined,
      hasCookie: header(e.request?.headers, "cookie") !== undefined,
      setsCookie: header(e.response?.headers, "set-cookie") !== undefined,
    };
  });

  const hosts = [...hostStats]
    .map(([host, s]) => ({ host, ...s }))
    .toSorted((a, b) => b.count - a.count);
  const apiEndpoints = [...endpoints.values()].toSorted((a, b) => b.count - a.count);
  const authed = entries.filter((e) => e.hasAuth).length;
  if (authed)
    findings.push({
      kind: "har.auth",
      title: `${authed} requests carry an Authorization header`,
      confidence: "confirmed",
    });
  if (secretsInUrls.length)
    findings.push({
      kind: "har.secret-in-url",
      title: `${secretsInUrls.length} requests pass secret-looking parameters in the URL`,
      detail: [...new Set(secretsInUrls.map((s) => s.param))].join(", "),
      confidence: "inferred",
    });
  if (websockets.length)
    findings.push({
      kind: "har.websocket",
      title: `${websockets.length} WebSocket connections`,
      confidence: "confirmed",
    });
  const insecure = entries.filter((e) => e.url.startsWith("http://")).length;
  if (insecure)
    findings.push({
      kind: "har.plaintext",
      title: `${insecure} plaintext HTTP requests`,
      confidence: "confirmed",
    });
  if (apiEndpoints.length)
    findings.push({
      kind: "har.api",
      title: `${apiEndpoints.length} API-like endpoints`,
      detail: apiEndpoints
        .slice(0, 5)
        .map((e) => `${e.method} ${e.path}`)
        .join(", "),
      confidence: "inferred",
    });

  return {
    creator: `${log.creator?.name ?? "unknown"} ${log.creator?.version ?? ""}`.trim(),
    pages: Array.isArray(log.pages) ? log.pages.length : 0,
    entries,
    hosts,
    methods,
    statuses,
    mimeTypes,
    apiEndpoints,
    secretsInUrls,
    websockets,
    findings,
    limitations,
  };
}
