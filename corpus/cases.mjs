/** Loads every expected*.json of the corpus. Shared by the observers and the scorer. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const corpusRoot = dirname(fileURLToPath(import.meta.url));
export const builtRoot = join(corpusRoot, "built");

const walk = (dir) =>
  readdirSync(dir)
    .toSorted()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });

/** set is "dev", "validation" or "damaged"; cases carry it so results are never mixed up. */
export function loadCases(
  sets = [
    "dev",
    "validation",
    "holdout",
    "holdout2",
    "holdout3",
    "holdout4",
    "holdout5",
    "holdout6",
    "holdout7",
    "damaged",
  ],
) {
  const cases = [];
  for (const set of sets) {
    let files = [];
    try {
      files = walk(join(corpusRoot, set)).filter((f) => /expected[\w-]*\.json$/.test(f));
    } catch {
      continue;
    }
    for (const file of files)
      cases.push(normalize({ set, file, ...JSON.parse(readFileSync(file, "utf8")) }));
  }
  return cases;
}

/**
 * Reads the second spelling of a comparison case (holdout5): `base` and `inputs` instead of `a`
 * and `b`, and `expect.changes` with item objects instead of `expect.compare` with strings. Both
 * are turned into the first spelling, so observers and the scorer see one format. Strings follow
 * the first spelling: a channel, `api.member`, `key: old -> new`, an address (or the known leading
 * part of one), `kind key` for storage. `changes.*.absent` needs no field of its own: the change
 * lists are scored exhaustively, so anything reported beyond the expected changes is false.
 */
function normalize(c) {
  if (c.kind !== "compare") return c;
  const a = c.a ?? c.base;
  const b = c.b ?? (c.inputs?.length === 1 ? c.inputs[0] : undefined);
  if (c.expect.compare || !c.expect.changes) return { ...c, a, b };
  const label = {
    ipcChannels: (x) => x.channel,
    contextBridge: (x) => `${x.api}.${x.member}`,
    webPreferences: (x) => `${x.key}: ${x.from} -> ${x.to}`,
    endpoints: (x) => x.value ?? x.prefix,
    storage: (x) => `${x.kind} ${x.value}`,
  };
  const compare = {};
  for (const [name, want] of Object.entries(c.expect.changes)) {
    const of = label[name] ?? ((x) => (typeof x === "string" ? x : JSON.stringify(x)));
    compare[name] = Object.fromEntries(
      ["added", "removed", "changed"].map((list) => [list, (want[list] ?? []).map(of)]),
    );
  }
  return { ...c, a, b, expect: { ...c.expect, compare } };
}
