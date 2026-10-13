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
export function loadCases(sets = ["dev", "validation", "holdout", "damaged"]) {
  const cases = [];
  for (const set of sets) {
    let files = [];
    try {
      files = walk(join(corpusRoot, set)).filter((f) => /expected[\w-]*\.json$/.test(f));
    } catch {
      continue;
    }
    for (const file of files) cases.push({ set, file, ...JSON.parse(readFileSync(file, "utf8")) });
  }
  return cases;
}
