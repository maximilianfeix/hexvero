import { Keys, prefs } from "./settings-store.js";

const api = window.padwright;
// Other Padwright windows in this profile re-render when a layer is edited here.
const sync = new BroadcastChannel("keymap:sync");

export const state = { deviceId: null, layers: [[], [], []], layer: 0 };

export async function selectDevice(deviceId) {
  state.deviceId = deviceId;
  prefs.set(Keys.LAST_DEVICE, deviceId);
  const keymap = await api.readKeymap(deviceId);
  state.layers = keymap.layers;
  render();
}

export function lastDevice() {
  return prefs.get(Keys.LAST_DEVICE);
}

export async function save() {
  if (!state.deviceId) return;
  const result = await api.writeKeymap(state.deviceId, state.layers);
  api.track("keymap.saved", { layers: result.written });
  sync.postMessage({ deviceId: state.deviceId });
}

function onDragStart(event) {
  event.dataTransfer.setData("application/x-padwright-key", event.target.dataset.code);
}

function onDrop(event) {
  const code = event.dataTransfer.getData("application/x-padwright-key");
  const slot = Number(event.currentTarget.dataset.slot);
  state.layers[state.layer][slot] = code;
  render();
}

export function render() {
  const grid = document.querySelector("#keys");
  grid.replaceChildren(
    ...Array.from({ length: 12 }, (_, slot) => {
      const cell = document.createElement("button");
      cell.className = "key";
      cell.dataset.slot = String(slot);
      cell.dataset.code = state.layers[state.layer][slot] ?? "";
      cell.textContent = cell.dataset.code || "·";
      cell.draggable = true;
      cell.addEventListener("dragstart", onDragStart);
      cell.addEventListener("dragover", (event) => event.preventDefault());
      cell.addEventListener("drop", onDrop);
      return cell;
    }),
  );
}

sync.addEventListener("message", async ({ data }) => {
  if (data.deviceId === state.deviceId) await selectDevice(state.deviceId);
});
