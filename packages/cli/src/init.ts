import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  POLICY_RULES,
  STATUS_TEXT,
  checkRelease,
  hostOf,
  parsePolicy,
  type Session,
} from "@hexvero/core";
import { flagString, UsageError, type ParsedArgs } from "./args.js";
import { paint, printable, suggest, toJson, type Io } from "./format.js";

/** Where `init` writes and `check` is pointed at in the README. */
export const DEFAULT_POLICY_PATH = ".hexvero/policy.json";

const SCHEMA =
  "https://raw.githubusercontent.com/maximilianfeix/hexvero/main/docs/policy.schema.json";

/** A policy of the shape of `examples/policy.json`: every rule at fail, `unknown: fail`. */
export function starterPolicy(allow: readonly string[]): Record<string, unknown> {
  const rules: Record<string, unknown> = {};
  for (const rule of POLICY_RULES)
    rules[rule] = rule === "new-external-host" ? { level: "fail", allow } : { level: "fail" };
  return {
    $schema: SCHEMA,
    hexvero: "policy",
    version: 1,
    rules,
    unknown: "fail",
    suppressions: [],
  };
}

/** Every external host the request targets of a build name, sorted. */
async function hostsOf(session: Session, id: string): Promise<string[]> {
  const lists = await session.collections(id);
  const hosts = new Set<string>();
  for (const name of ["endpoints", "urls"]) {
    if (!(name in lists)) continue;
    for (const item of await session.items(id, name)) {
      const v =
        (item as { value?: unknown; url?: unknown } | null)?.value ??
        (item as { url?: unknown } | null)?.url;
      if (typeof v !== "string") continue;
      const reading = hostOf(v);
      if (reading.kind === "host") hosts.add(reading.host);
    }
  }
  return [...hosts].toSorted();
}

/**
 * `hexvero init [build] [--out file] [--force]`: writes a starting policy (default
 * `.hexvero/policy.json`), never over an existing file without `--force`. With a build, its
 * external hosts are allowed, and the policy is checked against the build itself so the output
 * says whether a first check of an unchanged build passes.
 */
export async function runInit(args: ParsedArgs, io: Io, session: Session): Promise<number> {
  const [build, extra] = args.positionals;
  if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}"`);
  const out = flagString(args.flags, "out") ?? DEFAULT_POLICY_PATH;
  let allow: string[] = [];
  let id: string | undefined;
  if (build) {
    const target = await session.open(build);
    const kind = (await session.analyze(target.id)).data.kind;
    if (kind !== "javascript-app" && kind !== "javascript")
      throw new UsageError(
        `init reads hosts from an Electron app, an app directory or a JavaScript bundle; ${build} is ${kind}`,
      );
    id = target.id;
    allow = await hostsOf(session, id);
  }
  const text = `${JSON.stringify(starterPolicy(allow), null, 2)}\n`;
  await mkdir(dirname(resolve(out)), { recursive: true });
  try {
    await writeFile(out, text, { flag: args.flags["force"] ? "w" : "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new UsageError(`${out} exists; pass --force to replace it`);
    throw error;
  }
  const self = id ? await checkRelease(session, id, id, parsePolicy(text, out)) : undefined;
  if (args.flags["json"]) {
    io.out(
      toJson({
        policy: out,
        allow,
        ...(self ? { selfCheck: { status: self.status, incomplete: self.incomplete } } : {}),
      }),
    );
    return 0;
  }
  io.out(
    `${paint(io, "green", "✓")} wrote ${printable(out)}: every rule at fail, unknown: fail${
      build ? `, ${allow.length} host(s) of ${printable(build)} allowed` : ", no host allowed yet"
    }`,
  );
  for (const host of allow.slice(0, 20)) io.out(`    ${printable(host)}`);
  if (allow.length > 20) io.out(paint(io, "dim", `    … ${allow.length - 20} more in the file`));
  if (self) {
    io.out(`  ${build} checked against itself: ${STATUS_TEXT[self.status]}`);
    if (self.status === "incomplete")
      io.out(
        paint(
          io,
          "dim",
          `  ${self.incomplete.map((i) => `${i.rule} on ${i.collection}: ${i.gaps.join(", ")}`).join("; ")}. The build itself leaves these rules open, so every check of it exits 4 under "unknown": "fail"; set "unknown": "warn" in ${printable(out)} to accept that.`,
        ),
      );
  }
  io.out(paint(io, "dim", `  next: ${suggest(io, `check <before> <after> --policy ${out}`)}`));
  return 0;
}
