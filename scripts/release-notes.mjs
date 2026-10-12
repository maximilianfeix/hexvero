#!/usr/bin/env node
/** Prints the CHANGELOG.md section for the given tag (falls back to git log since the previous tag). */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tag = process.argv[2] ?? "";
const version = tag.replace(/^v/, "");
let notes = "";
try {
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const match = new RegExp(
    `## \\[?${version.replace(/\./g, "\\.")}\\]?[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`,
  ).exec(changelog);
  if (match) notes = match[1].trim();
} catch {
  /* no changelog */
}
if (!notes) {
  const previous = execSync("git describe --tags --abbrev=0 HEAD^ 2>/dev/null || true")
    .toString()
    .trim();
  const range = previous ? `${previous}..HEAD` : "HEAD";
  notes = execSync(`git log ${range} --pretty=format:'- %s'`).toString().trim();
}
console.log(
  `${notes}\n\nInstall: \`npm install -g hexvero@${version}\` · Run: \`npx hexvero@${version} ui\``,
);
