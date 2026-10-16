import { randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, extname, join, normalize, sep } from "node:path";
import {
  AnalysisError,
  compact,
  compareReleases,
  detectProviders,
  renderReleaseReport,
  Session,
  targetFromBytes,
} from "@hexvero/core";

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Directory with the built web UI; omitted means API only. */
  staticDir?: string;
  session?: Session;
  /** Pre-shared token; generated when omitted. Sent as `Authorization: Bearer`. */
  token?: string;
  maxUploadBytes?: number;
  /** The two example builds `POST /api/demo` opens; the route answers 404 without them. */
  demoFiles?: [string, string];
}

export interface RunningServer {
  server: Server;
  url: string;
  token: string;
  session: Session;
  close(): Promise<void>;
}

const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const WILDCARD = new Set(["0.0.0.0", "::", "[::]"]);

/** Host header without port and trailing dot, lower-cased; IPv6 keeps its brackets. */
function hostNameOf(header: string | undefined): string {
  const h = (header ?? "").trim().toLowerCase();
  const stripped = h.startsWith("[") ? h.replace(/\]:\d+$/, "]") : h.replace(/:\d+$/, "");
  return stripped.replace(/\.$/, "");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** A file name without directory and extension, safe inside a Content-Disposition header. */
const stem = (path: string): string =>
  basename(path)
    .replace(/[^\w.-]+/g, "_")
    .replace(/\.[^.]*$/, "");

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
};

const fail = (res: ServerResponse, error: unknown): void => {
  if (error instanceof AnalysisError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "too_large"
          ? 413
          : error.code === "cancelled"
            ? 499
            : error.code === "provider_unavailable"
              ? 501
              : 400;
    json(res, status, {
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
    return;
  }
  json(res, 500, {
    error: {
      code: "internal",
      message: error instanceof Error ? error.message : String(error),
    },
  });
};

async function readBody(req: IncomingMessage, max: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max)
      throw new AnalysisError("too_large", `Upload exceeds ${max} bytes`, {
        max,
      });
    chunks.push(buf);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Rows per comparison response at most (contract C3: the server pages at 500). */
const COMPARE_MAX_ROWS = 500;

type ComparisonPage = { offset: number; limit: number; total: number; next: number | null };

/**
 * One page of the comparison (contract C3/C7). `offset` and `limit` go to the core; a core that
 * does not page yet (no `page` in its result) returns every row, and the page is cut here, so the
 * client sees the same shape either way.
 */
async function comparePage(
  session: Session,
  a: string,
  b: string,
  offset: number,
  limit: number,
): Promise<Awaited<ReturnType<typeof compareReleases>> & { page: ComparisonPage }> {
  const options: Parameters<typeof compareReleases>[3] & { offset?: number; limit?: number } = {
    maxRows: COMPARE_MAX_ROWS,
    offset,
    limit,
  };
  const result = (await compareReleases(session, a, b, options)) as Awaited<
    ReturnType<typeof compareReleases>
  > & { page?: ComparisonPage };
  if (result.page) return result as typeof result & { page: ComparisonPage };
  const total = result.changes.length;
  const end = Math.min(total, offset + limit);
  return {
    ...result,
    changes: result.changes.slice(offset, end),
    page: { offset, limit, total, next: end < total ? end : null },
  };
}

/**
 * Starts the loopback server. Every /api route requires the session token;
 * the UI receives it through the page URL hash so it never hits the server log.
 */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const session = options.session ?? new Session({ worker: true });
  const token = options.token ?? randomBytes(18).toString("base64url");
  const host = options.host ?? "127.0.0.1";
  const maxUpload = options.maxUploadBytes ?? 512 * 1024 * 1024;
  // A private per-server directory: a fixed name in the shared tmpdir could be pre-created by another local user.
  let uploadDir: string | null = null;

  const sameToken = (candidate: string | null): boolean => {
    if (candidate === null) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    // Only the header: a token in a URL ends up in history, logs and Referer headers.
    return !!header?.startsWith("Bearer ") && sameToken(header.slice(7));
  };

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    // DNS rebinding: a page on evil.test resolving to 127.0.0.1 sends Host: evil.test and a matching
    // Origin; both must name the bound loopback host, not merely agree with each other.
    const hostName = hostNameOf(req.headers.host);
    const bound = host.toLowerCase();
    const boundOk =
      WILDCARD.has(bound) ||
      hostName === bound ||
      hostName === `[${bound}]` ||
      LOOPBACK.has(hostName);
    if (!boundOk) {
      json(res, 403, {
        error: { code: "forbidden", message: "requests must address the loopback host" },
      });
      return;
    }
    const origin = req.headers.origin;
    const originHost = origin ? (URL.canParse(origin) ? new URL(origin).host : "") : undefined;
    if (originHost !== undefined && originHost !== req.headers.host) {
      json(res, 403, {
        error: {
          code: "forbidden",
          message: "cross-origin requests are not allowed",
        },
      });
      return;
    }
    if (!authorized(req)) {
      json(res, 401, {
        error: {
          code: "unauthorized",
          message: "missing or invalid session token",
        },
      });
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
    const q = url.searchParams;
    const num = (key: string, fallback?: number): number | undefined => {
      if (!q.has(key)) return fallback;
      const value = Number(q.get(key));
      if (!Number.isFinite(value) || value < 0)
        throw new AnalysisError("invalid_input", `${key} must be a non-negative number`);
      return value;
    };
    const whole = (key: string): number | undefined => {
      const value = num(key);
      if (value !== undefined && !Number.isSafeInteger(value))
        throw new AnalysisError("invalid_input", `${key} must be a whole number`);
      return value;
    };
    const paging = (): { offset?: number; limit?: number; text?: string; maxBytes?: number } => {
      const out: { offset?: number; limit?: number; text?: string; maxBytes?: number } = {};
      const maxBytes = num("maxBytes");
      if (maxBytes !== undefined) out.maxBytes = maxBytes;
      const offset = num("offset");
      const limit = num("limit");
      if (offset !== undefined) out.offset = offset;
      if (limit !== undefined) out.limit = limit;
      if (q.get("text")) out.text = q.get("text")!;
      return out;
    };

    if (req.method === "GET" && parts[0] === "health")
      return json(res, 200, { ok: true, version: VERSION });
    if (req.method === "GET" && parts[0] === "targets" && parts.length === 1)
      return json(res, 200, { targets: session.list() });
    if (req.method === "POST" && parts[0] === "targets" && parts.length === 1) {
      let body: { path?: string };
      try {
        body = JSON.parse(new TextDecoder().decode(await readBody(req, 1 << 20))) as {
          path?: string;
        };
      } catch {
        throw new AnalysisError("invalid_input", "request body must be a JSON object with a path");
      }
      if (!body.path) throw new AnalysisError("invalid_input", "body.path is required");
      return json(res, 201, await session.open(body.path));
    }
    if (req.method === "POST" && parts[0] === "demo" && parts.length === 1) {
      if (!options.demoFiles)
        return json(res, 404, {
          error: { code: "not_found", message: "this server was started without the examples" },
        });
      const a = await session.open(options.demoFiles[0]);
      const b = await session.open(options.demoFiles[1]);
      return json(res, 201, { a, b });
    }
    if (req.method === "GET" && parts[0] === "compare") {
      const [a, b] = [q.get("a"), q.get("b")];
      if (!a || !b) throw new AnalysisError("invalid_input", "a and b (target ids) are required");
      if (a === b) throw new AnalysisError("invalid_input", "pick two different targets");
      if (parts[1] === "report" && parts.length === 2) {
        // The report is the whole review: no client paging, the core's own row limit.
        const comparison = await compareReleases(session, a, b, { maxRows: COMPARE_MAX_ROWS });
        res.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${stem(comparison.a.info.path)}-to-${stem(comparison.b.info.path)}.md"`,
        });
        res.end(renderReleaseReport(comparison));
        return;
      }
      if (parts.length === 1) {
        const offset = whole("offset") ?? 0;
        const limit = Math.min(whole("limit") ?? COMPARE_MAX_ROWS, COMPARE_MAX_ROWS);
        if (limit < 1) throw new AnalysisError("invalid_input", "limit must be at least 1");
        return json(res, 200, await comparePage(session, a, b, offset, limit));
      }
    }
    if (req.method === "POST" && parts[0] === "uploads") {
      const name = (q.get("name") ?? "upload.bin").replace(/[^\w.@()-]+/g, "_");
      const bytes = await readBody(req, maxUpload);
      const loaded = targetFromBytes(bytes, name);
      if (loaded.info.format === "sqlite") {
        uploadDir ??= await mkdtemp(join(tmpdir(), "hexvero-uploads-"));
        const path = join(uploadDir, `${loaded.info.sha256.slice(0, 16)}-${name}`);
        await writeFile(path, bytes);
        return json(res, 201, await session.open(path));
      }
      return json(res, 201, session.register({ ...loaded, info: { ...loaded.info, path: name } }));
    }
    if (parts[0] === "targets" && parts[1]) {
      const id = parts[1];
      if (req.method === "DELETE" && parts.length === 2)
        return json(res, 200, { closed: session.close(id) });
      if (req.method !== "GET")
        return json(res, 405, {
          error: { code: "method", message: "method not allowed" },
        });
      const sub = parts[2];
      if (!sub) return json(res, 200, session.get(id));
      if (sub === "analysis") {
        const controller = new AbortController();
        const onClose = (): void => {
          if (!res.writableEnded) controller.abort();
        };
        res.once("close", onClose);
        let analysis;
        // ?scan=continue reads the next batch of a large JavaScript app, ?scan=all the rest.
        const scan = q.get("scan");
        if (scan !== null && scan !== "continue" && scan !== "all")
          return json(res, 400, {
            error: { code: "invalid_input", message: "scan must be continue or all" },
          });
        try {
          analysis = scan
            ? await session.continueAnalysis(
                id,
                scan === "all" ? { all: true } : { continue: true },
                controller.signal,
              )
            : await session.analyze(id, controller.signal);
        } finally {
          res.removeListener("close", onClose);
        }
        const full = q.get("full") === "1";
        return json(res, 200, {
          target: session.get(id),
          summary: analysis.summary,
          durationMs: analysis.durationMs,
          findings: analysis.findings,
          limitations: analysis.limitations,
          ...(analysis.data.kind === "javascript-app"
            ? {
                complete: analysis.data.app.coverage.complete,
                coverage: analysis.data.app.coverage,
              }
            : {}),
          collections: await session.collections(id),
          data: full ? analysis.data : compact(analysis.data, { maxItems: 12 }),
        });
      }
      if (sub === "collections" && parts[3]) {
        const page = await session.collection(id, parts[3], paging());
        const partial = await session.partial(id);
        return json(res, 200, partial ? { ...page, partial } : page);
      }
      if (sub === "strings") {
        const query: Parameters<Session["strings"]>[1] = paging();
        const minLength = num("minLength");
        if (minLength !== undefined) query.minLength = minLength;
        if (q.get("utf16") === "1") query.utf16 = true;
        if (q.get("tag")) query.tag = q.get("tag")!;
        return json(res, 200, session.strings(id, query));
      }
      if (sub === "source") {
        const file = q.get("file");
        const line = num("line");
        if (!file || line === undefined)
          throw new AnalysisError("invalid_input", "file and line are required");
        return json(res, 200, await session.source(id, file, line, num("context")));
      }
      if (sub === "bytes")
        return json(res, 200, session.bytes(id, num("offset") ?? 0, num("length") ?? 4096));
      if (sub === "export") {
        const analysis = await session.analyze(id);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${basename(session.get(id).info.path).replace(/[^\w.-]+/g, "_")}.hexvero.json"`,
        });
        res.end(
          JSON.stringify(
            { hexvero: 1, target: session.get(id), analysis },
            (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
            2,
          ),
        );
        return;
      }
    }
    if (req.method === "GET" && parts[0] === "providers")
      return json(res, 200, { providers: await detectProviders() });
    json(res, 404, {
      error: {
        code: "not_found",
        message: `no route ${req.method} ${url.pathname}`,
      },
    });
  };

  const serveStatic = (res: ServerResponse, pathname: string): void => {
    if (!options.staticDir) {
      json(res, 404, {
        error: {
          code: "not_found",
          message: "UI assets are not bundled in this build",
        },
      });
      return;
    }
    let file = join(options.staticDir, normalize(pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(options.staticDir) || !existsSync(file) || statSync(file).isDirectory())
      file = join(options.staticDir, "index.html");
    const type = MIME[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "cache-control": file.endsWith("index.html")
        ? "no-store"
        : file.includes(`${sep}assets${sep}`)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
    });
    createReadStream(file)
      .on("error", (error) => {
        if (!res.headersSent) fail(res, error);
        else res.destroy();
      })
      .pipe(res);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    if (url.pathname.startsWith("/api/")) {
      api(req, res, url).catch((error) => fail(res, error));
      return;
    }
    serveStatic(res, url.pathname);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 0);
  return {
    server,
    url: `http://${host}:${port}`,
    token,
    session,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (uploadDir) await rm(uploadDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
