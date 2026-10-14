const BASE = "https://api.notes.example";
const DOCS_URL = "https://docs.notes.example/help";

export async function loadItems() {
  // literal
  const res = await fetch("https://api.notes.example/v1/items");
  return res.json();
}

export async function loadUser(id) {
  // a constant plus a run-time part
  return fetch(`${BASE}/v1/users/${id}`);
}

export async function loadAny(url) {
  // nothing about the URL is known here
  return fetch(url);
}

export function login(axios, body) {
  return axios.post("/v1/login", body);
}

export function connect() {
  return new WebSocket("wss://live.notes.example/socket");
}

export function upload(blob) {
  const xhr = new XMLHttpRequest();
  xhr.open("PUT", "https://upload.notes.example/blob");
  xhr.send(blob);
}

export function viaAlias() {
  // A real request, made through another name for fetch.
  const request = fetch;
  return request("https://alias.notes.example/ping");
}

export function notRequests(router, cache, lookup) {
  // fetch("https://ghost.example/comment");
  const text = "use fetch('https://ghost.example/string') to load";
  // a server-side route table and a cache lookup, not requests
  router.get("/local/route", () => text);
  cache.fetch("items");
  const notFetch = lookup;
  notFetch("https://ghost.example/not-fetch");
  return DOCS_URL;
}

export function preferences() {
  localStorage.setItem("theme", "dark");
  const theme = localStorage.getItem("theme");
  const draft = sessionStorage.getItem("draft");
  localStorage.removeItem("token");
  const db = indexedDB.open("notes-db", 3);
  document.cookie = "seen=1";
  // localStorage.setItem("ghost-comment", "1");
  const custom = { getItem() {} };
  custom.getItem("ghost-custom");
  return { theme, draft, db };
}
