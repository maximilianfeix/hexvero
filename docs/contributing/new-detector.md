# Adding a detector

A detector turns something in an application's code into a fact hexvero reports: a finding ("a
window with `nodeIntegration: true`"), rows of a collection (`storage`, `endpoints`), or both. This
page walks the whole path for a JavaScript or Electron detector, from the token loop to the
corpus, with the existing `storage` collection as the worked example. Line numbers are those of
`03588ec` (0.9.0); search for the quoted name if they have moved.

Read `docs/engineering/codebase-map.md`, paths 1 (analyze to a finding), 2 (compare and report)
and 5 (large apps, stored scans) first. Native formats follow the same rules but live in
`packages/core/src/formats/` and `analyzers/binary.ts`; see CONTRIBUTING.md.

## The path at a glance

| Step | Where                                                                     | What you add                                                                |
| ---- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1    | `packages/core/src/javascript/` (`candidates.ts`, `app.ts`, `scan.ts`)    | the scan over the token stream of one file                                  |
| 2    | `app.ts`, `FileTokenFacts` and `JsScanFacts`                              | what one file contributes, and how files are merged                         |
| 3    | `app.ts`, assembly at the end of `analyzeJavaScriptTree`                  | findings with `confidence` and `location`; limitations with a stable `code` |
| 4    | `session.ts`, `collectionsOf` and `coverage`                              | the collection name callers page, and which values stayed unresolved        |
| 5    | `compare.ts`, `COMPOSITE_KEYS`, `SOURCE_LINE_FIELDS`, `COLLECTION_FAMILY` | identity for `compare`, which fields are positions                          |
| 6    | `report.ts` `ORDER`, `packages/web/src/lib/compare.ts` `MEANING`          | where it sits in the report, one sentence for the UI                        |
| 7    | `packages/core/test/`                                                     | a unit test of the scan and a byte-built fixture through the whole analysis |
| 8    | `corpus/`                                                                 | an expectation with a `why`, and a scorer row                               |

## Worked example: `storage`

`storage` lists web storage, IndexedDB, Cache Storage, cookies and electron-store accesses, each
with its key, what is done to it, file, line and column. Every step below exists in the code today.

### 1. The scan

The detectors of endpoints, storage and URLs share one pass over a file's tokens,
`findCandidates` (`packages/core/src/javascript/candidates.ts:161`). The storage branch starts at
`candidates.ts:558`: for `localStorage.setItem(…)` it looks up the operation in `STORAGE_OPS`
(`candidates.ts:124`), reads the argument with `readArg` (`candidates.ts:302`) and records a row
with `push` (`candidates.ts:313`):

```ts
const op = STORAGE_OPS[next!.value];
if (!op) continue;
storageKey(kind, k + 4, t, { op });
```

`storageKey` reads the key with `readArg`, or, when the key is a parameter of the function the call
is in, at each call of that wrapper (`ExpressionResolver.wrapperCalls`, rows with `via`; see
docs/electron-findings.md, Storage keys through wrappers and enums).

Things to copy from it:

- **Read tokens, never text.** The tokenizer has already dropped comments, and strings are single
  tokens, so `// localStorage.setItem("ghost", "1")` is not a row. A regular expression over the
  source is only allowed as a cheap pre-filter.
- **Pre-filters decide whether you run at all.** `readFileTokens` calls `findCandidates` only when
  the file matches `CAN_HOLD_CANDIDATES` (`app.ts:1439`, used at `app.ts:2051`), and the alias
  resolution runs only when `NAMES_SOMETHING` matches (`scan.ts:210`). A detector that keys on a
  new word must add it there, or it silently never fires on large apps. Keep the filter: most
  files of a real application are icons, locale tables and vendored code.
- **Values come from `readArg`.** It returns a literal, a template with `${…}` gaps, a constant of
  the file, or a reference to another module's constant (filled in later), with an `evidence` of
  `literal`, `inferred`, `template` or `unknown`. An argument that cannot be read is still a row,
  with `value: null` and the `expression` it saw: hexvero says it does not know, it does not drop
  the call.
- **Bound the work.** `push` stops at `MAX_PER_LIST` (`candidates.ts:107`) and sets `truncated`;
  the resolver behind `readArg` is called at most 33 times per file (`throughResolver`,
  `candidates.ts:275`). Anything unbounded will show up in `docs/benchmarks.md`.
- **Same fact twice is one row with a `count`** (the `seen` map in `push`).

For a window observation ("X in a BrowserWindow") the scan lives in `readFileTokens` instead
(`app.ts:1805`): settings are collected as `settingsAt` from `key:` tokens inside the ranges
`windowRanges` (`app.ts:404`) found, then turned into `WebPreference` rows (`app.ts:139`) and one
`WindowSummary` per window (`app.ts:189`).

### 2. Per file, then the application

A file's results travel as `FileTokenFacts` (`app.ts:1790`). That type is what the worker threads
of `tokenPool.ts` send back, so it must stay plain data (no functions, no class instances). The
application scan merges the files in a fixed order into `JsScanFacts` (`app.ts:1355`); for storage
that is the loop at `app.ts:2247`, which also enforces the application-wide cap `MAX_CANDIDATES`
(`app.ts:1437`) and remembers that it was hit.

`JsScanFacts` is what the scan cache stores between runs (`scanState.ts`). If you add a field:

- add it to the list `loadScan` requires (`scanState.ts:69-81`, `storage` is at line 78), so a scan
  stored by older code is read again instead of failing later, and
- raise `JS_SCAN_SCHEMA` (`app.ts:1349`).

Cross-module values are settled once all files are read: `finished(facts.storage)`
(`app.ts:2994`) replaces references to another module's constant with its value.

### 3. Findings and limitations

The assembly at the end of `analyzeJavaScriptTree` writes one finding for the whole list
(`app.ts:3294-3313`):

```ts
[storage, "js.storage", "storage key", "storage"],
// …
confidence: rows.every((r) => r.evidence === "literal") ? "confirmed" : "inferred",
location: `${first.file}:${first.line}`,
```

- `kind` is stable and machine-readable (`js.storage`); `title` is a sentence and may change.
- `confidence` is `confirmed` only when every value stands as a literal at its call; anything
  followed through constants, helpers or call sites is `inferred`. `scripts/check-shape.mjs`
  rejects any other literal.
- `location` is `file:line` of the first row. The e2e test opens that file and requires the line to
  contain the text the finding claims, so point at the call, not at a declaration nearby.
- The detail names the collection (`(collection storage)`) so a reader knows where the rows are.
- A scan that has not read every file rewrites the title to "… in the scanned part" and lowers
  the confidence (`app.ts:3341`); add your kind to that pattern if your finding is a count.

What could not be done is a limitation with a stable `code`, never a silent gap. The cap above is
`candidates_truncated` (`app.ts:2747-2751`). Add a new code when your detector can be cut short;
existing callers match on codes, so do not reuse one with a different meaning.

### 4. The collection

`collectionsOf` (`session.ts:767`) is the single place where analysis data becomes named lists
that CLI, MCP and HTTP page: `if (d.app.storage.length) out["storage"] = d.app.storage;`
(`session.ts:984`). Never return a list from anywhere else; paging and byte budgets are applied
on these.

`Session.coverage` (`session.ts:402-403`) records the files where a value could not be resolved:

```ts
for (const row of app.storage)
  if (computedValue(row.value)) unresolved.add("storage", storageSlot(row.file, row.kind));
```

`compare` uses that to call a one-sided item `unknown` instead of `added` or `removed` when the
other side has an unread value in the same file (for storage: of the same kind in the same file). A limitation that hides values is mapped to a
family in `UNRESOLVED_LIMITATIONS` (`session.ts:1013`).

### 5. Identity for compare

`compare` matches items of two builds by a key. Three tables in `packages/core/src/compare.ts`
decide it for a new collection:

- `COMPOSITE_KEYS` (`compare.ts:246`): which fields together say "the same fact". Storage tries
  them in order (`compare.ts:278-282`):

  ```ts
  storage: [
    ["file", "kind", "value", "op"],
    ["kind", "value", "op"],
    ["kind", "value"],
  ],
  ```

  A read and a write of the same key are two facts; the file is part of the identity when rows
  carry one (an application), and is left out for a single bundle. Never put a line, column or
  count in a key.

- `SOURCE_LINE_FIELDS` (`compare.ts:181`): fields that are positions, not content. With
  `storage: ["line", "column"]` (`compare.ts:188`), a call that moved because code above it
  changed is unchanged, not removed and added. Nested positions go in `NESTED_LINE_FIELDS`, and
  fields that only restate others in words in `DERIVED_FIELDS`.

- `COLLECTION_FAMILY` (`compare.ts:64`, `storage: "storage"` at line 73): which unresolved family
  of step 4 can explain a one-sided row. A new family is a new member of `UnresolvedFamily`
  (`compare.ts:61`).

`hexvero check` has its own identities for the lists its rules read (`KIND_LISTS` at `policy.ts:399` and
`DEFAULT_KEYS` at `policy.ts:420`). Storage is not a policy list; if your collection should be,
add it there and to `docs/policy.schema.json`.

### 6. Report order and UI text

- `ORDER` in `packages/core/src/report.ts:140` places the collection in the Markdown and HTML
  reports: what a page can reach first, then what the app talks to (`storage` is at line 147).
  A collection not in `ORDER` comes last; one in `SUMMARY_ONLY` (`report.ts:154`) is counted but
  not listed row by row.
- `MEANING` in `packages/web/src/lib/compare.ts:265` is the sentence the Compare view and the
  evidence panel show next to the name, in the reader's terms:
  `storage: "Storage keys the code reads or writes"` (line 272).
- `suggestNextSteps` (`packages/core/src/next.ts:49`) offers the list to an agent
  ("What does it keep in local storage?").

### 7. Tests

Two kinds, both under `packages/core/test/`:

- **The scan alone**, on a string: `describe("storage")` in `candidates.test.ts:234` feeds one
  source with every idiom and its look-alikes (a comment, `custom.getItem` on an unrelated
  object, a dynamic key) and compares a one-line rendering of each row, so a missing or extra row
  is one obvious line in the diff.
- **The whole analysis on a byte-built fixture.** `buildAsar` (`test/fixtures/asar.ts:4`) writes a
  real ASAR archive from a map of paths to sources; nothing is checked in as a binary.
  `report.test.ts:13-49` builds two versions of an app this way, opens both in a `Session` and
  asserts the compare rows with their `file:line`. Use the same pattern for a new collection:
  one test that the rows appear in `collectionsOf`, one that a moved call is unchanged in
  `compare`, one that an unread value makes the other side's row `unknown`.

`npm run check` runs both, plus `scripts/check-shape.mjs`.

### 8. Corpus

The corpus measures a detector against facts written from the source, not from hexvero's output
(`corpus/README.md`). For storage:

- `corpus/dev/notes-app/expected.json`, `expect.storage`: `present` rows with `kind`, `value`,
  `ops` and a `why` where it is not obvious, `absent` look-alikes (`ghost-comment`,
  `ghost-custom`), and `exhaustive: true`, so anything else reported is false.
- `corpus/observe-hexvero.mjs:46` reads the collection through a `Session`, and
  `corpus/score.mjs:241` scores it into the rows "storage keys" and "storage read/write/delete".

For a new class: add the idiom and its look-alikes to the sources of a `corpus/dev` case, write
the expectation, add the observer and scorer lines, then run `node corpus/build.mjs`,
`npm run corpus` (no row may get worse) and `npm run corpus:accept` to record the new row. Never
tune on a hold-out set.

## Checklist

- [ ] Reads tokens, has a pre-filter, is bounded, and reports unread values as rows.
- [ ] New `JsScanFacts` fields are required in `loadScan`, and `JS_SCAN_SCHEMA` is raised.
- [ ] Finding with a stable `kind`, `confirmed` only for literals, `location` at the call.
- [ ] Every cap or skipped case is a limitation with a stable `code`.
- [ ] Collection in `collectionsOf`; unresolved values in `Session.coverage`.
- [ ] `COMPOSITE_KEYS`, `SOURCE_LINE_FIELDS`, `COLLECTION_FAMILY` entries.
- [ ] `ORDER` and `MEANING` entries.
- [ ] Unit test, byte-built fixture test, corpus expectation and score row.
- [ ] `npm run check`, `npm run e2e`, `npm run corpus` pass; a large real app is no more than
      15 % slower (`node scripts/bench.mjs`, interleaved A/B as in `docs/benchmarks.md`).
