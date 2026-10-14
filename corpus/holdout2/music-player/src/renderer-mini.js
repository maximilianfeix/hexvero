// Script of the mini player (index.html#mini).
// Built by Vite from src/renderer/mini.ts. MIT licensed, written for this corpus.
import { formatTime, trackLabel } from "./shared/time.js";

const $ = (selector) => document.querySelector(selector);

function isExpanded() {
  return sessionStorage.getItem("mini.expanded") === "1";
}

function setExpanded(expanded) {
  sessionStorage.setItem("mini.expanded", expanded ? "1" : "0");
  document.body.classList.toggle("expanded", expanded);
}

async function render(state) {
  $("#mini-title").textContent = trackLabel(state.track);
  $("#mini-time").textContent = formatTime(state.position);
  $("#mini-toggle").textContent = state.paused ? "Play" : "Pause";
  const artwork = state.track ? await window.mini.getArtwork(state.track.id) : null;
  $("#mini-cover").hidden = !artwork;
  if (artwork) $("#mini-cover").src = artwork;
}

function start() {
  document.body.classList.add("mini");
  setExpanded(isExpanded());
  window.mini.onState((state) => render(state));
  $("#mini-toggle").addEventListener("click", () => window.mini.send("play-pause"));
  $("#mini-next").addEventListener("click", () => window.mini.send("next"));
  $("#mini-cover").addEventListener("click", () => setExpanded(!isExpanded()));
  // Double-click goes back to the big window.
  document.body.addEventListener("dblclick", () => window.mini.send("expand"));
}

if (location.hash === "#mini") window.addEventListener("DOMContentLoaded", start);
