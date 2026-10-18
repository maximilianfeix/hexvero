"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.api = exports.API_BASE = exports.ApiClient = exports.AuthError = void 0;
const electron_1 = require("electron");
const store_1 = require("../store");
class AuthError extends Error {
    constructor() {
        super("Signed out by the server");
        this.name = "AuthError";
    }
}
exports.AuthError = AuthError;
class ApiClient {
    constructor(baseUrl, getToken) {
        this.baseUrl = baseUrl;
        this.getToken = getToken;
    }
    async request(method, path, body) {
        const headers = {
            "Content-Type": "application/json",
            "X-Gristmill-Client": `desktop/${electron_1.app.getVersion()}`,
        };
        const token = this.getToken();
        if (token)
            headers.Authorization = `Bearer ${token}`;
        const res = await electron_1.net.fetch(`${this.baseUrl}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.status === 401)
            throw new AuthError();
        if (!res.ok)
            throw new Error(`${method} ${path} failed: ${res.status}`);
        return res.status === 204 ? null : res.json();
    }
    get(path) {
        return this.request("GET", path);
    }
    post(path, body) {
        return this.request("POST", path, body);
    }
    put(path, body) {
        return this.request("PUT", path, body);
    }
    delete(path) {
        return this.request("DELETE", path);
    }
}
exports.ApiClient = ApiClient;
exports.API_BASE = "https://api.gristmill.example/v2";
exports.api = new ApiClient(exports.API_BASE, () => store_1.store.get("sync.token") ?? null);
