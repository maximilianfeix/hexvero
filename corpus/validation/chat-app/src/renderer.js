// Renderer of the main window.
// MIT licensed, written for this corpus.
import { API_ROOT, GATEWAY_URL, HELP_URL, avatarCache, jsonHeaders } from "./net.js";

const $ = (id) => document.getElementById(id);
const ls = window.localStorage;

// ---------------------------------------------------------------------------------------------
// Requests.

async function loadRooms() {
  // literal
  const res = await fetch("https://api.chat.example/v2/rooms");
  return res.json();
}

async function loadMessages(roomId) {
  // template: a constant from net.js, a fixed part, then run-time parts
  const res = await fetch(`${API_ROOT}/rooms/${roomId}/messages?limit=50`);
  return res.json();
}

function avatarOf(userId) {
  // concatenation
  return fetch(API_ROOT + "/users/" + encodeURIComponent(userId) + "/avatar");
}

function postMessage(room, text) {
  // literal with a stated method
  return fetch("https://api.chat.example/v2/messages", {
    method: "POST",
    headers: jsonHeaders(ls.getItem("auth.token")),
    body: JSON.stringify({ room, text }),
  });
}

function download(attachment) {
  // nothing about the address is known here
  return fetch(attachment.href);
}

function serviceStatus() {
  // fetch under another name
  const { fetch: httpGet } = globalThis;
  return httpGet("https://status.chat.example/health.json");
}

function openGateway() {
  // the address is a constant from net.js
  const socket = new WebSocket(GATEWAY_URL, ["chat.v3"]);
  // WebSocket.send is not ipcRenderer.send
  socket.addEventListener("open", () => socket.send("ghost:socket-frame"));
  return socket;
}

function watchPresence(onChange) {
  const source = new EventSource("https://events.chat.example/presence/stream", {
    withCredentials: true,
  });
  source.onmessage = (event) => onChange(JSON.parse(event.data));
  return source;
}

function reportUsage(counters) {
  navigator.sendBeacon("https://metrics.chat.example/collect", JSON.stringify(counters));
}

function notRequests() {
  // fetch("https://ghost.chat.example/in-a-comment");
  const hint = 'Try new WebSocket("wss://ghost.chat.example/in-a-string") in the console.';
  // a Map lookup and a Map write behind the method names fetch and open
  avatarCache.open("GET", "https://ghost.chat.example/cache-open");
  const cached = avatarCache.fetch("https://ghost.chat.example/cache-key");
  // an address that is taken apart, never requested
  const host = new URL("https://ghost.chat.example/parsed-only").hostname;
  // the address bar changes, nothing is loaded
  history.replaceState(null, "", "/ghost/history-entry");
  // shown as text
  $("help").textContent = `Questions? See ${HELP_URL} (${host})`;
  return hint.length + (cached ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------
// Storage.

function rememberRoom(roomId) {
  localStorage.setItem("chat.lastRoom", roomId);
}

function lastRoom() {
  return localStorage.getItem("chat.lastRoom") ?? "general";
}

function forgetLogin() {
  // localStorage under another name
  ls.removeItem("auth.token");
}

function density() {
  return window.localStorage.getItem("ui.density") || "cozy";
}

const unsent = {
  load: () => sessionStorage.getItem("composer.unsent") ?? "",
  save: (text) => sessionStorage.setItem("composer.unsent", text),
  clear: () => sessionStorage.removeItem("composer.unsent"),
};

function openCache() {
  // the cache of an older version is thrown away, the current one is opened
  indexedDB.deleteDatabase("chat-cache-v1");
  return indexedDB.open("chat-cache", 2);
}

function consent() {
  if (!document.cookie.includes("consent=")) document.cookie = "consent=1; max-age=31536000";
  return document.cookie.split("; ").length;
}

function notStorage() {
  // localStorage.setItem("ghost.commented-out", "1");
  const note = "sessionStorage.getItem('ghost.in-a-string') returns the draft";
  // a query string and an object of our own with the method names of a storage
  const wanted = new URLSearchParams(location.search).get("ghost-query-param");
  const memory = {
    items: {},
    getItem(key) {
      return this.items[key];
    },
    setItem(key, value) {
      this.items[key] = value;
    },
    removeItem(key) {
      delete this.items[key];
    },
  };
  memory.setItem("ghost.own-object", note);
  memory.getItem("ghost.own-object");
  memory.removeItem("ghost.own-object");
  return wanted;
}

// ---------------------------------------------------------------------------------------------
// Wiring.

async function start() {
  document.body.dataset.density = density();
  const session = await window.session.bootstrap();
  const room = notStorage() ?? lastRoom();
  const [roomList, messages] = await Promise.all([loadRooms(), loadMessages(room)]);
  $("rooms").textContent = roomList.length + " rooms";
  $("messages").textContent = messages.length + " messages";
  $("draft").value = unsent.load();
  $("draft").addEventListener("input", (event) => {
    unsent.save(event.target.value);
    window.chat.typing(room);
  });
  $("composer").addEventListener("submit", async (event) => {
    event.preventDefault();
    await postMessage(room, $("draft").value);
    await window.chat.sendMessage(room, $("draft").value);
    unsent.clear();
    rememberRoom(room);
  });
  $("messages").addEventListener("click", (event) => {
    if (event.target.dataset.href) download(event.target.dataset);
    if (event.target.dataset.user) avatarOf(event.target.dataset.user);
  });
  window.session.onPresence((presence) => {
    if (presence.signedOut) forgetLogin();
  });
  const gateway = openGateway();
  const presence = watchPresence(() => {});
  const cache = openCache();
  const up = await serviceStatus();
  reportUsage({ user: session.user, cookies: consent(), up: up.ok, notes: notRequests() });
  return { gateway, presence, cache };
}

window.addEventListener("DOMContentLoaded", start);
