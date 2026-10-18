"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRecipeHandlers = void 0;
const electron_1 = require("electron");
const channels_1 = require("../../common/channels");
const importer_1 = require("../importer");
const library_1 = require("../library");
const pdf_export_1 = require("../pdf-export");
const registerRecipeHandlers = () => {
    electron_1.ipcMain.handle(channels_1.IPC_CHANNELS.RECIPES_LIST, () => library_1.library.list());
    electron_1.ipcMain.handle(channels_1.IPC_CHANNELS.RECIPES_GET, (_event, id) => library_1.library.get(id));
    electron_1.ipcMain.handle(channels_1.IPC_CHANNELS.RECIPES_SAVE, (_event, recipe) => library_1.library.save(recipe));
    electron_1.ipcMain.handle(channels_1.IPC_CHANNELS.RECIPES_DELETE, (_event, id) => library_1.library.remove(id));
    electron_1.ipcMain.handle(channels_1.IPC_CHANNELS.RECIPES_IMPORT, async (_event, { url }) => {
        const draft = await (0, importer_1.importRecipe)(url);
        return library_1.library.save(draft);
    });
    electron_1.ipcMain.handle(channels_1.IPC_CHANNELS.RECIPES_EXPORT_PDF, async (event, { id }) => {
        const recipe = library_1.library.get(id);
        if (!recipe)
            return { saved: false };
        return (0, pdf_export_1.exportRecipePdf)(recipe, electron_1.BrowserWindow.fromWebContents(event.sender));
    });
};
exports.registerRecipeHandlers = registerRecipeHandlers;
