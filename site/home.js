// Landing page enhancements. Without this file every section is complete and static: the
// terminal shows its final output, the trace and the exit code are visible.
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Copy buttons: the command stays selectable without them.
for (const button of document.querySelectorAll("[data-copy]")) {
  if (!navigator.clipboard) continue;
  button.hidden = false;
  button.addEventListener("click", async () => {
    const text = document.getElementById(button.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select and copy";
    }
    setTimeout(() => (button.textContent = "Copy"), 1600);
  });
}

// Top bar rule once the page scrolls.
const bar = document.querySelector(".bar");
const onScroll = () => bar.classList.toggle("scrolled", scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// Terminal: replays the real output it already contains. A run is cancelled when another
// starts, so switching tabs mid-run never leaves half a scene.
const term = document.querySelector(".hero .term");
const tabs = [...term.querySelectorAll('[role="tab"]')];
const replay = term.querySelector(".replay");
let run = 0;

async function play(panel) {
  const id = ++run;
  const lines = [...panel.querySelectorAll(".l")];
  for (const line of lines) {
    const typed = line.querySelector(".cl .typed, .typed");
    if (line.classList.contains("cl") && typed?.dataset.text)
      typed.textContent = typed.dataset.text;
    line.querySelector(".caret")?.remove();
  }
  if (reduce.matches) {
    for (const line of lines) line.classList.remove("hid", "in");
    return;
  }
  for (const line of lines) {
    line.classList.add("hid");
    line.classList.remove("in");
  }
  for (const line of lines) {
    if (id !== run) return;
    line.classList.remove("hid");
    const typed = line.classList.contains("cl") && line.querySelector(".typed");
    if (typed) {
      const text = typed.dataset.text ?? (typed.dataset.text = typed.textContent);
      const caret = document.createElement("span");
      caret.className = "caret";
      typed.after(caret);
      const step = Math.max(8, Math.min(22, 650 / text.length));
      for (let i = 0; i <= text.length && id === run; i += 2) {
        typed.textContent = text.slice(0, i);
        await wait(step);
      }
      typed.textContent = text;
      if (id === run) await wait(220);
      caret.remove();
    } else {
      line.classList.add("in");
      await wait(line.textContent.trim() ? 55 : 30);
    }
  }
}

function select(tab, focus) {
  for (const other of tabs) {
    const on = other === tab;
    other.setAttribute("aria-selected", String(on));
    other.tabIndex = on ? 0 : -1;
    document.getElementById(other.getAttribute("aria-controls")).hidden = !on;
  }
  if (focus) tab.focus();
  play(document.getElementById(tab.getAttribute("aria-controls")));
}

for (const tab of tabs) {
  tab.addEventListener("click", () => select(tab, false));
  tab.addEventListener("keydown", (event) => {
    const i = tabs.indexOf(tab);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    select(tabs[(i + step + tabs.length) % tabs.length], true);
  });
}
replay.hidden = false;
replay.addEventListener("click", () =>
  select(
    tabs.find((tab) => tab.getAttribute("aria-selected") === "true"),
    false,
  ),
);

// Play once when the terminal is first on screen.
new IntersectionObserver((entries, observer) => {
  if (!entries.some((entry) => entry.isIntersecting)) return;
  observer.disconnect();
  play(document.getElementById("t-compare"));
}).observe(term);

// The trace: an arrow between neighbouring nodes, drawn after the nodes settle.
const trace = document.querySelector(".trace");
const paths = [...trace.querySelectorAll("svg path")];
function layoutTrace() {
  const box = trace.getBoundingClientRect();
  const nodes = [...trace.querySelectorAll(".node")].map((node) => node.getBoundingClientRect());
  paths.forEach((path, i) => {
    const a = nodes[i];
    const b = nodes[i + 1];
    const y = a.top - box.top + 22;
    const x1 = a.right - box.left + 3;
    const x2 = b.left - box.left - 3;
    path.setAttribute(
      "d",
      `M${x1} ${y} H${x2} M${x2 - 5} ${y - 4} L${x2} ${y} L${x2 - 5} ${y + 4}`,
    );
    const length = path.getTotalLength();
    path.style.strokeDasharray = String(length);
    if (!trace.classList.contains("on")) path.style.strokeDashoffset = String(length);
  });
}
layoutTrace();
addEventListener("resize", layoutTrace);
document.fonts?.ready.then(layoutTrace);

const reveal = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      reveal.unobserve(entry.target);
      entry.target.classList.add("on");
      if (entry.target !== trace) continue;
      paths.forEach((path, i) => {
        path.style.transition = reduce.matches
          ? "none"
          : `stroke-dashoffset 320ms cubic-bezier(.2,.7,.2,1) ${150 * (i + 1) + 180}ms`;
        path.style.strokeDashoffset = "0";
      });
    }
  },
  { threshold: 0.35 },
);
for (const element of document.querySelectorAll("[data-reveal]")) reveal.observe(element);
