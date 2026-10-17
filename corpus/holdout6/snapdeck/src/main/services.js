"use strict";
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const prefs = require("./prefs");

const SHARE_API = "https://share.snapdeck.example/api/v3";

/** The hosted share service. Emits upload:progress while an upload runs (for the log only). */
class ShareClient extends EventEmitter {
  constructor(base = SHARE_API) {
    super();
    this.base = base;
  }

  async upload(shot) {
    this.emit("upload:progress", { id: shot.id, stage: "reading" });
    const body = fs.readFileSync(shot.file);
    const response = await fetch(`${this.base}/shots`, {
      method: "POST",
      headers: { "content-type": "image/png", "x-snapdeck-title": encodeURIComponent(shot.title || "") },
      body,
    });
    if (!response.ok) throw new Error(`upload failed: ${response.status}`);
    this.emit("upload:progress", { id: shot.id, stage: "done" });
    return response.json();
  }

  async revoke(shareId) {
    await fetch(`${this.base}/shots/${encodeURIComponent(shareId)}`, { method: "DELETE" });
  }
}

/** Tells the user's own integration about a new share. The address is typed into Preferences. */
async function notifyWebhook(url, payload) {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function shareShot(id) {
  // Required here, not at the top: library.js requires this module for ShareClient.
  const library = require("./library");
  const shot = library.get(id);
  if (!shot) throw new Error(`no capture ${id}`);
  const client = new ShareClient();
  client.on("upload:progress", (progress) => console.log("share", shot.id, progress.stage));
  const { shareId, slug } = await client.upload(shot);
  library.save({ ...shot, shareId, slug });
  const { webhookUrl } = prefs.read();
  if (webhookUrl) await notifyWebhook(webhookUrl, { slug, title: shot.title });
  return { slug };
}

module.exports = { ShareClient, shareShot, SHARE_API };
