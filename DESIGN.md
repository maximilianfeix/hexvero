# hexvero — design decisions

Dark-first workbench used in dim rooms beside a terminal. The memorable element is the **verdict**: one
large sentence per target that says what the file is. Everything else is quiet, dense and legible.

## Color

| Token          | Dark      | Light     | Role                                       |
| -------------- | --------- | --------- | ------------------------------------------ |
| `--bg`         | `#1b1d21` | `#f3f4f6` | page                                       |
| `--panel`      | `#23262c` | `#ffffff` | sidebar, table surfaces                    |
| `--line`       | `#31353d` | `#dcdfe4` | hairlines, table rules                     |
| `--ink`        | `#e8e6e1` | `#1d2026` | primary text (warm off-white, not pure)    |
| `--ink-2`      | `#9a9ea7` | `#5c616b` | secondary text                             |
| `--ink-3`      | `#8e939d` | `#676c76` | tertiary text, notes (AA on bg and panel)  |
| `--amber`      | `#f2b84b` | `#8a5e04` | the one accent: evidence, selection, focus |
| `--focus`      | `#f2b84b` | `#8a5e04` | focus ring (≥ 3:1 on every surface)        |
| `--amber-soft` | `#3a2f17` | `#fbefcf` | selected rows, highlighted bytes           |
| `--alert`      | `#e5736f` | `#b3261e` | hardening off, dangerous permissions       |
| `--ok`         | `#8fc98a` | `#2a752e` | mitigation on, verified                    |

Text tokens reach WCAG AA (4.5:1) on the surfaces they are used on; `packages/web/src/lib/contrast.test.ts`
checks the values in `styles.css`. In the light theme the amber column above is the text/ring amber
(`--amber-ink`, `--focus`); the pale `#f2b84b` stays a fill only (primary button, selection marks).

Amber is spent on evidence only: confirmed findings, selected bytes, the active tab mark, focus rings.
Red and green appear as small marks in fact tables, never as washes.

## Type

- **IBM Plex Sans** (400/500/600) for UI and the verdict. Verdict: 600, `clamp(1.25rem, 2.2vw, 1.75rem)`,
  tracking -0.02em, balanced wrapping.
- **IBM Plex Mono** (400/500) for data: hex, offsets, addresses, symbol names, paths, hashes, table cells
  that hold identifiers. Tabular numerals everywhere numbers align.
- Body 14px/1.5 in tables, 15px/1.55 in prose. No all-caps labels, no eyebrows.

## Layout

```
┌ top bar: wordmark · open file · open path · theme ───────────────────┐
├ targets (240px) ┬ target header: path, format, size, hash, export    ┤
│ list of open    │ verdict sentence                                    │
│ targets + drop  │ tabs: Overview · Findings · <collections…> · Strings · Hex · Graph
│ zone            │ workspace: virtualized table / viewer               │
└─────────────────┴──────────────────────────────────────────────────────┘
```

Left-aligned throughout. Under 820px the sidebar becomes a slide-in sheet, tables scroll horizontally,
the hex view drops to 8 bytes per row.

## Structure carries information

- Tabs are the collections that exist for this target, with counts. No empty tabs.
- A finding's dot is filled when confirmed and hollow when inferred. Limitations always render,
  beneath findings, in the same list rhythm, never collapsed away.
- A truncated page says "showing 200 of 14,322 · filtered" inline where the count is.
- Tables: hairline row rules only, no zebra, no borders around cells, sticky header.

## Motion

One authored moment: when a target finishes analysis the verdict settles in (opacity + 6px rise,
220ms, ease-out). The evidence panel opening may fade in with a 4px rise (160ms); moving between rows
keeps it still. Everything else changes instantly: no staggered rows, no counting numbers.
`prefers-reduced-motion` stops every animation and transition, the mobile sidebar slide included.

## Browser surfaces

Selection color, caret, scrollbars (thin, `--line` thumb) and focus rings (2px amber, 2px offset) are
themed from the palette.

## Brand (README, site, social preview, banners)

Decided 2026-10-24 with the README rewrite.

- **Tagline**: "Know what changed inside your Electron release." Used as the README hero, the site
  `<h1>` and `og:title`, the social preview, both banners and the start of the CLI package
  description. Runner-ups: "Electron release changes, traced to file and line." and "Diff two
  Electron builds. Review changes with evidence."
- **Subline**: "Diff two builds of an Electron app and see the IPC channels, preload bridge, window
  settings and network hosts that changed, with file and line on both sides."
- **Descriptor** for titles, package metadata and search: "Electron release diff for security
  review". It stays in `<title>` and the package descriptions; the tagline does not replace it.
- **Palette**: unchanged. Charcoal `#1B1D21` and amber `#F2B84B` carry continuity with the UI, and
  amber stays reserved for evidence. No shield, lock or check-mark imagery: the brand must not
  suggest a security verdict.
- **Mark**: the rounded H with one hollow (inferred) and one filled (confirmed) dot, everywhere
  from 24 px up, including the social preview (which used a dotless H before). Below 24 px the
  dots blur, so the favicon is the dotless H on a charcoal tile: `site/favicon.svg`, copied to
  `docs/logo-favicon.svg`.
- **Banners and social preview show one real change**, not a hex dump or a dashboard crop: a new
  preload member with both of its lines, a channel that is unknown rather than removed, a window
  setting, a new host and `hexvero check` failing with exit 3, all from `npx hexvero demo`.
  Sources: `docs/launch/assets/banners.mjs` (writes `docs/banner-{dark,light}.svg`, no animation)
  and `docs/launch/assets/social-preview.html` (render at 1200×630 with a headless browser, copy
  the PNG to `docs/` and `site/`).
- **README order**: hero and demo GIF, a 10-second try, why, what it reads, own app, CI, agents,
  comparison, accuracy and limits, docs, contributing. Depth lives in `docs/`.

## Website (site/)

Decided 2026-10-31 with the site redesign. The site is dark only; the UI keeps its light theme.

- **Proof first.** Every visual on the landing page is real output on the NotesDesk example:
  the hero terminal (`compare`, `check`, `audit` tabs), the five-step trace (window → preload
  member → channel → handler → host), the two-build source split and the exit code. Nothing is
  a mock-up; long lines are shortened, never rewritten.
- **Section kickers are the command** that produces what the section shows
  (`$ hexvero check … --policy …`), in mono, with the flag that matters in amber. No numbered
  eyebrows, no all-caps labels.
- **Fonts** are served from `site/fonts/` (IBM Plex Sans 400/500/600, Mono 400/500, SIL OFL,
  from `@fontsource` 5.3.0); nothing is fetched from another origin.
- **Motion**, three authored moments, all off under `prefers-reduced-motion` and all optional:
  without JavaScript every section shows its final state.
  - The hero terminal replays its own output once when it is first on screen: the command types
    in at most 650 ms, then lines appear 55 ms apart, each rising 3 px over 240 ms. Tabs and
    "replay" run it again; a new run cancels the old one.
  - The trace nodes settle in 150 ms apart (opacity and 6 px, 360 ms), then the arrows between
    them draw in (320 ms each).
  - The exit code `3` fades in once (300 ms, 500 ms delay).
  - Easing everywhere: `cubic-bezier(0.2, 0.7, 0.2, 1)`. No parallax, no scroll-jacking, no
    animated counters, and a filled (confirmed) dot never animates out of a hollow one.
- **Comparison pages** (`site/compare/electronegativity/`, `site/compare/rea/`) open with a
  one-paragraph answer, date their sources, and never rank: they say which tool answers which
  question.
