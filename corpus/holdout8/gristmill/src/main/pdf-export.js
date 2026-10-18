"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportRecipePdf = void 0;
const electron_1 = require("electron");
const fs_1 = require("fs");
const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const renderPrintHtml = (recipe) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${escape(recipe.title)}</title>
<style>body{font:12pt Georgia,serif;margin:2cm}h1{font-size:20pt}li{margin:.2em 0}</style></head>
<body><h1>${escape(recipe.title)}</h1>
<p>Serves ${escape(recipe.servings ?? 4)}</p>
<h2>Ingredients</h2><ul>${(recipe.ingredients ?? []).map((i) => `<li>${escape(i)}</li>`).join("")}</ul>
<h2>Method</h2><ol>${(recipe.steps ?? []).map((s) => `<li>${escape(s)}</li>`).join("")}</ol>
${recipe.sourceUrl ? `<p><small>From ${escape(recipe.sourceUrl)}</small></p>` : ""}
</body></html>`;
const exportRecipePdf = async (recipe, parent) => {
    const { canceled, filePath } = await electron_1.dialog.showSaveDialog(parent ?? undefined, {
        defaultPath: `${recipe.title}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (canceled || !filePath)
        return { saved: false };
    const printWindow = new electron_1.BrowserWindow({
        show: false,
        width: 816,
        height: 1056,
        webPreferences: {
            nodeIntegration: false,
            sandbox: false,
        },
    });
    try {
        await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderPrintHtml(recipe))}`);
        const pdf = await printWindow.webContents.printToPDF({ pageSize: "Letter", printBackground: true });
        await fs_1.promises.writeFile(filePath, pdf);
        return { saved: true, filePath };
    }
    finally {
        printWindow.destroy();
    }
};
exports.exportRecipePdf = exportRecipePdf;
