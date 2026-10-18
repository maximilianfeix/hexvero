// The diagnostics console runs with nodeIntegration and without context isolation (a 1.x
// leftover, see main/windows.js), so it reaches ipcRenderer through window.require.
const { ipcRenderer } = window.require("electron");

// What a hardened window would have; shown next to the real values as a reminder.
const RECOMMENDED = { contextIsolation: true, nodeIntegration: false, sandbox: true };

async function refresh() {
  const snapshot = await ipcRenderer.invoke("diag:snapshot");
  document.querySelector("#snapshot").textContent = JSON.stringify(snapshot, null, 2);
  document.querySelector("#recommended").textContent = JSON.stringify(RECOMMENDED);
}

window.addEventListener("DOMContentLoaded", () => {
  document.querySelector("#refresh").addEventListener("click", refresh);
  void refresh();
});
