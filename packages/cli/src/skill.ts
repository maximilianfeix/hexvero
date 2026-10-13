import { cpSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paint, toJson, type Io } from "./format.js";

/** The packaged skill directory (skills/hexvero) relative to the built CLI. */
export function skillSource(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "skills", "hexvero"),
    join(here, "..", "..", "..", "skills", "hexvero"),
  ]) {
    if (existsSync(join(candidate, "SKILL.md"))) return candidate;
  }
  return null;
}

interface SkillTarget {
  id: string;
  name: string;
  dir: string;
}

export function skillTargets(home = homedir()): SkillTarget[] {
  const codexHome = process.env["CODEX_HOME"] ?? join(home, ".codex");
  return [
    { id: "claude-code", name: "Claude Code", dir: join(home, ".claude", "skills", "hexvero") },
    { id: "codex", name: "Codex", dir: join(codexHome, "skills", "hexvero") },
    {
      id: "agents",
      name: "Agent Skills (.agents)",
      dir: join(home, ".agents", "skills", "hexvero"),
    },
  ];
}

/** Installs the workflow skill for agents; dry run unless `apply`. Existing copies are moved aside, never overwritten in place. */
export function installSkill(
  io: Io,
  options: { client?: string | undefined; apply: boolean; json: boolean },
): number {
  const source = skillSource();
  if (!source) {
    io.err(`${paint(io, "red", "error:")} the packaged skill was not found next to the CLI`);
    return 1;
  }
  const targets = skillTargets().filter((t) => !options.client || t.id === options.client);
  if (!targets.length) {
    io.err(
      `${paint(io, "red", "usage:")} unknown skill client "${options.client}"; known: ${skillTargets()
        .map((t) => t.id)
        .join(", ")}`,
    );
    return 2;
  }
  const version = /^description:/m.test(readFileSync(join(source, "SKILL.md"), "utf8"))
    ? "ok"
    : "unversioned";
  const results: Array<{ client: string; dir: string; action: string }> = [];
  for (const target of targets) {
    const exists = existsSync(target.dir);
    if (!options.apply) {
      results.push({
        client: target.id,
        dir: target.dir,
        action: exists ? "would replace (backup kept)" : "would install",
      });
      continue;
    }
    mkdirSync(dirname(target.dir), { recursive: true });
    if (exists) renameSync(target.dir, `${target.dir}.hexvero-backup-${Date.now()}`);
    cpSync(source, target.dir, { recursive: true });
    results.push({
      client: target.id,
      dir: target.dir,
      action: exists ? "replaced (backup kept)" : "installed",
    });
  }
  if (options.json) io.out(toJson({ apply: options.apply, source, skill: version, results }));
  else {
    for (const r of results)
      io.out(
        `${paint(io, options.apply ? "green" : "cyan", options.apply ? "✓" : "·")} ${r.client.padEnd(12)} ${r.action}  ${paint(io, "dim", r.dir)}`,
      );
    if (!options.apply)
      io.out(
        paint(
          io,
          "dim",
          "\nDry run. Re-run with --apply to install the skill; existing copies are moved to *.hexvero-backup-<time>.",
        ),
      );
  }
  return 0;
}
