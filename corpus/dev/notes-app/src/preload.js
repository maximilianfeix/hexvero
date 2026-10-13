const { contextBridge, ipcRenderer } = require("electron");
const CH = require("./channels");

// An alias of ipcRenderer.
const ipc = ipcRenderer;

contextBridge.exposeInMainWorld("notes", {
  open: (id) => ipcRenderer.invoke("doc:open", id),
  save: (doc) => ipcRenderer.invoke(CH.SAVE, doc),
  rename: (id, name) => ipc.invoke("doc:rename", id, name),
  ping: () => ipcRenderer.send("app:ping"),
  onChanged: (fn) => ipcRenderer.on("doc:changed", (_e, change) => fn(change)),
  // exposed, but talks to no channel
  version: "2.0.0",
});
