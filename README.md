<div align="center">

<img src="docs/logo.svg" width="88" height="88" alt="hexvero logo: an amber H on charcoal">

# hexvero

**Know what changed inside your Electron release.**

Diff two builds of an Electron app and see the IPC channels, preload bridge, window settings and network hosts that changed, with file and line on both sides.

[![CI](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml/badge.svg)](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/hexvero?style=flat-square&color=F2B84B&labelColor=1B1D21)](https://www.npmjs.com/package/hexvero)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.12-F2B84B?style=flat-square&labelColor=1B1D21)](package.json)
[![License](https://img.shields.io/badge/license-MIT-F2B84B?style=flat-square&labelColor=1B1D21)](LICENSE)

[Website](https://maximilianfeix.github.io/hexvero/) · [Try it](#try-it-in-10-seconds) · [CI](#use-it-in-ci) · [AI agents](#for-ai-agents) · [Comparison](#how-it-compares) · [Limits](#accuracy-and-limits) · [Docs](#docs)

<sub>**English** · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md)</sub>

<br>

![30 seconds of real output: npx hexvero demo lists what changed between two builds of an example Electron app, including a new preload member with its preload and handler lines and an IPC channel reported as unknown; hexvero check fails the release policy with exit 3; then the local web UI opens the new member and the changed window with the source lines of both builds](docs/demo/release-review.gif)

<sub>30 seconds of real output: a terminal recording and a browser recording, joined with a fade · [mp4](docs/demo/release-review.mp4) · terminal: [`release-review-terminal.tape`](docs/demo/release-review-terminal.tape), UI: [`record-release-review.mjs`](docs/demo/record-release-review.mjs)</sub>

</div>

## Try it in 10 seconds

```bash
npx hexvero demo
```

Needs Node.js 22.12 or newer. It copies two builds of a small example app (NotesDesk 1.4.0 and 1.5.0) into `./hexvero-demo` and shows what changed. Excerpt, `…` marks cuts:

```text
What changed between notesdesk-1.4.0.asar and notesdesk-1.5.0.asar
  Two builds of a small example Electron app, read statically. Nothing was executed.

  interfaces (2)
    + preload.js::notesdesk::checkUpdate  @ b: preload.js:9, handler main.js:30 · link direct
    - preload.js::notesdesk::openInShell  @ a: preload.js:9, handler main.js:30 · link direct
  …
  ipcChannels (2)
    + update:check  @ b: receiver main.js:30, sender preload.js:9
    ? shell:open  @ a: receiver main.js:30, sender preload.js:9
        the other side has values there that could not be resolved
  windows (1)
    ~ main.js::win  @ b: main.js:8
        nodeIntegration: true → false, nodeIntegrationInEffect: "on" → "off", sandbox: false → true
  …
  endpoints (1)
    + main.js::fetch::https://updates.notesdesk.example/latest.json  @ b: main.js:30 · literal
```

`?` means hexvero could not tell, so `shell:open` is reported as unknown, not as removed. Then turn it into a gate:

```text
$ npx hexvero check hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --policy hexvero-demo/policy.json
hexvero check fail: the policy is violated
  ✗ new-interface-member  notesdesk.checkUpdate  new · fail
  ✗ new-external-host  updates.notesdesk.example  new · fail
  …
$ echo $?
3
```

`npx hexvero ui --demo --open` shows the same comparison in a local web UI with the source lines of both builds side by side. The full tour: [walkthrough](docs/walkthrough.md).

## Why

- **A release review asks what the update changed**: which channels a page can now reach, which preload members appeared, which window got more permissive, which servers the code now calls.
- **A diff of the shipped bundle does not answer that.** It is minified JavaScript inside an `app.asar`; running the app to find out is not always allowed, and a checklist scanner looks at one build, not the change.
- **hexvero answers it from the files**: each change with the file and line it was read from in both builds, what it could not establish, and a policy that fails CI on a new member, host or more permissive window. Nothing is executed.

## What it reads

|                        |                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| **IPC and bridge map** | window → `contextBridge` member → IPC channel → `ipcMain` handler, with how each link was read         |
| **Window settings**    | `webPreferences` per window, and whether `nodeIntegration` and `sandbox` are in effect                 |
| **Runtime and fuses**  | Electron, Chromium and Node versions, fuses and the ASAR integrity record, read from packaged binaries |
| **Hosts and storage**  | network endpoints and `localStorage`/`sessionStorage` keys, literal or inferred                        |
| **CI gate and SARIF**  | `hexvero check`: exit `0` pass, `3` violated, `4` not decidable; baseline, suppressions, SARIF 2.1.0   |
| **MCP for agents**     | 16 tools with small paged answers, so a coding agent can run the same review                           |
| **Local web UI**       | the comparison with both builds' source lines side by side, plus an offline HTML report                |

Inputs: an `app.asar`, a macOS `.app`, a Windows or Linux install directory, or the release `.zip` you publish. Installers (`.dmg`, setup `.exe`, AppImage) need unpacking first. Per-platform paths: [docs/cli.md](docs/cli.md).

## On your own app

```bash
npx hexvero compare old/YourApp.app new/YourApp.app --report report.html   # one offline HTML page
npx hexvero init old/YourApp.app                                            # starting policy, current hosts allowed
npx hexvero check old/YourApp.app new/YourApp.app --policy .hexvero/policy.json
```

To accept what is there today, add `--baseline .hexvero/baseline.json --update-baseline` once; later runs fail only on new findings.

One build instead of two, with the single-build checks known from Electronegativity (CSP, `shell.openExternal`, permission handlers, window settings, certificate and command-line switches):

```bash
npx hexvero audit YourApp.app --format sarif > audit.sarif   # exit 3 when a rule is violated
```

## Use it in CI

Pinned to a version so a release cannot change your results unannounced:

```yaml
jobs:
  hexvero:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7
        with:
          node-version: 24
      # Build your app and fetch the previous release here, e.g. into previous/ and dist/.
      - run: npx --yes hexvero@0.12.0 check previous/app.asar dist/app.asar --policy .hexvero/policy.json
```

Baseline, Markdown job summary and a least-privilege SARIF upload for code scanning: [docs/ci.md](docs/ci.md).

## For AI agents

In Claude Code, server and skill come as one plugin:

```text
/plugin marketplace add maximilianfeix/hexvero
/plugin install hexvero@hexvero
```

Elsewhere, `npx hexvero setup --apply` registers the MCP server with the coding agents it finds (dry run without `--apply`), or run `npx -y hexvero@0.12.0 mcp` over stdio. Text inside the target is treated as data, never as instructions. Clients, tools and what an agent receives: [docs/mcp.md](docs/mcp.md).

## How it compares

|                                                | hexvero                         | [Electronegativity](https://github.com/doyensec/electronegativity) | [REA](https://github.com/morluto/rea)         | `diff` of two bundles |
| ---------------------------------------------- | ------------------------------- | ------------------------------------------------------------------ | --------------------------------------------- | --------------------- |
| Built for                                      | what changed between two builds | known risky patterns in one build                                  | broad reverse engineering, static and dynamic | any text change       |
| Compares two builds of one app                 | yes, list by list               | no (one build; checks between Electron versions)                   | yes (`compare_application_versions`)          | yes, minified bytes   |
| Bridge member → IPC channel, blind `holdout2`  | 65 of 78                        | not measured                                                       | 6 of 66                                       | no                    |
| Release policy with CI exit codes              | yes (`0`/`3`/`4`, SARIF)        | SARIF output                                                       | not compared                                  | no                    |
| CSP, `shell.openExternal`, permission handlers | yes, `hexvero audit` (0.12)     | yes                                                                | not compared                                  | no                    |
| Status                                         | active, MIT                     | archived 2026-10-24, last release 2023                             | active                                        | n/a                   |

Electronegativity was archived on 2026-10-24. `hexvero audit <build>` runs part of its single-build checks with the same exit codes and SARIF as `check`; which checks are covered and which are not is listed in [the migration page](https://maximilianfeix.github.io/hexvero/compare/electronegativity/). REA does much that hexvero does not (dynamic analysis, devices, decompilers); use it for that. Sources, dates and every caveat: [docs/comparison.md](docs/comparison.md).

## Accuracy and limits

On the newest blind set, written by someone without access to hexvero, it found 52 of 64 IPC channels with none false, and it misses and misreports rows in other lists ([all numbers](docs/accuracy.md)). On real releases it is checked against the source ([GitHub Desktop 3.6.7 → 3.6.10](docs/case-studies/github-desktop-3.6.7-to-3.6.10.md), [Electron Fiddle 0.38 → 0.39](docs/case-studies/electron-fiddle-0.38.0-to-0.39.0.md)), misses included. It reads files and never runs them, so a finding is what the code contains, not what it does at run time or whether it is exploitable; a passing check is not a security verdict. Parsing a hostile file still processes attacker-controlled bytes, within size, depth and time limits. The full list: [docs/accuracy.md](docs/accuracy.md#limits).

## Docs

[Walkthrough](docs/walkthrough.md) · [CLI](docs/cli.md) · [CI](docs/ci.md) · [MCP](docs/mcp.md) · [Policy schema](docs/policy.schema.json) · [Electron rules and sources](docs/electron-findings.md) · [Accuracy](docs/accuracy.md) · [Benchmarks](docs/benchmarks.md) · [Other formats](docs/formats.md) (native binaries, APK, WebAssembly and more) · [Changelog](CHANGELOG.md)

<details><summary><b>FAQ: does it run or upload my files?</b></summary>

No. Targets are parsed as bytes; nothing is executed. The UI binds to 127.0.0.1 with a per-session token. There is no telemetry and no network call in the code base. Through a cloud-hosted agent, the results that agent requests go to its model provider like any other tool output. Use hexvero only on software you may examine ([DISCLAIMER.md](DISCLAIMER.md)).

</details>

## Contributing

```bash
npm install && npm run check      # typecheck, lint, format, unit tests, shape rules
npm run e2e                       # the user flows on real inputs
```

Rules in [CONTRIBUTING.md](CONTRIBUTING.md); `good first issue` is sized for an afternoon. Found a wrong or missing fact? [Open a bug report](https://github.com/maximilianfeix/hexvero/issues/new?template=bug.yml) with `hexvero doctor` output and, if you can, the file.

If hexvero showed you something you would have missed in a release, a ⭐ helps the next Electron team find it.

## License

MIT
