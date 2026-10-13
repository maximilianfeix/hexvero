import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { AnalysisError, compact, detectProviders, Session, targetFromBytes } from "@hexvero/core";

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Directory with the built web UI; omitted means API only. */
  staticDir?: string;
  session?: Session;
  /** Pre-shared token; generated when omitted. Sent as `Authorization: Bearer` or `?token=`. */
  token?: string;
  maxUploadBytes?: number;
}

export interface RunningServer {
  server: Server;
  url: string;
  token: string;
  session: Session;
  close(): Promise<void>;
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

/**
 * Starts the loopback server. Every /api route requires the session token;
 * the UI receives it through the page URL hash so it never hits the server log.
 */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const session = options.session ?? new Session({ worker: true });
  const token = options.token ?? randomBytes(18).toString("base64url");
  const host = options.host ?? "127.0.0.1";
  const maxUpload = options.maxUploadBytes ?? 512 * 1024 * 1024;
  const uploadDir = join(tmpdir(), "hexvero-uploads");

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    const header = req.headers.authorization;
    if (header === `Bearer ${token}`) return true;
    return url.searchParams.get("token") === token;
  };

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
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
    if (!authorized(req, url)) {
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
    const paging = (): { offset?: number; limit?: number; text?: string } => {
      const out: { offset?: number; limit?: number; text?: string } = {};
      const offset = num("offset");
      const limit = num("limit");
      if (offset !== undefined) out.offset = offset;
      if (limit !== undefined) out.limit = limit;
      if (q.get("text")) out.text = q.get("text")!;
      return out;
    };

    if (req.method === "GET" && parts[0] === "health")
      return json(res, 200, { ok: true, version: "0.2.1" });
    if (req.method === "GET" && parts[0] === "targets" && parts.length === 1)
      return json(res, 200, { targets: session.list() });
    if (req.method === "POST" && parts[0] === "targets" && parts.length === 1) {
      const body = JSON.parse(new TextDecoder().decode(await readBody(req, 1 << 20))) as {
        path?: string;
      };
      if (!body.path) throw new AnalysisError("invalid_input", "body.path is required");
      return json(res, 201, await session.open(body.path));
    }
    if (req.method === "POST" && parts[0] === "uploads") {
      const name = (q.get("name") ?? "upload.bin").replace(/[^\w.@()-]+/g, "_");
      const bytes = await readBody(req, maxUpload);
      const loaded = targetFromBytes(bytes, name);
      if (loaded.info.format === "sqlite") {
        await mkdir(uploadDir, { recursive: true });
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
        try {
          analysis = await session.analyze(id, controller.signal);
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
          collections: await session.collections(id),
          data: full ? analysis.data : compact(analysis.data, { maxItems: 12 }),
        });
      }
      if (sub === "collections" && parts[3])
        return json(res, 200, await session.collection(id, parts[3], paging()));
      if (sub === "strings") {
        const query: Parameters<Session["strings"]>[1] = paging();
        const minLength = num("minLength");
        if (minLength !== undefined) query.minLength = minLength;
        if (q.get("utf16") === "1") query.utf16 = true;
        if (q.get("tag")) query.tag = q.get("tag")!;
        return json(res, 200, session.strings(id, query));
      }
      if (sub === "bytes")
        return json(
          res,
          200,
          session.bytes(id, Number(q.get("offset") ?? 0), Number(q.get("length") ?? 4096)),
        );
      if (sub === "export") {
        const analysis = await session.analyze(id);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${id}.hexvero.json"`,
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
