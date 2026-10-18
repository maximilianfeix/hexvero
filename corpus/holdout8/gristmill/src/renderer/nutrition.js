// Nutrition facts per ingredient, from the public nutrition service.
const NUTRITION_API = "https://nutrition.gristmill.example/api";
export const ATTRIBUTION = "Nutrition data: nutrition.gristmill.example (https://nutrition.gristmill.example)";

const cache = new Map();

export async function lookup(ingredient) {
  const query = ingredient.replace(/^[\d./\s]+(g|kg|ml|l|tbsp|tsp|cups?)?\s+/i, "").trim();
  if (cache.has(query)) return cache.get(query);
  const res = await fetch(`${NUTRITION_API}/foods/search?q=${encodeURIComponent(query)}&pageSize=5`);
  if (!res.ok) throw new Error(`nutrition lookup failed: ${res.status}`);
  const { foods } = await res.json();
  const best = foods[0] ?? null;
  cache.set(query, best);
  return best;
}

export async function totals(ingredients) {
  const found = await Promise.all(ingredients.map((i) => lookup(i).catch(() => null)));
  return found.filter(Boolean).reduce(
    (sum, f) => ({ kcal: sum.kcal + (f.kcal ?? 0), protein: sum.protein + (f.protein ?? 0) }),
    { kcal: 0, protein: 0 },
  );
}
