const box = document.querySelector("#selection");
let rect = JSON.parse(localStorage.getItem("overlay.lastRegion") || "null");
let origin = null;

function draw(r) {
  Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
  box.hidden = false;
}

window.overlay.onFrame((frame) => {
  document.body.dataset.scale = String(frame.scale);
  if (rect) draw(rect);
});

document.addEventListener("pointerdown", (event) => {
  origin = { x: event.clientX, y: event.clientY };
});
document.addEventListener("pointermove", (event) => {
  if (!origin) return;
  rect = {
    x: Math.min(origin.x, event.clientX),
    y: Math.min(origin.y, event.clientY),
    width: Math.abs(event.clientX - origin.x),
    height: Math.abs(event.clientY - origin.y),
  };
  draw(rect);
});
document.addEventListener("pointerup", () => {
  origin = null;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.overlay.cancel();
  if (event.key === "Enter" && rect) {
    localStorage.setItem("overlay.lastRegion", JSON.stringify(rect));
    window.overlay.select(rect);
  }
});
