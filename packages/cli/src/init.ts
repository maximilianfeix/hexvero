import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  AnalysisError,
  POLICY_RULES,
  STATUS_TEXT,
  checkRelease,
  hostOf,
  parsePolicy,
  isStdout,
  isStreamName,
  validAllowEntry,
  writeFileNoFollow,
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

/**
 * The external hosts a build sends requests to (its `endpoints`), sorted, split into those a
 * policy can list and those it cannot (`validAllowEntry`: a name a URL may hold that the policy
 * syntax refuses, such as `region-aiplatform-endpoint_id.p.googleapis.com`). Hosts only named in
 * plain URL strings (`urls`) are counted, not allowed: nothing shows they are requested.
 */
async function hostsOf(
  session: Session,
  id: string,
): Promise<{ allow: string[]; rejected: string[]; urlsOnly: number }> {
  const lists = await session.collections(id);
  const read = async (name: string): Promise<Set<string>> => {
    const hosts = new Set<string>();
    if (!(name in lists)) return hosts;
    for (const item of await session.items(id, name)) {
      const v = (item as { value?: unknown } | null)?.value;
      if (typeof v !== "string") continue;
      const reading = hostOf(v);
      if (reading.kind === "host") hosts.add(reading.host);
    }
    return hosts;
  };
  const requested = await read("endpoints");
  const named = await read("urls");
  const all = [...requested].toSorted();
  return {
    allow: all.filter(validAllowEntry),
    rejected: all.filter((h) => !validAllowEntry(h)),
    urlsOnly: [...named].filter((h) => !requested.has(h)).length,
  };
}

/**
 * Writes the policy the way every hexvero output is written (`writeFileNoFollow`): never through
 * a symbolic link in the last component, also a dangling one, and an existing file only with
 * `force`; `-` and /dev/stdout-like names write to the stream. Refusals become usage errors.
 */
async function writePolicyFile(path: string, text: string, force: boolean): Promise<void> {
  try {
    await writeFileNoFollow(path, text, { overwrite: force });
  } catch (error) {
    if (error instanceof AnalysisError && error.details["code"] === "EEXIST")
      throw new UsageError(`${path} exists; pass --force to replace it`);
    if (error instanceof AnalysisError && error.details["code"] === "ELOOP")
      throw new UsageError(`${path} is a symbolic link; hexvero init does not write through one`);
    throw error;
  }
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
  let rejected: string[] = [];
  let urlsOnly = 0;
  let id: string | undefined;
  if (build) {
    const target = await session.open(build);
    const kind = (await session.analyze(target.id)).data.kind;
    if (kind !== "javascript-app" && kind !== "javascript")
      throw new UsageError(
        `init reads hosts from an Electron app, an app directory or a JavaScript bundle; ${build} is ${kind}`,
      );
    id = target.id;
    ({ allow, rejected, urlsOnly } = await hostsOf(session, id));
  }
  const text = `${JSON.stringify(starterPolicy(allow), null, 2)}\n`;
  // what is written must be a policy hexvero reads: checked before anything is written
  const parsed = parsePolicy(text, out);
  if (!isStreamName(out)) await mkdir(dirname(resolve(out)), { recursive: true });
  await writePolicyFile(out, text, Boolean(args.flags["force"]));
  // the policy went to stdout: what init says about it goes to stderr
  if (isStdout(out)) io = { ...io, out: io.err };
  const self = id ? await checkRelease(session, id, id, parsed) : undefined;
  if (args.flags["json"]) {
    io.out(
      toJson({
        policy: out,
        allow,
        rejected,
        urlsOnly,
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
  if (rejected.length)
    io.out(
      `  ${paint(io, "yellow", "!")} not allowed, a policy cannot list them (not a host name in the policy syntax): ${rejected.map(printable).join(", ")}`,
    );
  if (urlsOnly)
    io.out(
      paint(
        io,
        "dim",
        `  ${urlsOnly} host(s) occur only in plain URL strings (collection urls), not in requests; they are not allowed`,
      ),
    );
  if (self) {
    io.out(`  ${printable(build!)} checked against itself: ${STATUS_TEXT[self.status]}`);
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
