"use strict";
const { ipcMain, desktopCapturer, screen } = require("electron");
const windows = require("./windows");
const library = require("./library");

/** Lets the user pick a region over the primary display, captures it and opens it for annotation. */
async function start() {
  const display = screen.getPrimaryDisplay();
  const overlay = windows.openOverlay(display);
  overlay.webContents.once("did-finish-load", () => {
    overlay.webContents.send("overlay:frame", {
      width: display.size.width,
      height: display.size.height,
      scale: display.scaleFactor,
    });
  });

  const region = await new Promise((resolve) => {
    ipcMain.once("overlay:select", (_event, rect) => resolve(rect));
    ipcMain.once("overlay:cancel", () => resolve(null));
  });
  // Whichever of the two did not fire is still registered.
  ipcMain.removeAllListeners("overlay:select");
  ipcMain.removeAllListeners("overlay:cancel");
  overlay.close();
  if (!region) return null;

  const [source] = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: display.size });
  const image = source.thumbnail.crop(region);
  const shot = library.addCapture(image.toPNG(), region);
  windows.openAnnotator(shot.id);
  return shot.id;
}

module.exports = { start };
