# A release gate for Electron apps: fail CI when a build exposes something new to pages

_Second technical article, draft. The first one ("What changed in this Electron update?") is
already published on DEV ([published/devto.md](published/devto.md)); do not post this one on DEV
as a second article on the same topic, and do not reuse its text. Written with an AI assistant
from the maintainer's notes and real command output (sources: [claims.md](claims.md)); rewrite it
in your own words and disclose the assistance where the platform asks for it. Not posted._

The first article showed how to read what changed between two builds of an Electron app. This
one is about the step after reading: making the build fail when a change does something your
team has not agreed to. Three kinds of change are worth a gate in most Electron apps:

1. a new member that pages can call through the preload bridge,
2. a new external host the code talks to,
3. a window whose pages may do more than before (`nodeIntegration`, `contextIsolation`,
   `sandbox`).

Everything below runs with Node 22.12+ and [hexvero](https://github.com/maximilianfeix/hexvero)
0.9.6, on two synthetic builds that ship with it. Nothing is executed; both archives are only
read.

## 1. Two releases and a policy

```bash
npx hexvero@0.9.6 demo > /dev/null; ls hexvero-demo
```

```text
notesdesk-1.4.0.asar    notesdesk-1.5.0.asar    policy.json
```

The policy is JSON, data only:

```json
{
  "hexvero": "policy",
  "version": 1,
  "rules": {
    "new-interface-member": { "level": "fail" },
    "new-external-host": {
      "level": "fail",
      "allow": ["api.notesdesk.example", "telemetry.notesdesk.example", "*.cdn.notesdesk.example"]
    },
    "window-more-permissive": { "level": "fail" }
  },
  "unknown": "fail",
  "suppressions": []
}
```

## 2. What changed, and where it was read

```bash
A=hexvero-demo/notesdesk-1.4.0.asar B=hexvero-demo/notesdesk-1.5.0.asar
npx hexvero@0.9.6 compare $A $B --report report.html | head -10
```

```text
  interfaces (2)
    + preload.js::notesdesk::checkUpdate  @ b: preload.js:9, handler main.js:30 · link direct
    - preload.js::notesdesk::openInShell  @ a: preload.js:9, handler main.js:30 · link direct
  contextBridge (2)
    + notesdesk::checkUpdate  @ b: preload.js:9
    - notesdesk::openInShell  @ a: preload.js:9
  ipcChannels (2)
    + update:check  @ b: receiver main.js:30, sender preload.js:9
    ? shell:open  @ a: receiver main.js:30, sender preload.js:9
        the other side has values there that could not be resolved
```

Two places for the new member: the preload line that exposes it and the main-process handler on
its channel. `link direct` means both name the same literal channel, so the join is not a guess.

The `?` row is the part I care most about. `shell:open` is in 1.4.0 and not found in 1.5.0. A
naive diff calls that "removed". But 1.5.0 registers IPC handlers whose names come from an
environment variable:

```text
! b: 1 IPC call(s) pass a channel that is not a literal or a constant that could be followed
  (a parameter, a computed value). … ipcMain.handle at main.js:33 (evaluation stopped: runtime
  value: process). (ipc_channel_unresolved)
```

So the honest answer is "unknown": the other build has a channel in that file whose name a static
reading cannot know. hexvero 0.8.0 printed `- shell:open` for the same pair; since 0.9.0 it does not.

`report.html` is one offline file (33,298 bytes here) with the source lines of both builds next to
each changed row; for the window change, `main.js:8` from 1.4.0 and from 1.5.0.

## 3. The gate

```bash
npx hexvero@0.9.6 check $A $B --policy hexvero-demo/policy.json; echo "exit $?"
```

```text
hexvero check fail: the policy is violated
  before notesdesk-1.4.0.asar · after notesdesk-1.5.0.asar · policy policy.json

  ✗ new-interface-member  notesdesk.checkUpdate  new · fail
      New interface member notesdesk.checkUpdate is exposed to pages.
      @ b: preload.js:9, handler main.js:30 · link direct · fingerprint 40aa15f76bfd9988f9302d187c03c61d
  ✗ new-external-host  updates.notesdesk.example  new · fail
      New external host updates.notesdesk.example, not in the allow list (https://updates.notesdesk.example/latest.json).
      @ b: main.js:30 · literal · fingerprint 68312dcec55422c3b8affec165b21b83

  Accept what is there now: add --baseline <file> --update-baseline, or a suppression with the fingerprint and a reason in the policy.
exit 3
```

The window change is not a finding: 1.5.0 turned `nodeIntegration` off and `sandbox` on, which is
less permissive. The rule only fires on the opposite direction, and on a new or renamed window
whose own settings already let its pages do more.

Exit codes are the contract with CI: `0` pass, `1` technical error, `2` usage or invalid policy,
`3` violated, `4` not decidable.

## 4. Unknown is not a pass

Exit `4` is the design decision behind the tool. If a rule meets something it cannot decide (a
host built as `` `https://${region}.example.com` ``, a preload bridge it could not read, an app
read only in part), `"unknown": "fail"` makes the check `incomplete` instead of green. You can
choose `"warn"` for an app where that is accepted; the gaps stay listed either way. In this
example the unresolved channel at `main.js:33` does not make `new-interface-member` undecidable,
because which members a preload exposes is read from the bridge itself.

## 5. Accepting what is there

```bash
npx hexvero@0.9.6 check $A $B --policy hexvero-demo/policy.json \
  --baseline .hexvero/baseline.json --update-baseline
```

```text
✓ wrote .hexvero/baseline.json: 2 finding(s) accepted
```

Then the same check without `--update-baseline` passes (exit `0`). Fingerprints are built from what
a finding is about (the member, the host, the window setting), never from lines, so a baseline
survives code moving. A one-off exception is a suppression with the fingerprint, a reason and an
`expires` date; after that date the finding counts as new again, even if a baseline accepted it.

## 6. In GitHub Actions

```yaml
- name: hexvero check
  run: |
    set +e
    npx --yes hexvero@0.9.6 check previous/app.asar dist/app.asar \
      --policy .hexvero/policy.json --baseline .hexvero/baseline.json \
      --format sarif --out hexvero.sarif
    code=$?
    set -e
    npx --yes hexvero@0.9.6 check previous/app.asar dist/app.asar \
      --policy .hexvero/policy.json --baseline .hexvero/baseline.json \
      --format markdown >> "$GITHUB_STEP_SUMMARY" || true
    exit "$code"
```

The full workflow (pinned actions, `contents: read`, the SARIF upload in a separate job with
`security-events: write`, skipped for forks) is in
[docs/ci.md](https://github.com/maximilianfeix/hexvero/blob/main/docs/ci.md). SARIF locations are
paths inside the analyzed build (`hexvero-build/after/notesdesk-1.5.0.asar/preload.js`, line 9),
never mapped onto your repository's files, because a bundled `main.js` is not your
`src/main.ts`.

## What this gate does not do

- It is static. A pass means nothing new against the policy in what was read, not that the app
  cannot do these things at run time, and nothing here is a vulnerability verdict.
- It misses things, and it can be wrong. On the newest blind set (one screenshot annotator in
  three builds and a later version, written by someone without access to hexvero, measured once)
  it found 52 of 64 IPC channels and 22 of 41 storage keys with none false, but 44 of 52 window
  settings with 15 false; all 15 were duplicate rows of literals that were right for their
  window, fixed after that measurement
  ([round 5](https://github.com/maximilianfeix/hexvero/blob/main/corpus/results/round5/README.md)).
  On the blind set before it, only 14 of 39 window settings were found
  ([round 4](https://github.com/maximilianfeix/hexvero/blob/main/corpus/results/round4/README.md)).
  A window rule that cannot read the settings is exactly where exit 4 matters.
- On a real app, Electron Fiddle 0.38.0 → 0.39.0, a check with 0.8.0 found no false change but
  missed four changes: a new field in an IPC payload, a new storage key behind the app's own
  wrapper, the request of a bundled CLI, and that CLI's file. 0.9.6 reports all four, each checked
  against Fiddle's source
  ([case study](https://github.com/maximilianfeix/hexvero/blob/main/docs/case-studies/electron-fiddle-0.38.0-to-0.39.0.md)).
  It still does not read what a handler takes from a payload.
- It costs time: the analyses added for this make a scan of Discord's `app.asar` about 24 %
  slower than 0.8.0 (769 → 953 ms).
- Other tools compare versions too (REA documents `compare_application_versions`) and
  Electronegativity writes SARIF for single-build checks. What this adds is the Electron release
  delta with the line behind each change, unknowns kept apart, and a policy with baselines on
  top of it.

## Try it on your app

```bash
npx hexvero@0.9.6 compare old/app.asar new/app.asar --report report.html
npx hexvero@0.9.6 check old/app.asar new/app.asar --policy .hexvero/policy.json
```

Use it on software you own or may examine. A bug report with a wrong or missing fact (and the
file or a minimal reproduction) is the most useful feedback.
