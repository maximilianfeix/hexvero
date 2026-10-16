---
name: hexvero-launch-proof
description: Rules for any public hexvero claim (README, site, release notes, launch posts, FAQ, directory submissions) - every claim bound to a reproducible command, a commit, a date and its limitation. Use when writing or reviewing text that leaves the repository or states numbers about hexvero.
---

# Proof for public hexvero claims

The launch kit and its rules: [docs/launch/README.md](../../../docs/launch/README.md),
[docs/launch/positioning.md](../../../docs/launch/positioning.md) ("The promise, and the proof for
each part", "Numbers you may quote", "Do not claim"), [docs/launch/faq.md](../../../docs/launch/faq.md).
Published texts in `docs/launch/published/` are kept byte-exact and excluded from the formatter.

## Every claim carries four things

| Field      | Example                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| Command    | `npx hexvero@0.8.0 demo`, `node corpus/score.mjs corpus/results/hexvero.observations.json --set holdout4` |
| Commit     | the commit or released version the command ran on (`git rev-parse --short HEAD`)                          |
| Date       | when it was run (ISO date)                                                                                |
| Limitation | what the number does not cover: corpus size, platform, engines installed, blind vs tuned set              |

A claim without all four is a draft. Keep the record next to the text (a table row, a footnote, or
the PR description).

## Rules

- Quote misses with hits; blind sets (`corpus/holdout*`) are the only accuracy numbers to lead with.
- Re-run any speed, size or token number before quoting it (`scripts/bench.mjs`,
  `scripts/context-cost.mjs`); never reuse an old measurement for a new version.
- No verdicts: not "secure", "malicious", "vulnerable", "complete", "finds all IPC", "replaces …".
- No invented users, stars, downloads, testimonials or vulnerabilities.
- "Does not execute the target" is a fact about hexvero's code; "safe to open anything" is not.
- Screenshots, GIFs and the site demo must be real output: `site/demo` comes from
  `npm run site:demo`, GIFs from `vhs docs/demo/*.tape`.
- Posting is done by the maintainer; communities that forbid generated or automated posts get
  drafts only (`docs/launch/README.md`, status table).

## Check before publishing

```bash
npm run build && node scripts/build-site-demo.mjs --check   # site demo matches the code
npx hexvero@<version> --version                             # the version the text names exists
git log -1 --format='%h %cd' --date=short                   # commit and date for the record
```
