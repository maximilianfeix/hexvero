// Records the UI half of docs/demo/release-review.mp4: the real local UI on the example builds.
// Not part of the build; needs playwright-core and a Chromium outside this repository:
//   node packages/cli/bin/hexvero.js ui --demo --port 4712      # prints the URL with its token
//   node docs/demo/record-release-review.mjs '<that URL>' [path to Chromium]
// writes ui.webm in the working directory. The terminal half is release-review-terminal.tape;
// the two are joined with ffmpeg (0.5 s fade, H.264, CRF 26) into release-review.mp4 and .gif.
import { chromium } from "playwright-core";
import { renameSync, readdirSync } from "node:fs";
const [url, executablePath] = process.argv.slice(2);
const b = await chromium.launch({ executablePath });
const ctx = await b.newContext({
  viewport: { width: 1280, height: 720 },
  colorScheme: "dark",
  recordVideo: { dir: "vid", size: { width: 1280, height: 720 } },
});
await ctx.addInitScript(() => {
  addEventListener("DOMContentLoaded", () => {
    const c = document.createElement("div");
    c.style.cssText =
      "position:fixed;z-index:99999;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;border:2px solid #f2b84b;background:rgba(242,184,75,.18);pointer-events:none;transition:transform .12s";
    document.body.append(c);
    addEventListener(
      "mousemove",
      (e) => {
        c.style.left = e.clientX + "px";
        c.style.top = e.clientY + "px";
      },
      true,
    );
    addEventListener("mousedown", () => (c.style.transform = "scale(.7)"), true);
    addEventListener("mouseup", () => (c.style.transform = ""), true);
  });
});
const p = await ctx.newPage();
await p.goto(url);
await p.waitForSelector("li.change");
await p.mouse.move(640, 300);
await p.waitForTimeout(2200);
const rows = p.locator("li.change");
async function go(locator, hold) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  await p.mouse.move(box.x + Math.min(160, box.width / 2), box.y + 14, { steps: 18 });
  await p.waitForTimeout(250);
  await p.mouse.down();
  await p.mouse.up();
  await p.waitForTimeout(hold);
}
await p.evaluate(() =>
  document.querySelector("li.change").scrollIntoView({ behavior: "smooth", block: "center" }),
);
await p.waitForTimeout(1200);
await go(rows.nth(0).locator("button, [role=button], a").first(), 3200);
await go(rows.nth(5).locator("button, [role=button], a").first(), 2800);
await go(rows.nth(6).locator("button, [role=button], a").first(), 3800);
await ctx.close();
await b.close();
const f = readdirSync("vid").find((n) => n.endsWith(".webm"));
renameSync("vid/" + f, "ui.webm");
console.log("ok");
