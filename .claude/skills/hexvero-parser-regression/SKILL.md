---
name: hexvero-parser-regression
description: How to fix a missed, wrong or slow result in a hexvero parser or the JavaScript/Electron scanner - regression test first, expected facts written independently of hexvero's output, metamorphic variants (plain, bundled, minified), resource budgets, and never executing a target. Use when a format parser, app.ts/scan.ts/resolve.ts, or a corpus row needs changing.
---

# Parser regressions in hexvero

Process and corpus rules: [CONTRIBUTING.md](../../../CONTRIBUTING.md) ("Fixing a missed or wrong
finding"), [corpus/README.md](../../../corpus/README.md). Where the scanner sits:
[docs/engineering/codebase-map.md](../../../docs/engineering/codebase-map.md) (path 1, path 5).

## Order of work

1. **Regression first.** Reproduce with the smallest input and add a failing test before the fix:
   a unit test in `packages/core/test/` (fixtures are built byte by byte in
   `packages/core/test/fixtures/`, e.g. `buildAsar`, `buildElf`), and for an Electron or native
   idiom the corpus lacks, a case in `corpus/dev/`.
2. **Independent expected facts.** Write `expected.json` from the case's sources, with `method` and
   a `why` per item. Never copy hexvero output into an expectation. List look-alikes under `absent`;
   mark a class `exhaustive` only when every item is listed.
3. **Metamorphic variants.** `node corpus/build.mjs` builds each Electron case as `plain`, `bundled`
   (esbuild) and `minified`; the facts must be the same in all three. A `-v2` build with
   `changes.json` checks comparisons and that moved-only items are not reported as changed.
4. **Fix the detector**, then:

```bash
npm run build
node corpus/observe-hexvero.mjs && node corpus/score.mjs corpus/results/hexvero.observations.json --set dev
npm run corpus          # inputs rebuild byte for byte; no row worse than corpus/results/hexvero.json
npm run corpus:accept   # only for a deliberate change; commit the new result
npm run check
```

5. Do not look at or tune on `corpus/holdout*`: those sets measure code hexvero was not fitted to.

## Resource budgets

- Keep every loop bounded: token budget (`tokenize`, 2,000,000), per-file and per-run byte and
  file limits (`analyzeJavaScriptTree`), resolver call caps, walk budgets in `app.ts`. A new cap
  needs a limitation code, never a silent stop.
- Add a hostile-input case to `packages/core/test/completeness.test.ts` ("hostile input stays
  fast") or `performance.test.ts` (linear growth) when a change adds a scan.
- Parallel tokenizing must give the same analysis: `performance.test.ts` ("gives the same analysis
  with and without worker threads") and `scripts/smoke-tarballs.mjs` check it.
- A change to what the scanner reads bumps `JS_SCAN_SCHEMA` (`packages/core/src/javascript/app.ts`)
  so stored scans are read again.

## Never execute targets

hexvero and its tests only read bytes. Do not `require`, import, launch or evaluate an analyzed
app, its scripts or its native code, not even to "check" an expectation. Damaged inputs
(`corpus/built/damaged/`, expectations in `corpus/damaged/expected.json`) must end in time with a structured error or a limitation. The only programs
that run are hexvero's own MIT corpus sources in `corpus/holdout/verify/`, against stand-ins.
