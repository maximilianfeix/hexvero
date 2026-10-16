// Read-only asar extractor: node asar-extract.mjs <archive> <outdir> <path>...
import fs from "node:fs";
import path from "node:path";
const [archive, out, ...wanted] = process.argv.slice(2);
const fd = fs.openSync(archive, "r");
const b = Buffer.alloc(16);
fs.readSync(fd, b, 0, 16, 0);
const headerSize = b.readUInt32LE(4);
const jsonLen = b.readUInt32LE(12);
const hb = Buffer.alloc(jsonLen);
fs.readSync(fd, hb, 0, jsonLen, 16);
const header = JSON.parse(hb.toString());
const base = 8 + headerSize;
for (const p of wanted) {
  let node = header;
  for (const seg of p.split("/")) node = node.files[seg];
  if (node.unpacked) {
    console.log("unpacked:", p);
    continue;
  }
  const buf = Buffer.alloc(node.size);
  fs.readSync(fd, buf, 0, node.size, base + Number(node.offset));
  const dest = path.join(out, p);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log("wrote", dest, node.size);
}
