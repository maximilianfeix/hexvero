"use strict";
// Compiled from src/main/menu.ts.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMenu = buildMenu;
const electron_1 = require("electron");
const FLASHING_GUIDE = "https://docs.padwright.example/guides/flashing";
function buildMenu({ bus, windows }) {
    const template = [
        { role: "appMenu" },
        {
            label: "Device",
            submenu: [
                { id: "device:rescan", label: "Rescan USB", accelerator: "CmdOrCtrl+R", click: () => bus.rescan() },
                { id: "device:diagnostics", label: "Diagnostics Console", click: () => windows.openDiagnostics() },
            ],
        },
        {
            role: "help",
            submenu: [{ label: "Flashing Guide", click: () => void electron_1.shell.openExternal(FLASHING_GUIDE) }],
        },
    ];
    return electron_1.Menu.buildFromTemplate(template);
}
