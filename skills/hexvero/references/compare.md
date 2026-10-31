# Comparing two versions

1. Open and analyze both targets. Read both `limitations`. If either is a JavaScript app with `complete: false`, scan both with `scan: "all"` first, or every "added" item may only be a file that was not read on the other side.
2. Choose the collections that carry the question (Electron: `ipcChannels`, `contextBridge`, `webPreferences`, `endpoints`, `storage`; native: `imports`, `exports`, `symbols`, `libraries`; APK: `permissions`, `components`).
3. `hexvero_compare {targetA, targetB, collection}` for each. The identity is chosen automatically (`channel`, `api+member`, `file+window+key`, `name`, `type+name`, …); pass `key` only with a field you saw in both lists.
4. Read the result:
   - `added`, `removed`, `changed` (with the field paths that differ) and `unknown` each have `count`, a `sample`, and `next` when more items exist. Each list pages on its own: continue one with `list: "removed", offset: next` (that list's `next`, not another's). `shown` says how many of each list the answer holds; a sample is never the whole list.
   - `unknown`: found on one side where the other side has values that could not be resolved or files that were not read. Neither added nor removed: do not report it as either.
   - `relocated`: native items whose address moved and nothing else. Source positions (line, column) of Electron facts are positions too. `strict: true` counts both as changes.
   - `completeness`, `complete: false`, `partialScan`, or a `note`: say what was not compared.

## Release gate

`hexvero_check {targetA, targetB, policy}` (a policy JSON object, or `policyPath`; optional `baselinePath`) applies a release policy and returns `status` `pass`, `fail` or `incomplete` with findings, paged by `offset` (`findingsPage.next`). `incomplete` means undecided, not passed. The tool only reads a baseline; accepting findings into one is `hexvero check … --baseline <file> --update-baseline`, run by a person. Without `targetB` the same tool audits one build (`hexvero audit`, see [electron.md](electron.md#security-audit)).

## Explaining a difference

Name what changed and why it matters, with the item as evidence: "the settings window now sets `sandbox: true` (main.js, window 2; was false)". A changed setting or a new endpoint is a fact about the code; whether it is reachable at run time is not established by a static comparison.
