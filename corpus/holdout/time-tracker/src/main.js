// Main process of Punchclock, a desktop time tracker.
// MIT licensed, written for this corpus.
import path from "node:path";
import https from "node:https";
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  MessageChannelMain,
  nativeTheme,
  powerMonitor,
  shell,
} from "electron";
// Request/response handlers are registered through `rpc`, one-way listeners through `ipcMain`.
import { ipcMain as rpc, net as electronNet } from "electron";
import Store from "electron-store";
import windowConfig from "./config/windows.js";
import { links } from "./config/endpoints.js";
import { Channel, ConfigSync, Push, TIMER_PREFIX } from "./ipc/index.js";
import { formatDuration } from "./lib/format.js";

const PRELOAD = path.join(__dirname, "preload.js");
const isDev = process.env.NODE_ENV === "development";

const log = {
  info: (...args) => console.log("[main]", ...args),
  warn: (...args) => console.warn("[main]", ...args),
};

// ---------------------------------------------------------------------------------------------
// Persistent settings.

const settings = new Store({ name: "punchclock", defaults: { "sync.interval": 15 } });
const LAST_SYNC = "sync.lastRun";

/** The licence key lives in a file of its own. */
class LicenseVault {
  #store = new Store({ name: "license", clearInvalidConfig: true });

  get key() {
    return this.#store.get("license.key");
  }

  save(key) {
    this.#store.set("license.key", key);
  }
}

const vault = new LicenseVault();

// Transactional mail provider. "sandbox" means mails are accepted but not delivered, and
// "preload" names the template set to warm up. Neither has anything to do with a window.
const mailer = { sandbox: true, preload: "templates", from: "billing@punchclock.example" };

// ---------------------------------------------------------------------------------------------
// Windows.

class MainWindow {
  options = {
    ...windowConfig.main,
    webPreferences: Object.assign(
      { preload: PRELOAD, spellcheck: false },
      windowConfig.secureDefaults,
    ),
  };

  window = null;

  open() {
    this.window = new BrowserWindow(this.options);
    const saved = settings.get("window.main");
    if (saved) this.window.setBounds(saved);
    this.window.on("close", () => settings.set("window.main", this.window.getBounds()));
    this.window.once("ready-to-show", () => log.info("main window ready"));
    // Links leave the application: the system browser opens them, the window does not.
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });
    this.window.loadFile("index.html");
    return this.window;
  }
}

/** Preferences of the floating widget; a caller names only what differs. */
function widgetPreferences({ sandbox = true, nodeIntegration = false, preload } = {}) {
  return { contextIsolation: true, sandbox, nodeIntegration, preload, backgroundThrottling: false };
}

let widget = null;

function openWidget() {
  const win = new BrowserWindow({
    ...windowConfig.widget,
    // The widget's preload keeps a Node timer alive, which a sandboxed preload cannot.
    webPreferences: widgetPreferences({ preload: PRELOAD, sandbox: false }),
  });
  win.on("moved", () => settings.set("window.widget", win.getBounds()));
  win.webContents.once("did-finish-load", () => {
    // A private line between the widget page and the main process.
    const { port1, port2 } = new MessageChannelMain();
    port2.on("message", ({ data }) => log.info("widget:", data));
    port2.start();
    win.webContents.postMessage("timer:port", null, [port1]);
  });
  win.loadFile("index.html", { hash: "widget" });
  return win;
}

function openInvoiceWindow(parent, invoiceId) {
  const webPreferences = {
    preload: PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
    // The template inspector used during development needs an unsandboxed page.
    sandbox: isDev ? false : true,
  };
  const child = new BrowserWindow({ ...windowConfig.invoice, parent, webPreferences });
  child.loadFile("index.html", { hash: `invoice/${invoiceId}` });
  return child;
}

/** What a window really runs with, for the diagnostics dump. */
function describeWindow(win) {
  const prefs = win.webContents.getLastWebPreferences();
  return {
    id: win.id,
    sandbox: prefs.sandbox,
    contextIsolation: prefs.contextIsolation,
    nodeIntegration: prefs.nodeIntegration,
  };
}

const mainWindow = new MainWindow();

// ---------------------------------------------------------------------------------------------
// The timer.

class TimerService {
  #startedAt = 0;
  #interval = null;
  target = null;

  constructor() {
    ipcMain.handle(Channel.TimerStart, (_event, projectId) => this.start(projectId));
  }

  register() {
    ipcMain.handle(Channel.TimerStop, () => this.stop());
    return this;
  }

  start(projectId) {
    this.stop();
    this.#startedAt = Date.now();
    this.#interval = setInterval(() => {
      const elapsed = Date.now() - this.#startedAt;
      this.target?.webContents.send(TIMER_PREFIX + "tick", {
        projectId,
        elapsed,
        label: formatDuration(elapsed),
      });
    }, 1000);
    return { projectId, startedAt: this.#startedAt };
  }

  stop() {
    if (this.#interval === null) return 0;
    clearInterval(this.#interval);
    this.#interval = null;
    return Date.now() - this.#startedAt;
  }
}

// ---------------------------------------------------------------------------------------------
// Projects and invoices.

const projects = new Map([[1, { id: 1, name: "Internal" }]]);
const grants = new Set(["scope:billing"]);

const projectRoutes = [
  { channel: "projects:list", run: () => [...projects.values()] },
  {
    channel: "projects:create",
    run: (_event, name) => {
      const project = { id: projects.size + 1, name };
      projects.set(project.id, project);
      return project;
    },
  },
  {
    channel: "projects:rename",
    run: (_event, id, name) => Object.assign(projects.get(id) ?? {}, { name }),
  },
];

const widgetListeners = new Map([
  [
    "widget:pin",
    (event, pinned) => BrowserWindow.fromWebContents(event.sender)?.setAlwaysOnTop(Boolean(pinned)),
  ],
  [
    "widget:close",
    (event) => {
      settings.delete("window.widget");
      BrowserWindow.fromWebContents(event.sender)?.close();
    },
  ],
]);

/** Registers a handler that answers only when the licence grants `scope`. */
function secured(scope, channel, handler) {
  rpc.handle(channel, async (event, ...args) => {
    if (!grants.has(scope)) throw new Error(`missing grant ${scope}`);
    return handler(event, ...args);
  });
}

/** Tells the billing service that an invoice left the building. */
function notifyBilling(invoiceId) {
  const request = https.request(
    "https://hooks.punchclock.example/invoice-exported",
    { method: "POST", headers: { "content-type": "application/json" } },
    (response) => response.resume(),
  );
  request.on("error", (error) => log.warn("billing hook failed:", error.message));
  request.end(JSON.stringify({ invoiceId, from: mailer.from, dryRun: mailer.sandbox }));
}

async function checkForUpdate() {
  const lastRun = settings.get(LAST_SYNC);
  const response = await electronNet.fetch(`${links.updates}/feed/stable.json`);
  if (!response.ok) return;
  const { version } = await response.json();
  log.info("release notes:", "https://punchclock.example/releases/latest");
  if (version !== app.getVersion())
    BrowserWindow.getAllWindows().forEach((win) =>
      win.webContents.send(Push.UpdateReady, { version, lastRun }),
    );
}

// ---------------------------------------------------------------------------------------------
// IPC.

function registerIpc(timer) {
  // from a list of routes
  projectRoutes.forEach(({ channel, run }) => rpc.handle(channel, run));
  // from a Map; forEach passes the value first and the key second
  widgetListeners.forEach((listener, channel) => ipcMain.on(channel, listener));

  secured("scope:billing", "invoice:create", (_event, draft) => {
    const invoice = { id: Date.now(), ...draft };
    openInvoiceWindow(mainWindow.window, invoice.id);
    return invoice;
  });

  ipcMain.on(Channel.InvoiceExport, ({ sender }, invoiceId) => {
    const file = path.join(app.getPath("documents"), `invoice-${invoiceId}.pdf`);
    notifyBilling(invoiceId);
    sender.send("invoice:exported", { invoiceId, file });
  });

  ipcMain.on("sync:start", (event) => {
    let cancelled = false;
    rpc.handle("sync:cancel", () => (cancelled = true));
    event.reply(Channel.SyncProgress, { done: 0 });
    checkForUpdate().catch((error) => log.warn("update check failed:", error.message));
    setTimeout(
      () => {
        rpc.removeHandler("sync:cancel");
        if (cancelled) return;
        settings.set(LAST_SYNC, Date.now());
        event.reply(Channel.SyncProgress, { done: 100 });
      },
      settings.get("sync.interval", 15) * 100,
    );
  });

  // The one synchronous question a page may ask.
  ipcMain.on(ConfigSync, (event, name) => {
    event.returnValue = name === "locale" ? settings.get("ui.locale") : settings.get("ui.currency");
  });

  ipcMain.once("app:first-paint", () => mainWindow.window?.show());

  rpc.handleOnce("license:activate", async (_event, key) => {
    if (vault.key) return { ok: true, already: true };
    if (!key) {
      shell.openExternal(links.pricing);
      return { ok: false };
    }
    vault.save(key);
    return { ok: true };
  });

  ipcMain.on("widget:port", (event) => {
    const [port] = event.ports;
    port.on("message", ({ data }) => log.info("widget asks:", data));
    port.postMessage({ type: "ghost:port-ready", elapsed: timer.stop() });
    port.start();
  });

  ipcMain.on("debug:dump-state", () => log.info(BrowserWindow.getAllWindows().map(describeWindow)));

  if (process.platform === "darwin")
    ipcMain.on("dock:badge", (_event, count) => app.dock?.setBadge(count ? String(count) : ""));

  // Version 3 plug-ins registered this themselves; make sure none survives a hot reload.
  rpc.removeHandler("legacy:export");

  // One listener per project: these names exist only at run time.
  for (const id of projects.keys()) ipcMain.on(`project:${id}:touch`, () => {});
}

// ---------------------------------------------------------------------------------------------
// Things with the method names of IPC that are something else.

function wireSystemEvents(timer) {
  // ipcMain.handle("ghost:disabled-handler", () => null);
  log.warn("plug-ins must not call ipcMain.handle('ghost:documented') any more");

  // The print spooler has a send() too.
  const spooler = {
    jobs: [],
    send(job, payload) {
      this.jobs.push({ job, payload });
      return this.jobs.length;
    },
  };
  spooler.send("ghost:print-job", { copies: 1 });

  powerMonitor.on("lock-screen", () => timer.stop());
  nativeTheme.on("updated", () =>
    widget?.webContents?.send("theme:changed", nativeTheme.shouldUseDarkColors),
  );
  globalShortcut.register("CommandOrControl+Shift+N", () =>
    BrowserWindow.getFocusedWindow()?.webContents.send(Push.MenuNewEntry),
  );
  process.on("uncaughtException", (error) => log.warn("uncaught:", error.message));
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", () => globalShortcut.unregisterAll());

app.whenReady().then(() => {
  if (!settings.get("ui.locale"))
    settings.set({ "ui.locale": app.getLocale(), "ui.currency": "EUR" });
  const timer = new TimerService().register();
  registerIpc(timer);
  wireSystemEvents(timer);
  timer.target = mainWindow.open();
  widget = openWidget();
});
