# hexvero check in CI

`hexvero check` compares the build you are about to ship with the one you shipped last and
fails when the change does something your policy does not allow: a new member exposed to pages,
a new external host, a window whose pages may do more. It reads both builds statically; nothing
is executed. The command, the policy file and the exit codes are described in
[cli.md](cli.md#release-policies-hexvero-check).

| Exit | Meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| `0`  | pass                                                                          |
| `1`  | technical error: a build could not be analyzed, the policy could not be read  |
| `2`  | usage error or invalid policy (the message names each problem and its path)   |
| `3`  | the policy is violated                                                        |
| `4`  | not decidable: a rule at level `fail` met an unknown, and `unknown` is `fail` |

## Set up

1. Put a policy in your repository, for example `.hexvero/policy.json`, starting from
   [`examples/policy.json`](../examples/policy.json). List the hosts your app is expected to talk
   to under `rules.new-external-host.allow`.
2. Decide which build is "before": the last released build (download it from your release
   storage) or the build of the base branch. hexvero reads `.asar` archives, application
   directories, and the other formats listed in [cli.md](cli.md).
3. Run the check once locally and accept what is already there:

   ```bash
   npx hexvero@latest check previous/app.asar dist/app.asar \
     --policy .hexvero/policy.json --baseline .hexvero/baseline.json --update-baseline
   ```

   Commit `.hexvero/baseline.json`. From then on only new findings fail the check. CI never
   writes the baseline; accepting a finding is always an explicit commit.

4. Add the workflow below.

## GitHub Actions

Pin hexvero to a version so a new release cannot change your results unannounced. Grant the job
only `contents: read`; the SARIF upload needs `security-events: write` and is a separate job,
skipped for pull requests from forks (their token cannot write security events).

```yaml
name: Release policy

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7
        with:
          node-version: 24
      # Build your app and fetch the previous release here, e.g. into previous/ and dist/.
      - name: hexvero check
        run: |
          set +e
          npx --yes hexvero@0.8.0 check previous/app.asar dist/app.asar \
            --policy .hexvero/policy.json --baseline .hexvero/baseline.json \
            --format sarif --out hexvero.sarif
          code=$?
          set -e
          npx --yes hexvero@0.8.0 check previous/app.asar dist/app.asar \
            --policy .hexvero/policy.json --baseline .hexvero/baseline.json \
            --format markdown >> "$GITHUB_STEP_SUMMARY" || true
          exit "$code"
      - if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: hexvero-sarif
          path: hexvero.sarif
          if-no-files-found: ignore

  upload:
    needs: check
    if: >-
      always() &&
      (github.event_name != 'pull_request' ||
       github.event.pull_request.head.repo.full_name == github.repository)
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4
        with:
          name: hexvero-sarif
      - uses: github/codeql-action/upload-sarif@b96794f015dfd88f77b49b1c93e0fa7110f94c63 # v4.38.0
        with:
          sarif_file: hexvero.sarif
          category: hexvero-check
```

This repository runs the same steps on its two synthetic example builds in
[`.github/workflows/check-example.yml`](../.github/workflows/check-example.yml) (expected exit:
`3`), and `npm run e2e` runs that workflow's command and validates its SARIF output against the
SARIF 2.1.0 schema.

## What the SARIF file says, and what it does not

- Locations are paths **inside the analyzed build** (`main.js` inside `app.asar`), with
  `uriBaseId: HEXVERO_TARGET_B` for the after build and `HEXVERO_TARGET_A` for the before build.
  `originalUriBaseIds` and the run's `properties.hexvero.locations` say so. hexvero does not map
  them onto files of your repository, so a code-scanning alert shows the path and line but cannot
  open a source file; a bundled `main.js` is not your `src/main.ts`.
- A place without a recorded line has no `region`; hexvero never invents a line.
- `partialFingerprints` carries the semantic fingerprint (`hexveroFingerprint/v1`, and as
  `primaryLocationLineHash`, which code scanning keys alerts on), so one alert stays one alert
  when code moves.
- Only findings that count (`new`, `suppression-expired`) are results. Baselined and suppressed
  findings are counted in `properties.hexvero.notReported`, because code scanning ignores SARIF
  suppressions and would reopen them as alerts.
- Coverage gaps appear as `toolExecutionNotifications` and in `properties.hexvero.incomplete`.

## Reading the result

- **Fail on a host you expect**: add it to `allow`, or, for a one-off, a suppression with the
  fingerprint from the output, a reason and an `expires` date.
- **Exit 4**: hexvero could not decide a rule, for example because an IPC channel name is
  computed at run time. The text output lists the gaps under "Not decidable". Fix the cause
  (`hexvero analyze <path> --all` for a large app read in part), or set `"unknown": "warn"` when
  you accept that the rule cannot be decided for this app. The gaps stay listed either way.
- A pass means hexvero found nothing new against the policy in what it read. It is not a proof
  that the app cannot do these things at run time.
