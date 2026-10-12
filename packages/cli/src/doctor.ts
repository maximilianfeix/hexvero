import { paint, toJson, type Io } from "./format.js";

export async function doctor(io: Io, json: boolean): Promise<number> {
  const [major, minor] = process.versions.node.split(".").map(Number) as [
    number,
    number,
  ];
  const nodeOk = major > 22 || (major === 22 && minor >= 12);
  let sqlite = false;
  try {
    await import("node:sqlite");
    sqlite = true;
  } catch {
    sqlite = false;
  }
  const { detectProviders } = await import("@hexvero/core");
  const providers = await detectProviders();
  const report = {
    node: { version: process.versions.node, ok: nodeOk },
    sqlite: { available: sqlite },
    providers,
    platform: `${process.platform}-${process.arch}`,
  };
  if (json) {
    io.out(toJson(report));
    return nodeOk ? 0 : 1;
  }
  const mark = (ok: boolean): string =>
    ok ? paint(io, "green", "✓") : paint(io, "red", "✗");
  io.out(
    `${mark(nodeOk)} Node.js ${process.versions.node} ${
      nodeOk ? "" : "(need >= 22.12)"
    }`,
  );
  io.out(
    `${mark(sqlite)} node:sqlite ${
      sqlite ? "available" : "missing — SQLite inspection disabled"
    }`,
  );
  for (const p of providers)
    io.out(
      `${mark(p.available)} ${p.name} ${
        p.available
          ? paint(io, "dim", `${p.path ?? ""} ${p.version ?? ""}`)
          : paint(io, "dim", "not installed (optional)")
      }`,
    );
  io.out(
    paint(
      io,
      "dim",
      `\nBuilt-in analyzers need nothing else. Engines add disassembly and decompilation.`,
    ),
  );
  return nodeOk ? 0 : 1;
}
