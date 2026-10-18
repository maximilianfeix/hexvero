"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.library = exports.Library = void 0;
const electron_1 = require("electron");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const LIBRARY_FILE = "recipes.json";
const libraryDir = () => path_1.default.join(electron_1.app.getPath("userData"), "library");
class Library {
    constructor() {
        this.cache = null;
    }
    file() {
        return path_1.default.join(libraryDir(), LIBRARY_FILE);
    }
    load() {
        if (!this.cache) {
            try {
                this.cache = JSON.parse(fs_1.default.readFileSync(this.file(), "utf8"));
            }
            catch {
                this.cache = { recipes: [], tombstones: [] };
            }
        }
        return this.cache;
    }
    persist() {
        fs_1.default.mkdirSync(libraryDir(), { recursive: true });
        fs_1.default.writeFileSync(this.file(), JSON.stringify(this.cache, null, 2));
    }
    list() {
        return this.load().recipes.map(({ id, title, tags, updatedAt }) => ({ id, title, tags, updatedAt }));
    }
    get(id) {
        return this.load().recipes.find((r) => r.id === id) ?? null;
    }
    save(recipe) {
        const data = this.load();
        const saved = { ...recipe, id: recipe.id ?? (0, crypto_1.randomUUID)(), updatedAt: Date.now() };
        const at = data.recipes.findIndex((r) => r.id === saved.id);
        if (at === -1)
            data.recipes.push(saved);
        else
            data.recipes[at] = saved;
        this.persist();
        return saved;
    }
    remove(id) {
        const data = this.load();
        data.recipes = data.recipes.filter((r) => r.id !== id);
        data.tombstones.push({ id, at: Date.now() });
        this.persist();
        return true;
    }
    changedSince(since) {
        const data = this.load();
        return {
            recipes: data.recipes.filter((r) => r.updatedAt > since),
            tombstones: data.tombstones.filter((t) => t.at > since).map((t) => t.id),
        };
    }
    applyRemote(recipes) {
        const data = this.load();
        for (const remote of recipes) {
            const at = data.recipes.findIndex((r) => r.id === remote.id);
            if (at === -1)
                data.recipes.push(remote);
            else if (data.recipes[at].updatedAt < remote.updatedAt)
                data.recipes[at] = remote;
        }
        this.persist();
    }
}
exports.Library = Library;
exports.library = new Library();
