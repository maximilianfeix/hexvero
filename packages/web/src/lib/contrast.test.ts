/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** WCAG 2.x relative luminance and contrast ratio of two #rrggbb colors. */
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (x: string, y: string): number => {
  const [a, b] = [luminance(x), luminance(y)].toSorted((m, n) => n - m);
  return (a! + 0.05) / (b! + 0.05);
};

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const tokens = (selector: string): Record<string, string> => {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf("\n}", start));
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]),
  );
};

/** Text tokens on the surfaces they are used on: 4.5:1 (AA, normal text). */
const TEXT: Array<[string, string[]]> = [
  ["ink", ["bg", "panel", "panel-2", "amber-soft"]],
  ["ink-2", ["bg", "panel", "panel-2", "amber-soft"]],
  ["ink-3", ["bg", "panel"]],
  ["amber-ink", ["bg", "panel", "panel-2", "amber-soft"]],
  ["alert", ["bg", "panel", "panel-2"]],
  ["ok", ["bg", "panel", "panel-2"]],
];

describe("palette contrast (WCAG AA)", () => {
  for (const [theme, selector] of [
    ["dark", ":root"],
    ["light", ':root[data-theme="light"]'],
  ] as const) {
    const t = tokens(selector);
    it(`${theme}: text tokens reach 4.5:1 on their surfaces`, () => {
      for (const [fg, surfaces] of TEXT)
        for (const bg of surfaces)
          expect(ratio(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });
    it(`${theme}: the focus ring reaches 3:1 on every surface`, () => {
      for (const bg of ["bg", "panel", "panel-2", "amber-soft"])
        expect(ratio(t["focus"]!, t[bg]!), `focus on ${bg}`).toBeGreaterThanOrEqual(3);
    });
  }
});
