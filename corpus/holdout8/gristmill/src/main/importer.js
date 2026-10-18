"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.importRecipe = void 0;
const electron_1 = require("electron");
const SCHEMA_ORG = "https://schema.org";
const LD_JSON = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const asList = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const findRecipeNode = (doc) => {
    const nodes = asList(doc["@graph"] ?? doc);
    return nodes.find((node) => asList(node["@type"]).includes("Recipe")) ?? null;
};
const stepText = (step) => (typeof step === "string" ? step : step.text ?? "");
const importRecipe = async (url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`Cannot import from ${parsed.protocol} addresses`);
    }
    const res = await electron_1.net.fetch(parsed.toString(), {
        headers: { "User-Agent": `Gristmill/${electron_1.app.getVersion()} (recipe import)` },
    });
    if (!res.ok)
        throw new Error(`The page answered ${res.status}`);
    const html = await res.text();
    for (const match of html.matchAll(LD_JSON)) {
        let doc;
        try {
            doc = JSON.parse(match[1]);
        }
        catch {
            continue;
        }
        if (typeof doc["@context"] === "string" && !doc["@context"].startsWith(SCHEMA_ORG))
            continue;
        const node = findRecipeNode(doc);
        if (!node)
            continue;
        return {
            title: node.name ?? parsed.hostname,
            servings: parseInt(String(node.recipeYield ?? "4"), 10) || 4,
            ingredients: asList(node.recipeIngredient),
            steps: asList(node.recipeInstructions).map(stepText).filter(Boolean),
            sourceUrl: parsed.toString(),
            tags: asList(node.recipeCategory),
        };
    }
    throw new Error("No recipe found on that page");
};
exports.importRecipe = importRecipe;
