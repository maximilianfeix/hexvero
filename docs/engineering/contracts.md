# Sprint contracts (frozen 2026-10-17 by the lead)

Every agent codes against these shapes. A change to a contract goes through the lead; the owner
of the file implements it. Names are TypeScript in `@hexvero/core` unless noted.

## C1. Comparison completeness (owner: B, `compare.ts`, `session.ts`)

The full collection arrays are already in memory (`Session.collectionTable`). The 2,000-item page
in `compareCollection` is a presentation limit, not a reason to compare less.

- `compareCollection` compares **every** item of both sides up to a resource budget:
  `COMPARE_BUDGET = { items: 200_000 per side, bytes: 256 MiB per side (serialized) }`.
  Beyond the budget the result is partial and says so; it never silently stops at 2,000.
- New field on `CompareResult` and `CollectionComparison`:

```ts
interface CompareCompleteness {
  /** Items compared per side and items that exist per side. */
  compared: { a: number; b: number };
  total: { a: number; b: number };
  /** True only when both sides were compared whole AND no coverage gap applies to the result. */
  complete: boolean;
  /** Machine codes, stable: "budget" | "scan_partial" | "files_unread" | "files_unreadable"
   *  | "values_unresolved" | "item_truncated". Empty when complete. */
  gaps: string[];
}
```

- `partial` on `CollectionComparison` stays (true iff `!completeness.complete`) for compatibility.
- The returned `left`/`right` pages stay a bounded preview (2,000) for callers that print items;
  identity matching uses the full arrays, so duplicates across "pages" pair correctly.

## C2. Semantic uncertainty (owner: B)

`SideCoverage` gains

```ts
/** Files (module ids) where a value of this collection family could not be resolved,
 *  e.g. an IPC call whose channel is not a literal. "*" = somewhere, file unknown. */
unresolved: ReadonlyMap<"ipc" | "bridge" | "window" | "endpoint" | "storage", ReadonlySet<string>>;
```

`compareItems` treats a one-sided item as `unknown` (not added/removed) when the other side has an
unresolved value of the same family in the item's file (or `"*"`), with the new
`UnknownItem.reason = "the other side has values there that could not be resolved"`.
A proven deletion (other side read the file, no unresolved value of that family there) stays
`removed`. Collections → family: ipcChannels, ipc, interfaces → ipc; contextBridge → bridge;
windows, webPreferences → window; endpoints, urls → endpoint; storage → storage.

## C3. Evidence references (owner: B, `report.ts`)

`ChangeRow` gains

```ts
/** Stable id: sha256 hex (first 16) of `${collection}\0${change}\0${identityKey}`; no lines. */
id: string;
/** For changed rows: where the item was read in a (before). `where` keeps the b side. */
whereBefore?: Place[];
```

`Place` gains optional `role` values `"handler" | "sender" | "receiver" | "definedIn"`, and a row
whose source position is unknown has `where: []` (never an invented line).

`ReleaseComparison` gains `completeness: Record<collection, CompareCompleteness>` and `cursor`:

```ts
/** Rows are paged per comparison: `changes` holds rows [offset, offset + limit). */
page: { offset: number; limit: number; total: number; next: number | null };
```

`compareReleases(session, a, b, { offset?, limit? })` (default limit 200; server 500). Text in
CLI, UI, report and MCP must say "N of M shown" and how to get the rest; never "all".

## C4. Interface ends (owner: A, `javascript/interfaces.ts`)

`InterfaceRow` gains `endsTotal: number` and `endsTruncated: boolean`. `direction` and `link`
are computed from **all** matching ends; `ends` keeps the first 20 sorted ones as evidence.

## C5. Policy result (owner: P, new `core/src/policy.ts`, `core/src/sarif.ts`)

Policy file (JSON, no code), validated against `docs/policy.schema.json`:

```json
{
  "hexvero": "policy", "version": 1,
  "rules": {
    "new-interface-member": { "level": "fail" },
    "new-external-host":    { "level": "fail", "allow": ["api.example.com", "*.example.com"] },
    "window-more-permissive": { "level": "fail" }
  },
  "unknown": "fail",
  "suppressions": [
    { "rule": "new-external-host", "fingerprint": "…", "reason": "…", "expires": "2026-12-31" }
  ]
}
```

`level`: `fail` | `warn` | `off`. `unknown`: `fail` (default) | `warn` | `allow`.

```ts
interface PolicyFinding {
  rule: "new-interface-member" | "new-external-host" | "window-more-permissive";
  /** sha256 hex (first 32) of `${rule}\0${semantic identity}`; independent of lines, order. */
  fingerprint: string;
  level: "fail" | "warn";
  state: "new" | "baselined" | "suppressed" | "suppression-expired";
  /** The change it is about; `row` is the ChangeRow id (C3). */
  row: string; collection: string; key: string;
  message: string;
  where: Place[];
  /** True when the finding rests on an unknown/incomplete comparison. */
  unknown: boolean;
}
interface PolicyResult {
  hexvero: "check"; version: 1;
  status: "pass" | "fail" | "incomplete" | "error";
  findings: PolicyFinding[];
  /** Coverage gaps that made the check undecidable for a rule. */
  incomplete: Array<{ rule: string; collection: string; gaps: string[] }>;
  baseline?: { file: string; created: string; matched: number };
  policy: { file: string; sha256: string };
  a: TargetRecord["info"]; b: TargetRecord["info"];
}
```

Baseline file (written only by `--update-baseline`):
`{ "hexvero": "baseline", "version": 1, "created": ISO, "policy": sha256, "a": sha256, "b": sha256, "fingerprints": [{ "rule", "fingerprint", "key" }] }`.

## C6. `hexvero check` CLI (owner: P; `packages/cli`)

`hexvero check <before> <after> --policy <file> [--baseline <file>] [--update-baseline]
[--format text|json|markdown|sarif] [--out <file>] [--force]`

Exit codes (new command only; existing commands unchanged):
`0` pass · `1` technical error (analysis failed, unreadable policy) · `2` usage / invalid policy ·
`3` policy violated · `4` incomplete (undecidable under `unknown: fail`).

## C7. Server and MCP (owners: C for server routes the UI needs, D for MCP)

- Server: `GET /api/compare?a&b&offset&limit`, `GET /api/check?a&b` with policy JSON in a POST
  body (`POST /api/check`), never reading policy paths from the client.
- MCP: at most one new tool (`hexvero_check`, catalog limit 16); `hexvero_compare` passes
  completeness through. No duplication of the one-JSON-text result.
