/** Tiny argv parser: positionals plus --flag, --key value, --key=value. */
export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !BOOLEAN_FLAGS.has(key)) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
      continue;
    }
    if (arg.startsWith("-") && arg.length === 2) {
      flags[SHORT[arg] ?? arg.slice(1)] = true;
      continue;
    }
    positionals.push(arg);
  }
  const [command, ...rest] = positionals;
  return { command, positionals: rest, flags };
}

const BOOLEAN_FLAGS = new Set([
  "continue",
  "remove",
  "fresh",
  "json",
  "help",
  "version",
  "utf16",
  "open",
  "strict",
  "no-color",
  "apply",
  "all",
  "prune",
  "clear",
]);
const SHORT: Record<string, string> = {
  "-h": "help",
  "-v": "version",
  "-j": "json",
};

export function flagString(flags: ParsedArgs["flags"], key: string): string | undefined {
  const v = flags[key];
  if (v === true) throw new UsageError(`--${key} needs a value`);
  return typeof v === "string" ? v : undefined;
}

export function flagNumber(flags: ParsedArgs["flags"], key: string): number | undefined {
  const v = flagString(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${key} expects a number, got "${v}"`);
  return n;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
