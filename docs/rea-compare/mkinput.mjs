// Glue for REA's CLI workflows, which take one JSON input file (docs/cli.md uses jq for the same step).
// usage: node mkinput.mjs view <evidence.json> <out.json> '<view-json>'
//        node mkinput.mjs compare <left-evidence.json> <right-evidence.json> <out.json>
import fs from "node:fs";
const [mode, ...a] = process.argv.slice(2);
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
if (mode === "view")
  fs.writeFileSync(
    a[1],
    JSON.stringify({ source: { kind: "inline", evidence: read(a[0]) }, view: JSON.parse(a[2]) }),
  );
else if (mode === "compare")
  fs.writeFileSync(a[2], JSON.stringify({ left: read(a[0]), right: read(a[1]) }));
else process.exit(2);
