// Script of the floating timer widget (index.html#widget).
// MIT licensed, written for this corpus.
import { STATUS_URL } from "./config/endpoints.js";
import { formatDuration } from "./lib/format.js";

const { sessionStorage: session } = window;
const counters = { pins: 0, opened: Date.now() };

function restorePosition() {
  const raw = session.getItem("widget.position");
  return raw ? JSON.parse(raw) : null;
}

function rememberPosition(position) {
  window.sessionStorage.setItem("widget.position", JSON.stringify(position));
}

function resetWidget() {
  session.removeItem("widget.position");
  sessionStorage.setItem("widget.collapsed", "0");
}

async function serviceStatus() {
  const response = await fetch(STATUS_URL, { cache: "no-store" });
  const summary = await response.json();
  return summary.status?.description ?? "unknown";
}

function flushCounters() {
  navigator.sendBeacon("https://telemetry.punchclock.example/v1/events", JSON.stringify(counters));
}

async function startWidget() {
  document.getElementById("app").hidden = true;
  document.getElementById("sidebar").hidden = true;
  document.getElementById("widget").hidden = false;
  if (sessionStorage.getItem("widget.collapsed") === "1") document.body.classList.add("collapsed");

  const position = restorePosition();
  if (position) window.moveTo(position.x, position.y);
  window.addEventListener("mouseup", () =>
    rememberPosition({ x: window.screenX, y: window.screenY }),
  );
  window.addEventListener("dblclick", resetWidget);
  window.addEventListener("pagehide", flushCounters);

  // Other widgets of the same origin hear about a pin. This is a BroadcastChannel, not IPC.
  const peers = new BroadcastChannel("ghost:widget-sync");
  document.getElementById("pin").addEventListener("click", () => {
    counters.pins += 1;
    window.widget?.pin(counters.pins % 2 === 1);
    peers.postMessage({ pinned: counters.pins % 2 === 1 });
  });

  // The preload script passes on the port it got from the main process.
  window.addEventListener("message", (event) => {
    if (event.data !== "timer-port") return;
    const [port] = event.ports;
    port.onmessage = ({ data }) => {
      document.getElementById("widget-clock").textContent = formatDuration(data.elapsed ?? 0);
    };
    port.postMessage({ type: "ghost:port-ack" });
  });
  window.widget?.connect((message) => {
    document.getElementById("widget-clock").textContent = formatDuration(message.elapsed ?? 0);
  });
  window.tracker?.onTick((tick) => {
    document.getElementById("widget-clock").textContent = tick.label;
  });

  document.getElementById("status").textContent = await serviceStatus();
}

if (location.hash === "#widget") window.addEventListener("DOMContentLoaded", startWidget);
