"use strict";
const { BrowserWindow } = require("electron");
const { CHANNELS, EXPORT_FORMATS, exportChannel } = require("../shared/channels");
const { settings, drafts } = require("./store");
const { fetchReleases } = require("./remote");
const { publishRelease } = require("./publish");
const { FORMATTERS, toHtml } = require("./format");

/** Registers everything the editor and the preview ask of the main process. */
function registerHandlers(router, windows) {
  router.handle(CHANNELS.RELEASES_LIST, async () => {
    const { project, token } = settings.read();
    const local = Object.values(drafts.all());
    if (!project || !token) return local;
    const remote = await fetchReleases(project, token);
    return [...local, ...remote.filter((r) => !local.some((d) => d.id === r.id))];
  });

  router.handle(CHANNELS.RELEASE_LOAD, async (id) => drafts.get(id));
  router.handle(CHANNELS.RELEASE_SAVE, async (release) => drafts.put(release));
  router.handle(CHANNELS.RELEASE_DELETE, async (id) => {
    drafts.remove(id);
    return true;
  });
  // "release:archive" is reserved for the archive view planned for 2.3; nothing handles it yet.

  router.handle(CHANNELS.SETTINGS_GET, async () => {
    const { token, ...rest } = settings.read();
    return { ...rest, signedIn: Boolean(token) };
  });
  router.handle(CHANNELS.SETTINGS_SET, async (patch) => {
    const { token, ...rest } = settings.write(patch);
    return { ...rest, signedIn: Boolean(token) };
  });

  for (const format of EXPORT_FORMATS) {
    router.handle(exportChannel(format), async (id) => {
      const release = drafts.get(id);
      if (!release) throw new Error(`No draft with id ${id}`);
      return FORMATTERS[format](release);
    });
  }

  router.handle(CHANNELS.PUBLISH_START, async (id) => {
    const release = drafts.get(id);
    if (!release) throw new Error(`Save the draft before publishing`);
    return publishRelease(release, settings.read(), windows.editor().webContents);
  });

  router.on(CHANNELS.EDITOR_DIRTY, (event, dirty) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.setDocumentEdited(dirty);
    win?.setTitle(dirty ? "Tidemark (edited)" : "Tidemark");
  });

  router.on(CHANNELS.PREVIEW_UPDATE, (_event, release) => {
    const preview = windows.preview();
    if (preview) preview.webContents.send(CHANNELS.PREVIEW_RENDER, toHtml(release));
  });

  // Support builds set the variable to collect crash reports on a channel of their choosing.
  const diagChannel = process.env.TIDEMARK_DIAG_CHANNEL;
  if (diagChannel) {
    router.on(diagChannel, (_event, report) => console.log("[diag]", JSON.stringify(report)));
  }
}

module.exports = { registerHandlers };
