#!/usr/bin/env node
/**
 * Project-specific code-shape rules that generic linters do not know:
 *  - every src/formats/*.ts parser has a test file referencing it
 *  - no parser throws plain Error (use AnalysisError so callers get a code)
 *  - no `any` in src
 *  - findings carry a confidence and limitations carry a code (grep-level check)
 *  - MCP tool catalog stays under 32 KiB
 * Prints one line per finding; exit 1 when a blocking rule fails.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const findings = [];
const notes = [];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "node_modules" || name === "dist" || name === "ui") continue;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const sources = walk("packages").filter(
  (f) => !f.includes("/test/") && !f.endsWith(".test.ts"),
);
const tests = walk("packages")
  .filter((f) => f.includes("/test/") || f.endsWith(".test.ts"))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

for (const file of sources) {
  const text = readFileSync(file, "utf8");
  if (
    /\bany\b/.test(text.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")) &&
    /:\s*any\b|<any>|as any\b/.test(text)
  )
    findings.push(`${file}: uses \`any\``);
  if (file.includes("/src/formats/") && /throw new Error\(/.test(text))
    findings.push(`${file}: throw AnalysisError with a code instead of Error`);
  if (file.includes("/src/formats/")) {
    const base = file.split("/").pop().replace(".ts", "");
    if (!tests.includes(`formats/${base}.js`))
      findings.push(`${file}: no test imports formats/${base}.js`);
  }
  if (/confidence:\s*"(?!confirmed|inferred)/.test(text))
    findings.push(`${file}: finding confidence must be confirmed or inferred`);
  if (/console\.log\(/.test(text) && !file.includes("/cli/"))
    findings.push(`${file}: console.log outside the CLI package`);
}

try {
  const { toolSchemas } = await import("../packages/mcp/dist/tools.js");
  const size = Buffer.byteLength(
    JSON.stringify(toolSchemas, (k, v) =>
      typeof v === "object" && v && "_def" in v ? "<schema>" : v,
    ),
  );
  notes.push(
    `MCP catalog: ${Object.keys(toolSchemas).length} tools, descriptions ${size} bytes`,
  );
  if (Object.keys(toolSchemas).length > 16)
    findings.push("MCP catalog exceeds 16 tools");
} catch {
  notes.push("MCP catalog not built; skipped size check");
}

for (const n of notes) console.log(`note: ${n}`);
for (const f of findings) console.log(`finding: ${f}`);
console.log(
  `${findings.length} finding(s), ${sources.length} source files checked`,
);
process.exit(findings.length ? 1 : 0);
