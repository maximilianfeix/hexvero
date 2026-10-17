# Posts (drafts, not posted)

Rules for all of them: post as the maintainer, from your own account, in your own words. Hacker
News forbids generated or AI-edited text and automated posting
(https://news.ycombinator.com/newsguidelines.html, checked 2026-10-16), so treat everything below
as an outline of facts and order, not as text to paste there. One channel, one story; no
identical cross-posts, no vote requests.

## X: 0.9.6 (draft; 0.9.6 is on npm since 2026-10-17)

> One Electron update, Fiddle 0.38 → 0.39, read without running either build. hexvero 0.9.6 finds
> the four changes that matter: a new field in an IPC payload (`useSocketFirewall`), a new
> persisted setting behind the app's own wrapper, a request to api.github.com from a bundled CLI,
> and that CLI's file. Each with file and line.
>
> npx hexvero compare old/app.asar new/app.asar ipc
>
> github.com/maximilianfeix/hexvero

Attach a screenshot of the three lines (`ipc … NPM_ADD_MODULES args: … → …useSocketFirewall…`,
`storage … isUsingSocketFirewall`, `endpoints … sfw.mjs … api.github.com`). Reply with the limits:
0.8.0 missed all four on the same pair; the newest blind set has 15 false window rows (duplicates,
fixed after the measurement); a scan is about 24 % slower than 0.8.0. Every fact:
[claims.md](claims.md) B1, F1, F2, G1, G2. Publishing is the maintainer's click; check
`npx hexvero@0.9.6` on the day you post.

## X: 0.9.2 (draft; 0.9.2 is on npm since 2026-10-17)

> Electron Fiddle 0.39.0 added a persisted setting, `isUsingSocketFirewall`, stored through the
> app's own `save()`/`retrieve()` wrappers. hexvero 0.9.2 now reports it as the one new storage
> key between the two builds, without running either.
>
> npx hexvero@0.9.2 compare old/app.asar new/app.asar storage
>
> github.com/maximilianfeix/hexvero

Reply with the honest numbers from the second blind set (written without access to hexvero,
measured once): IPC channels 52 of 64 and storage keys 22 of 41, none false; window settings 44 of
52 with 15 false, all duplicate rows of literals that were right for their window, fixed after the
measurement (`corpus/results/round5/README.md`). Every fact: [claims.md](claims.md) B1, B3.
Publishing is the maintainer's click; check `npx hexvero@0.9.2` on the day you post.

## X: 0.9.0 (draft, post after 0.9.0 is on npm)

> Know what changed inside your Electron release.
>
> hexvero 0.9.0 compares two builds without running either, shows each change with the file and
> line on both sides, keeps "could not tell" apart from "removed", and fails CI with exit 3 when a
> release exposes a new member to pages or talks to a new host.
>
> npx hexvero demo
>
> github.com/maximilianfeix/hexvero

Attach `docs/demo/release-gate.mp4` (25 s). Reply with the honest number: on the newest blind
set 49 of 54 IPC channels, but 14 of 39 window settings (`corpus/results/round4/README.md`);
on Electron Fiddle 45 of 46 bridge members are now linked to their main-process handler (0.8.0:
0).
Every fact: [claims.md](claims.md) C2, C3, C5, C7, A1.

## X: main post (0.8.0, kept for reference)

> Know what changed inside your app.
>
> hexvero compares two builds of an Electron app (or a binary) without running either: new IPC
> channels, preload members, window settings, endpoints, each with the file and line it was read
> from, and a list of what it could not establish.
>
> npx hexvero demo
>
> github.com/maximilianfeix/hexvero

Attach `docs/demo/compare.mp4` (or the GIF).

## X: thread (4 posts)

1. The example: 1.5.0 removes `openInShell` from the preload and adds `checkUpdate`, whose handler
   fetches an update URL. Both show up with `preload.js:9` and the handler `main.js:30`.
   [screenshot: docs/screenshots/ui-compare.png]
2. Window settings are reported as written, never assumed: `sandbox: false → true`,
   `nodeIntegration: true → false`. Where a value rests on Electron's default, it says so.
3. What it cannot read, it names: 1.5.0 builds channel names from an env var, so the report lists
   `ipc_channel_unresolved` at `main.js:33` instead of guessing. On my newest blind test set it
   found 12 of 57 channels; the misses are listed in the repo.
4. CLI, a local web UI where every file:line opens the code, a Markdown report, and an MCP server
   so a coding agent can do the same with small answers. MIT, Node 22+. Bug reports with a wrong
   fact are the most useful feedback.

## Show HN

**Title:** Show HN: Hexvero – compare two builds of an Electron app without running them

**URL:** https://github.com/maximilianfeix/hexvero

**First comment, outline (write it yourself):**

- Why: you kept asking what an Electron update changed (IPC a page can reach, window settings,
  new endpoints) and a diff of minified bundles did not answer it.
- What it does, with the demo output (three lines from `npx hexvero demo`).
- How it keeps facts apart: `●` read / `○` inferred, `literal` / `inferred`, unknown rows, the
  "Not established" section.
- Honest numbers: newest blind set `holdout5` 49 of 54 IPC channels with none false, but 14 of 39
  window settings, and 0 of 2 window-setting changes; why it missed them (wrapper class, options
  built with `Object.assign`). Link `corpus/results/round4/README.md`. If you mention the
  wrapper-class work, say it separately: Electron Fiddle 0 → 45 of 46 bridge members linked, and
  holdout5 as a development set (not blind) 72 of 72 channels. See `hn-fact-brief.md`.
- What it is not: no dynamic analysis, no verdicts, not a safety guarantee for hostile files.
- Ask: "where was the first answer wrong or missing something obvious?"

## Community post A: r/electronjs (Electron developers)

**Title:** I built a tool that tells you what changed between two builds of your Electron app
(IPC, preload, webPreferences) with file:line

**Body outline:** you as the developer; the problem of reviewing your own release (did a
refactor expose a new channel to the renderer, did a window lose `sandbox`); `npx hexvero demo`
output; `compare --report` for a PR or release review; what it cannot see (computed channel
names, run-time behavior); ask for a build where it got something wrong. Check the sidebar rules
for self-promotion before posting.

## Community post B: r/ReverseEngineering or r/netsec (security reviewers)

**Title:** Static diff of Electron app updates: IPC surface, preload bridge and window settings
between two asar builds

**Body outline:** methodology first: tokenizer-based scan, bounded resolver for channel names,
`interfaces` join (bridge member → channel → handler), how unknown differs from removed, the blind
corpus and its misses (holdout5 blind: 49/54 channels, 14/39 window settings) with the reason,
and, kept apart, what changed after the blind round (development set, Fiddle bridge links). Then the tool link. No vulnerability
claims; the example app is synthetic. These subreddits expect technical substance; if the
self-promotion rules do not allow a tool post, skip the channel.
