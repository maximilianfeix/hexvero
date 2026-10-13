const { app, BrowserWindow, ipcMain } = require("electron");
const electron = require("electron");
const { ipcMain: bus } = require("electron");
const path = require("node:path");
const Store = require("electron-store");
const CH = require("./channels");

const store = new Store();

// A payment SDK option object. It is not a BrowserWindow and must not be read as one.
const paymentOptions = { sandbox: false, environment: "test" };

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile("index.html");
  return win;
}

function createPrintWindow() {
  // The settings object is built first and passed by name.
  const prefs = { nodeIntegration: true, contextIsolation: false, sandbox: false };
  return new BrowserWindow({ show: false, webPreferences: prefs });
}

app.whenReady().then(() => {
  const win = createMainWindow();
  store.set("window.lastOpened", Date.now());
  const bounds = store.get("window.bounds");
  if (bounds) win.setBounds(bounds);

  // 1. plain literal
  ipcMain.handle("doc:open", async (_event, id) => ({ id }));
  // 2. the same channel name a second time, as a one-way listener
  ipcMain.on("doc:open", () => {});
  // 3. through the module object
  electron.ipcMain.on("app:ping", (event) => event.reply("app:pong"));
  // 4. through a renamed destructured binding
  bus.handle("doc:rename", async (_event, id, name) => ({ id, name }));
  // 5. channel name from a constant of another module
  ipcMain.handle(CH.SAVE, async (_event, doc) => doc);
  // 6. main to renderer
  win.webContents.send("doc:changed", { id: 1 });
  // 7. a channel name computed at run time: nothing can be named
  const dynamic = "user:" + process.pid;
  ipcMain.on(dynamic, () => {});

  // Not handlers:
  // ipcMain.handle("ghost:comment", () => {});
  const help = "call ipcMain.handle('ghost:string') to register";
  const fake = { handle() {} };
  fake.handle("ghost:fake", help);

  createPrintWindow();
  console.log(paymentOptions.environment);
});
