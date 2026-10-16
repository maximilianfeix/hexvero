# hexvero 0.8.0: know what changed inside your app

This release makes comparing two builds the main path, from the terminal, the browser and a
report you can attach to a review.

```bash
npx hexvero demo                  # two builds of an example Electron app, what changed between them
npx hexvero ui --demo --open      # the same comparison in the local web UI
npx hexvero compare old.asar new.asar --report report.md
```

## New

- **`hexvero demo [dir]`** copies two builds of the example app (shipped in the package, 12 KB)
  and prints each change with the file and line it was read from, how it was read, the window
  settings to review, and what was not established.
- **`compare --report file.md`** writes the comparison as deterministic Markdown: summary, changes
  with places, a "Not established" section, and the command to reproduce it. It refuses to
  overwrite an existing file unless `--force` is given. Text from the targets is quoted so it
  cannot add links, HTML or shell syntax of its own.
- **Web UI: Compare.** Pick a build before and after; each change and each finding location of a
  JavaScript app opens the source lines around it. Filter, counts of every list, report
  download, phone layout without sideways scrolling. The start screen leads with the example.

## Fixed

- A list that exists in only one build (the first endpoint or storage key an app ever has) was
  summarized as "only in b" without rows. It is now listed row by row as added or removed, or
  as unknown when the other build was read only in part.

## Changed

- Example 1.5.0 registers IPC channels whose names come from an environment variable, so the
  demo shows an honest unknown (`ipc_channel_unresolved` at `main.js:33`).
- Website rebuilt around the comparison, with a static example report generated from a real
  run; site URLs point at GitHub Pages.
- README limits quote the newest blind set (`holdout4`): 12 of 57 IPC channels, 5 of 8 version
  changes. The comparison is only as good as what the analysis reads.

## Not changed

No new formats or parsers. The MCP tool catalog is unchanged (15 tools).

## Checked

`npm run check` (405 tests), `npm run e2e` (11 flows), `npm run corpus` (no row worse),
`npm run release:check` including the tarball smoke test with `demo` and `--report`, on macOS
with Node 25. Linux, Windows and Node 22.12 run in CI.
