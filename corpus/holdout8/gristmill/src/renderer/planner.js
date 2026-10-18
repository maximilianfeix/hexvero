// The week planner: recipes dropped on days. Kept in this window only.
import { RECIPE_MIME } from "./library-view.js";

const PLAN_KEY = "gristmill.plan.v2";
const LEGACY_PLAN_KEY = "gristmill.plan";
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function emptyPlan() {
  return Object.fromEntries(DAYS.map((d) => [d, []]));
}

// 1.2 stored one recipe id per day as a plain string.
function migrate() {
  const legacy = localStorage.getItem(LEGACY_PLAN_KEY);
  if (legacy === null) return null;
  const plan = emptyPlan();
  for (const [day, id] of Object.entries(JSON.parse(legacy))) {
    if (plan[day] && id) plan[day].push(id);
  }
  localStorage.removeItem(LEGACY_PLAN_KEY);
  return plan;
}

export function loadPlan() {
  const raw = localStorage.getItem(PLAN_KEY);
  if (raw) return JSON.parse(raw);
  const plan = migrate() ?? emptyPlan();
  savePlan(plan);
  return plan;
}

export function savePlan(plan) {
  localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
}

export function bindPlanner(boardEl, titleOf) {
  const plan = loadPlan();
  const render = () => {
    for (const day of DAYS) {
      const cell = boardEl.querySelector(`[data-day="${day}"] ul`);
      cell.replaceChildren(
        ...plan[day].map((id) => Object.assign(document.createElement("li"), { textContent: titleOf(id) })),
      );
    }
  };
  boardEl.addEventListener("dragover", (e) => e.preventDefault());
  boardEl.addEventListener("drop", (e) => {
    const day = e.target.closest("[data-day]")?.dataset.day;
    const id = e.dataTransfer.getData(RECIPE_MIME);
    if (!day || !id) return;
    plan[day].push(id);
    savePlan(plan);
    render();
  });
  render();
}
