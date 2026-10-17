// node bridge-links.mjs <packages/core dir> <bridge api> <archive>... : how many members of one
// contextBridge API are linked to a main-process end, with the build of @hexvero/core in that
// directory (`npm run build` first). It only reads the archives through hexvero; nothing in them
// is run. One JSON line per archive.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

process.env.HEXVERO_CACHE_DIR = mkdtempSync(join(tmpdir(), "hexvero-bridge-links-"));
const [coreDir, api, ...archives] = process.argv.slice(2);
if (!coreDir || !api || !archives.length) {
  console.error("usage: node bridge-links.mjs <packages/core dir> <bridge api> <archive>...");
  process.exit(2);
}
const core = await import(pathToFileURL(join(resolve(coreDir), "dist", "index.js")).href);
for (const path of archives) {
  const session = new core.Session();
  const target = await session.open(path);
  const started = performance.now();
  await session.analyze(target.id);
  const ms = Math.round(performance.now() - started);
  const page = async (name) =>
    (await session.collection(target.id, name, { limit: 5000, maxBytes: 64 << 20 })).items;
  const rows = (await page("interfaces")).filter((r) => r.api === api);
  const named = rows.filter((r) => r.channel);
  const toMain = named.filter((r) => r.ends.some((e) => e.api.startsWith("ipcMain.")));
  const links = {};
  for (const r of rows) links[r.link] = (links[r.link] ?? 0) + 1;
  const ends = {};
  for (const r of toMain)
    for (const e of r.ends) {
      const key = `${e.api}${e.via ? ` via ${e.via}` : ""}${e.wrapper ? ` ${e.wrapper}` : ""}`;
      ends[key] = (ends[key] ?? 0) + 1;
    }
  const ipc = await page("ipc");
  console.log(
    JSON.stringify({
      archive: path.split("/").pop(),
      analyzeMs: ms,
      members: rows.length,
      withChannel: named.length,
      linkedToMain: toMain.length,
      links,
      ends,
      ipcChannels: (await page("ipcChannels")).length,
      ipcRows: ipc.length,
      withoutChannel: ipc.filter((u) => u.channel === null && !u.api.startsWith("contextBridge."))
        .length,
    }),
  );
}
