// The recipe list, the recipe page and the import form.
const SEARCH_KEY = "gristmill.search";
export const RECIPE_MIME = "application/x-gristmill-recipe";

let recipes = [];

const matches = (recipe, query) =>
  !query ||
  recipe.title.toLowerCase().includes(query) ||
  (recipe.tags ?? []).some((t) => t.toLowerCase().includes(query));

export async function refreshList(listEl) {
  recipes = await window.recipes.list();
  renderList(listEl);
}

function renderList(listEl) {
  const query = (sessionStorage.getItem(SEARCH_KEY) ?? "").trim().toLowerCase();
  listEl.replaceChildren(
    ...recipes
      .filter((r) => matches(r, query))
      .map((r) => {
        const li = document.createElement("li");
        li.textContent = r.title;
        li.dataset.id = r.id;
        li.draggable = true;
        li.addEventListener("dragstart", (e) => e.dataTransfer.setData(RECIPE_MIME, r.id));
        return li;
      }),
  );
}

export function bindSearch(inputEl, listEl) {
  inputEl.value = sessionStorage.getItem(SEARCH_KEY) ?? "";
  inputEl.addEventListener("input", () => {
    sessionStorage.setItem(SEARCH_KEY, inputEl.value);
    renderList(listEl);
  });
}

const minutesIn = (step) => {
  const m = /(\d+)\s*(?:min|minutes)\b/i.exec(step);
  return m ? Number(m[1]) : null;
};

export async function showRecipe(pageEl, id) {
  const recipe = await window.recipes.get(id);
  if (!recipe) return;
  pageEl.querySelector("h1").textContent = recipe.title;
  pageEl.querySelector(".ingredients").replaceChildren(
    ...recipe.ingredients.map((line) => Object.assign(document.createElement("li"), { textContent: line })),
  );
  pageEl.querySelector(".steps").replaceChildren(
    ...recipe.steps.map((step) => {
      const li = Object.assign(document.createElement("li"), { textContent: step });
      const minutes = minutesIn(step);
      if (minutes) {
        const button = Object.assign(document.createElement("button"), { textContent: `${minutes} min timer` });
        button.addEventListener("click", () => window.timers.start(recipe.title, minutes * 60));
        li.append(" ", button);
      }
      return li;
    }),
  );
  const source = pageEl.querySelector(".source");
  source.hidden = !recipe.sourceUrl;
  source.onclick = () => window.desktop.openExternal(recipe.sourceUrl);
  pageEl.querySelector(".copy").onclick = () => window.desktop.copyText(recipe.ingredients.join("\n"));
  pageEl.querySelector(".pdf").onclick = async () => {
    const result = await window.recipes.exportPdf(recipe.id);
    if (result.saved) window.desktop.showItemInFolder(result.filePath);
  };
  pageEl.querySelector(".shop").onclick = () => {
    const servings = Number(pageEl.querySelector(".servings").value) || recipe.servings;
    window.recipes.addToShoppingList(recipe.id, servings);
  };
  pageEl.querySelector(".delete").onclick = async () => {
    if (!confirm(`Delete "${recipe.title}"?`)) return;
    await window.recipes.remove(recipe.id);
    pageEl.hidden = true;
  };
}

export function bindImport(formEl, onImported) {
  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = formEl.elements.url.value.trim();
    formEl.classList.add("busy");
    try {
      const saved = await window.recipes.importFromUrl(url);
      formEl.reset();
      onImported(saved);
    } catch (error) {
      formEl.querySelector(".error").textContent = String(error.message ?? error);
    } finally {
      formEl.classList.remove("busy");
    }
  });
}
