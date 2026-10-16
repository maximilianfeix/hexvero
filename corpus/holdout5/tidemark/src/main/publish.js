"use strict";
const { CHANNELS } = require("../shared/channels");
const { postRelease, sendTelemetry } = require("./remote");

/** Publishes a draft and reports each stage to the editor page that asked for it. */
async function publishRelease(release, { token, telemetry }, contents) {
  const report = (stage, percent) => {
    if (!contents.isDestroyed()) {
      contents.send(CHANNELS.PUBLISH_PROGRESS, { id: release.id, stage, percent });
    }
  };

  report("validating", 5);
  if (!release.version) throw new Error("A release needs a version before it can be published");
  if (!token) throw new Error("Sign in before publishing");

  report("uploading", 40);
  const published = await postRelease(release, token);

  report("done", 100);
  if (telemetry) sendTelemetry("release_published", { entries: release.entries.length });
  return published;
}

module.exports = { publishRelease };
