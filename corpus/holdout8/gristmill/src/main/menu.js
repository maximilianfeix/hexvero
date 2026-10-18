"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMenu = void 0;
const electron_1 = require("electron");
const config_1 = require("./config");
const windows_1 = require("./windows");
const HELP_URL = "https://gristmill.example/help/importing";
const buildMenu = () => {
    const template = [
        ...(config_1.isMac ? [{ role: "appMenu" }] : []),
        {
            label: "File",
            submenu: [
                {
                    id: "file.sync",
                    label: "Sync Now",
                    accelerator: "CmdOrCtrl+Shift+S",
                    // The sync handlers live in ipc/sync.ts; reuse the listener there.
                    click: () => electron_1.ipcMain.emit("menu:sync-now"),
                },
                {
                    id: "file.shopping",
                    label: "Shopping List",
                    accelerator: "CmdOrCtrl+L",
                    click: () => (0, windows_1.openShoppingList)(),
                },
                { type: "separator" },
                config_1.isMac ? { role: "close" } : { role: "quit" },
            ],
        },
        { role: "editMenu" },
        { role: "windowMenu" },
        {
            role: "help",
            submenu: [
                {
                    id: "help.importing",
                    label: "Importing Recipes",
                    click: () => void electron_1.shell.openExternal(HELP_URL),
                },
            ],
        },
    ];
    electron_1.Menu.setApplicationMenu(electron_1.Menu.buildFromTemplate(template));
};
exports.buildMenu = buildMenu;
