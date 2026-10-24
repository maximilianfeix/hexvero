// Generates docs/banner-dark.svg and docs/banner-light.svg: `node docs/launch/assets/banners.mjs`. Lines on the right are real
// `npx hexvero@0.11.1 demo` / `check` output (NotesDesk 1.4.0 → 1.5.0), shortened.
import { writeFileSync } from "node:fs";

const out = process.argv[2] ?? new URL("../../", import.meta.url).pathname;
const themes = {
  dark: {
    bg: "#1B1D21",
    panel: "#23262C",
    line: "#31353D",
    ink: "#E8E6E1",
    ink2: "#9A9EA7",
    amber: "#F2B84B",
    soft: "#3A2F17",
    ok: "#8FC98A",
    alert: "#E5736F",
  },
  light: {
    bg: "#F3F4F6",
    panel: "#FFFFFF",
    line: "#DCDFE4",
    ink: "#1D2026",
    ink2: "#5C616B",
    amber: "#8A5E04",
    soft: "#FBEFCF",
    ok: "#2A752E",
    alert: "#B3261E",
  },
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

for (const [name, c] of Object.entries(themes)) {
  const rows = [
    ["+", c.ok, "notesdesk.checkUpdate", "preload.js:9 → main.js:30"],
    ["+", c.ok, "update:check", "main.js:30"],
    ["?", c.amber, "shell:open", "unknown, not removed"],
    ["~", c.ink2, "win  sandbox: false → true", "main.js:15"],
    ["+", c.ok, "updates.notesdesk.example", "main.js:30"],
  ];
  let y = 128;
  const rowSvg = rows
    .map(([sign, col, name, place], i) => {
      const hl =
        i === 2
          ? `<rect x="740" y="${y - 19}" width="476" height="28" rx="5" fill="${c.soft}"/>`
          : "";
      const s = `${hl}<text x="756" y="${y}" class="mono row" style="fill:${col}">${esc(sign)}</text><text x="776" y="${y}" class="mono row">${esc(name)}</text><text x="1200" y="${y}" class="mono row muted" text-anchor="end">${esc(place)}</text>`;
      y += 34;
      return s;
    })
    .join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="360" viewBox="0 0 1280 360" role="img" aria-labelledby="title desc">
<title id="title">hexvero: know what changed inside your Electron release.</title>
<desc id="desc">Two builds of an example Electron app compared: a new preload member with its preload and handler lines, a new IPC channel, a channel reported as unknown rather than removed, a window setting that changed, a new host, and hexvero check failing with exit 3. Shortened from real output.</desc>
<defs><clipPath id="frame"><rect width="1280" height="360" rx="24"/></clipPath><style>text {font-family:"IBM Plex Sans", "Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;fill:${c.ink}} .wordmark {font-size:34px;font-weight:600;letter-spacing:-1.2px} .headline {font-size:46px;font-weight:600;letter-spacing:-1.6px} .sub {font-size:20px;fill:${c.ink2}} .mono {font-family:"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;font-size:15px;font-variant-ligatures:none} .row {font-size:14px} .small {font-family:"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;font-size:13px} .muted {fill:${c.ink2}}</style></defs>
<g clip-path="url(#frame)"><path fill="${c.bg}" d="M0 0H1280V360H0Z"/>
<g transform="translate(40 40)"><g fill="none" stroke="${c.amber}" stroke-linecap="round"><path d="M20 16V48 M44 16V48 M20 30H44" stroke-width="6.5"/><circle cx="28" cy="42" r="2.5" stroke-width="1.5"/><circle cx="36" cy="42" r="3.25" fill="${c.amber}" stroke="none"/></g></g>
<text x="112" y="84" class="wordmark">hexvero</text>
<text x="48" y="160" class="headline">Know what changed inside</text>
<text x="48" y="214" class="headline">your Electron release.</text>
<text x="48" y="256" class="sub">Two builds. File and line on both sides. A CI policy gate.</text>
<rect x="48" y="284" width="232" height="36" rx="8" fill="${c.panel}" stroke="${c.line}"/>
<text x="64" y="308" class="mono"><tspan class="muted">$ </tspan>npx hexvero demo</text>
<rect x="724" y="40" width="508" height="280" rx="16" fill="${c.panel}" stroke="${c.line}"/>
<text x="748" y="72" class="small muted">notesdesk 1.4.0 → 1.5.0</text>
<text x="1208" y="72" class="small muted" text-anchor="end">nothing executed</text>
<path d="M724 88H1232 M724 278H1232" stroke="${c.line}"/>
${rowSvg}
<text x="748" y="305" class="small" style="fill:${c.alert}">✗ hexvero check · policy violated · exit 3</text>
</g></svg>
`;
  writeFileSync(`${out}/banner-${name}.svg`, svg);
}
