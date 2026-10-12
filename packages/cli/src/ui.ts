import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Session } from "@hexvero/core";
import { startServer } from "@hexvero/server";
import { heading, paint, type Io } from "./format.js";

/** The built web UI ships inside the CLI package under ./ui. */
export function uiDirectory(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "ui"),
    join(here, "..", "..", "ui"),
  ]) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

export async function startUi(
  session: Session,
  options: { port: number; open: boolean; host?: string },
  io: Io,
): Promise<number> {
  const staticDir = uiDirectory();
  if (!staticDir)
    io.err(
      `${paint(io, "yellow", "!")} UI assets not found; serving the API only. Build with "npm run build -w @hexvero/web".`,
    );
  const serverOptions: Parameters<typeof startServer>[0] = {
    port: options.port,
    session,
  };
  if (staticDir) serverOptions.staticDir = staticDir;
  if (options.host) serverOptions.host = options.host;
  const running = await startServer(serverOptions);
  const url = `${running.url}/#token=${running.token}`;
  io.out(
    `${heading(io, "hexvero ui")} ${paint(io, "dim", "local only, nothing leaves this machine")}\n\n  ${paint(io, "cyan", url)}\n\n${paint(io, "dim", "The link carries this session's token. Press Ctrl+C to stop.")}`,
  );
  if (options.open) openBrowser(url);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void running.close().then(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}
