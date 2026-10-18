// Shopping list window (preload-shopping.js).
const list = document.getElementById("items");

function render(items) {
  list.replaceChildren(
    ...items.map((item, index) => {
      const li = document.createElement("li");
      const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: item.checked });
      box.addEventListener("change", () => window.shopping.send("shopping:toggle", { index }));
      li.append(box, ` ${item.text}`);
      li.title = item.recipe;
      return li;
    }),
  );
  document.getElementById("count").textContent = `${items.filter((i) => !i.checked).length} left`;
}

document.getElementById("clear").addEventListener("click", () => {
  window.shopping.send("shopping:clear");
});

document.body.classList.toggle("mac", window.shopping.platform === "darwin");
window.shopping.receive("shopping:changed", render);
window.shopping.request("shopping:items").then(render);
