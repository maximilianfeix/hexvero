"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncEngine = exports.SyncEngine = void 0;
const electron_1 = require("electron");
const messages_1 = require("../../common/messages");
const library_1 = require("../library");
const store_1 = require("../store");
const api_client_1 = require("./api-client");
class SyncEngine {
    constructor() {
        this.running = null;
    }
    broadcast(status) {
        for (const win of electron_1.BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed())
                win.webContents.send(messages_1.MessageToWebApp.SyncStatus, status);
        }
    }
    async signIn(email, password) {
        const { token } = await api_client_1.api.post("/auth/token", { email, password, client: "desktop" });
        store_1.store.set("sync.token", token);
        return this.run();
    }
    signOut() {
        store_1.store.delete("sync.token");
        this.broadcast({ state: messages_1.SyncState.SignedOut });
    }
    run() {
        if (!this.running) {
            this.running = this.cycle()
                .catch((error) => {
                const status = { state: messages_1.SyncState.Failed, message: String(error.message ?? error) };
                this.broadcast(status);
                return status;
            })
                .finally(() => {
                this.running = null;
            });
        }
        return this.running;
    }
    async cycle() {
        if (!store_1.store.get("sync.token"))
            return { state: messages_1.SyncState.SignedOut };
        this.broadcast({ state: messages_1.SyncState.Pulling });
        const since = store_1.store.get("sync.lastPulledAt", 0);
        const remote = await api_client_1.api.get(`/recipes?since=${since}`);
        library_1.library.applyRemote(remote.recipes);
        this.broadcast({ state: messages_1.SyncState.Pushing });
        const { recipes, tombstones } = library_1.library.changedSince(since);
        for (const recipe of recipes) {
            await api_client_1.api.put(`/recipes/${encodeURIComponent(recipe.id)}`, recipe);
        }
        for (const id of tombstones) {
            await api_client_1.api.delete(`/recipes/${encodeURIComponent(id)}`);
        }
        store_1.store.set("sync.lastPulledAt", remote.serverTime);
        const status = { state: messages_1.SyncState.Idle, at: remote.serverTime, pushed: recipes.length };
        this.broadcast(status);
        return status;
    }
}
exports.SyncEngine = SyncEngine;
exports.syncEngine = new SyncEngine();
