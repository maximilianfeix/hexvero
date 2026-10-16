// node ctx.mjs <file> <needle> [width] : print occurrences with context
import fs from "node:fs";
const [f, needle, w = "120"] = process.argv.slice(2);
const s = fs.readFileSync(f, "latin1");
const W = +w;
let i = -1,
  n = 0;
while ((i = s.indexOf(needle, i + 1)) !== -1 && n < 12) {
  n++;
  console.log(
    "@" + i + ": " + s.slice(Math.max(0, i - W), i + needle.length + W).replace(/\n/g, "\\n"),
  );
}
console.log("count", s.split(needle).length - 1);
