// Script of the preview pane (index.html#preview), a WebContentsView next to the editor.
// MIT licensed, written for this corpus.

const SCROLL_KEY = "preview.scrollRatio";

function restoreScroll() {
  const ratio = Number(sessionStorage.getItem(SCROLL_KEY) ?? 0);
  window.scrollTo(0, ratio * (document.body.scrollHeight - window.innerHeight));
}

function start() {
  document.body.classList.add("preview");
  const pane = document.getElementById("preview");
  window.preview.onRender((html) => {
    // The HTML comes from the markdown renderer of the main process, which escapes the text.
    pane.innerHTML = html;
    restoreScroll();
  });
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const ratio = window.scrollY / Math.max(1, document.body.scrollHeight - window.innerHeight);
      sessionStorage.setItem(SCROLL_KEY, String(ratio));
      window.preview.reportScroll(ratio);
      ticking = false;
    });
  });
}

if (location.hash === "#preview") window.addEventListener("DOMContentLoaded", start);
