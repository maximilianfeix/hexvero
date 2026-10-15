// The importer page from 1.x. Its window has nodeIntegration on and contextIsolation off, so the
// page reaches Node and Electron through window.require; it has no preload and no bridge.
const { ipcRenderer, webUtils } = window.require("electron");
const fs = window.require("fs");

const SAMPLE_URL = "http://templates.lattice.example/samples/trello-export.json";

const status = document.querySelector("#status");
const preview = document.querySelector("#preview");
let rows = [];

/** A Trello export has lists and cards; Lattice wants { list, name } rows. */
function toRows(exported) {
  const lists = new Map((exported.lists ?? []).map((l) => [l.id, l.name]));
  return (exported.cards ?? [])
    .filter((c) => !c.closed)
    .map((c) => ({ list: lists.get(c.idList) ?? "Imported", name: c.name }));
}

function show(found) {
  rows = found;
  preview.replaceChildren(
    ...rows.slice(0, 20).map((r) => {
      const li = document.createElement("li");
      li.textContent = `${r.list} → ${r.name}`;
      return li;
    }),
  );
  status.textContent = `${rows.length} cards found`;
  document.querySelector("#run").disabled = rows.length === 0;
}

document.querySelector("#file").addEventListener("change", (e) => {
  const [file] = e.target.files;
  if (!file) return;
  try {
    const text = fs.readFileSync(webUtils.getPathForFile(file), "utf8");
    show(toRows(JSON.parse(text)));
  } catch (err) {
    status.textContent = `Not a Trello export: ${err.message}`;
  }
});

document.querySelector("#sample").addEventListener("click", async () => {
  const res = await fetch(SAMPLE_URL);
  show(toRows(await res.json()));
});

document.querySelector("#run").addEventListener("click", async () => {
  status.textContent = "Importing…";
  const count = await ipcRenderer.invoke("import:cards", rows);
  status.textContent = `Imported ${count} cards`;
});
