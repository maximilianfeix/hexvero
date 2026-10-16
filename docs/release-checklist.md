# Release checklist

How a release is cut, as implemented in `scripts/release.mjs` and `.github/workflows/release.yml`.
A release is a tag `vX.Y.Z` on `main`; pushing the tag is the point of no return. CONTRIBUTING.md
("Releases") has the same flow in short.

## Before cutting

| Gate                                       | How                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| CI on `main` is green                      | every job of `ci.yml`: check (Node 22, 24), tests on Windows and macOS, e2e on Linux and macOS                                 |
| e2e, examples, site demo, corpus, tarballs | part of the CI `e2e` job; `release.mjs` does **not** run `npm run e2e`, `corpus/build.mjs --check` or `corpus/gate.mjs` itself |
| Release notes written                      | under `## [Unreleased]` in `CHANGELOG.md`; `release.mjs` refuses an empty section                                              |
| npm publishing credentials                 | a trusted publisher for `release.yml` on npmjs.com, or the `NPM_TOKEN` repository secret as the fallback                       |
| Optional rehearsal                         | `npm run release:check` (check, build, `build-site-demo.mjs --check`, `release-verify.mjs`, `smoke-tarballs.mjs`)              |

## Cutting: `npm run release -- X.Y.Z [--push]`

`scripts/release.mjs`, in this order. It stops before writing anything if a precondition fails:

1. The version matches `x.y.z` or `x.y.z-pre`; the working tree is clean; the branch is `main`;
   `git pull --ff-only origin main` succeeds; the `Unreleased` section of `CHANGELOG.md` is not
   empty.
2. `npm run check` on the untouched tree.
3. Bumps the version in every versioned file:
   - `packages/{core,mcp,server,cli,web}/package.json`, and their `@hexvero/*` dependencies to the
     exact version;
   - `SERVER_VERSION` in `packages/mcp/src/index.ts`, `VERSION` in `packages/cli/src/index.ts`,
     `CORE_VERSION` in `packages/core/src/version.ts`;
   - every `"version"` in `server.json`, and `.claude-plugin/plugin.json`.
4. Removes the `unreleased-note` block from every `README*.md`.
5. Moves the notes under `## [X.Y.Z] - <today>` in `CHANGELOG.md`, leaving an empty `Unreleased`.
6. Runs the gates on the bumped tree: `npm install`, `npm run check`, `npm run build`,
   `node scripts/build-site-demo.mjs` (regenerates `site/demo`, which names the version),
   `node scripts/release-verify.mjs vX.Y.Z` (every file of step 3 agrees with the tag, the
   CHANGELOG has the section), `node scripts/smoke-tarballs.mjs` (packs, installs the tarballs into
   an empty project and exercises CLI, UI, skill and an MCP session). If any gate fails, the tree is
   restored (`git checkout -- .` and `git clean` of `examples packages scripts docs`) and nothing
   is committed.
7. Commits `chore(release): X.Y.Z` and creates the annotated tag `vX.Y.Z`, locally.
8. With `--push`: `git push --atomic origin main vX.Y.Z`. Without it, the script prints that
   command and how to undo (`git tag -d vX.Y.Z && git reset --hard HEAD~1`).

## Publishing: `.github/workflows/release.yml` on the tag

1. `verify` (no credentials, Node 24, npm 11.6.2): `npm ci`, `npm run check`, `npm run build`,
   `release-verify.mjs <tag>`, the tagged commit is an ancestor of `origin/main`,
   `smoke-tarballs.mjs --out release`, `publish-tarballs.mjs release --dry-run` (a version already
   on npm with other content stops here), release notes from the CHANGELOG section
   (`release-notes.mjs`), tarballs and manifest uploaded as an artifact.
2. `publish` (`contents: write`, `id-token: write`): the downloaded tarballs must match the
   manifest's SHA-256; a **draft** GitHub release with the tarballs; `publish-tarballs.mjs release`
   publishes in dependency order with provenance (npm dist-tag `next` for a pre-release version),
   accepts a version already published with the same integrity, and reads every package back
   from the registry until its integrity matches.
3. `registry-smoke` (no credentials): `smoke-tarballs.mjs --registry --out release`, up to six
   attempts 20 s apart for registry propagation; the installed packages must be the released
   tarballs.
4. `finalize`: the draft becomes public, `--latest` for a release, `--prerelease` for `x.y.z-pre`.

Starting the workflow by hand runs `verify` only, as a rehearsal: release-verify without a tag,
and versions already on npm are reported, not failed (`--allow-existing`).

## After a failure

- Gate failed in `release.mjs`: the tree is restored; fix on `main` and run it again.
- Tag pushed, workflow failed: use **Re-run failed jobs**. It reuses the tarballs the `verify`
  job tested; versions already on npm with identical content are accepted, a version with other
  content fails the run. A published npm version cannot be replaced; a fix ships as a new version.

## After publishing

- `npx hexvero@X.Y.Z --version` and `npx hexvero@X.Y.Z demo <dir>` from a clean directory.
- The GitHub release is public and carries the CHANGELOG section.
- Add the `unreleased-note` block back to the READMEs when `main` gains features npm does not have.
