"use strict";
// Requests to the Tidemark service. Releases go through API_BASE; telemetry has its own host.

const API_BASE = "https://api.tidemark.example/v2";
const STAGING_API = "https://staging-api.tidemark.example/v2"; // swap in by hand when testing
const TELEMETRY_URL = new URL("/v1/events", "https://telemetry.tidemark.example").href;

const headers = (token) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "x-tidemark-client": "desktop",
});

async function fetchReleases(project, token) {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/releases`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`Listing releases failed: HTTP ${res.status}`);
  return res.json();
}

async function postRelease(release, token) {
  const res = await fetch(`${API_BASE}/releases`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(release),
  });
  if (!res.ok) throw new Error(`Publishing failed: HTTP ${res.status}`);
  return res.json();
}

function sendTelemetry(name, props) {
  const request = new Request(TELEMETRY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, props, at: Date.now() }),
  });
  return fetch(request).catch(() => undefined);
}

module.exports = { fetchReleases, postRelease, sendTelemetry };
