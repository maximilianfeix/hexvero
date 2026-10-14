# Launch strategy

Date: 2026-10-14. Nothing here has been posted, submitted or sent. Every channel rule is quoted
from the channel's own page with a link, or marked **UNVERIFIED**.

**Read this first.** Hacker News asks: "Don't post generated text or AI-edited text"
([guidelines](https://news.ycombinator.com/newsguidelines.html)). DEV requires "disclosing AI
assistance if used to create content" ([code of conduct](https://dev.to/code-of-conduct)). The
drafts below are outlines of facts and order, prepared with an AI assistant. Rewrite every one in
your own words before posting, and disclose AI help where a community asks for it.

## Positioning

**Who it is for first.** Developers who use a coding agent (Claude Code, Codex, Cursor) and want a
quick, safe look at a binary, an Electron app or an APK without installing a decompiler or running
the thing. Second: application-security reviewers doing a first pass on a vendor's desktop app.
Not first: reverse engineers who live in IDA or Ghidra; for them this is a convenience at best.

**Their problem.** "What is this file, what does it expose, and should I worry?" Today that means
either reading raw strings, or installing heavy tools whose output does not fit an agent's
context, or running the app.

**Why hexvero for that job.** It never runs the target, needs nothing but Node for the first
answer, says where each fact was read and what it could not establish, and keeps answers small
enough for an agent. Its accuracy is measured on a public corpus, including a set it was never
tuned on.

**Positioning statement.** For developers and their coding agents who need to know what a piece of
software contains before trusting, running or rebuilding it, hexvero is a static first-look tool
that answers with evidence and says what it could not establish. Unlike full reverse-engineering
suites, it needs no engine and no execution for the first answer, and its answers fit an agent's
context.

**Claims you can make, with their source:**

- Never executes the target (design; nothing in the code runs a target).
- 15 MCP tools, a 14 KB catalog, about 3,300 tokens (`scripts/context-cost.mjs`).
- An Electron investigation of the corpus's hold-out app costs about 3,000 tokens (same script).
- On a public corpus with written-down answers, on a set neither tool had seen, hexvero found more
  IPC channels, window settings, preload members, endpoints and storage keys than REA 6.4.0 and
  reported far fewer false ones (`corpus/compare/summary.md`). Always say "small corpus" and
  "REA is broader".

**Claims not to make:** "safe" or "malicious" verdicts, "complete", "replaces REA/Ghidra", any
speed comparison with REA (the timings were taken under load), any star or user count, "zero
network" without saying that a cloud agent sends what it reads to its provider.

## Distribution

| Channel                                                                 | Format                                                                     | Rule (quoted)                                                                                                                                                                                                                                                   | What gets it removed                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Official MCP registry                                                   | `server.json` + `mcpName` in the npm package, then `mcp-publisher publish` | "We only remove illegal content, malware, spam, and completely broken servers." ([policy](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/moderation-policy.mdx)); the policy lists hacking tools under illegal content | describing hexvero as a hacking tool; describe it as static inspection           |
| Glama                                                                   | "Add Server", ownership via `glama.json` (added)                           | checks that the server starts and answers introspection ([CI of awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers/blob/main/.github/workflows/check-glama.yml))                                                                              | a server that does not start                                                     |
| punkpeye/awesome-mcp-servers, Security section                          | one PR, one line, alphabetical                                             | needs a Glama score badge ([CONTRIBUTING](https://github.com/punkpeye/awesome-mcp-servers/blob/main/CONTRIBUTING.md))                                                                                                                                           | duplicates, marketing text                                                       |
| Claude Code plugin marketplace                                          | the repository itself (`.claude-plugin/marketplace.json`, added)           | "Once the file is in the repository, the plugin is published, with no submission form." ([docs](https://code.claude.com/docs/en/plugins/publish))                                                                                                               | —                                                                                |
| Hacker News, Show HN                                                    | `Show HN:` title, link to the repository, a first comment by you           | "Show HN is for something you've made that other people can play with." ([rules](https://news.ycombinator.com/showhn.html)); "Please don't ask friends to upvote or comment."                                                                                   | solicited votes, a landing page, AI-written text, reposting after a quiet launch |
| doyensec/awesome-electronjs-hacking                                     | one PR in "Open-Source & Commercial Tools"                                 | "Feel free to contribute by opening a PR" ([repo](https://github.com/doyensec/awesome-electronjs-hacking))                                                                                                                                                      | an entry that reads like an ad                                                   |
| DEV or Hashnode                                                         | a technical walkthrough where the tool is a means                          | DEV: disclose AI assistance; Hashnode bans "using the platform primarily for self-promotion" ([code of conduct](https://hashnode.com/code-of-conduct))                                                                                                          | a promotional post                                                               |
| Reddit: r/ReverseEngineering, r/netsec, r/electronjs, r/mcp, r/ClaudeAI | a technical post, from an account with prior participation                 | **UNVERIFIED**: no official rules page could be fetched (403); read each sidebar by hand                                                                                                                                                                        | self-promotion from a new account                                                |
| Newsletters                                                             | an email with one paragraph and a link                                     | Console.dev: email hello@console.dev ([criteria](https://console.dev/selection-criteria)); Hackaday tips: tips@hackaday.com ([submit](https://hackaday.com/submit-a-tip/))                                                                                      | mass mailing                                                                     |
| sindresorhus/awesome-electron                                           | not yet                                                                    | "at least 100 stars" and "wait at least 30 days" ([contributing](https://github.com/sindresorhus/awesome-electron/blob/main/contributing.md))                                                                                                                   | —                                                                                |

The three most promising, in order: the MCP registry with Glama and the awesome list (durable and
where agent users look); one Show HN with a concrete example; one technical write-up on Electron
static triage that the HN post and a Reddit post can link to.

## Launch assets (outlines to rewrite)

### Show HN

Title: `Show HN: Hexvero – a static first look at binaries and Electron apps, with evidence`

First comment, in this order: the question you kept asking about files you were about to trust;
one real command and five lines of its output from `examples/`; what a filled and a hollow dot
mean; what it reads; the measured catalog size; the hold-out corpus result with the words "small
corpus"; the limits (static only, misses idioms, slower than 0.3.0 on big apps, Ghidra untested);
where REA is the better tool; what feedback you want ("where was the first answer wrong?").

### A technical article (DEV or Hashnode)

"What an Electron app tells you before you run it": take a public open-source Electron app, show
the IPC channels, the preload bridge, the window settings and the endpoints with their file and
line, explain what each means and what static reading cannot tell you. hexvero is the tool used,
not the subject. Link the corpus for accuracy.

### Reddit post (r/ReverseEngineering or r/electronjs)

A write-up, not an announcement: "Measuring a static Electron analyzer against written-down
answers": how the corpus was built, why a blind set matters, the per-class results with misses,
what was learned. Link to the repository at the end.

### X / Twitter thread (5 posts)

1. One sentence on what it is, the demo GIF.
2. The `analyze` output with locations.
3. A comparison of two builds: a setting that flipped.
4. The agent cost: 14 KB catalog, about 3,000 tokens for a full Electron investigation.
5. Limits and the link.

### LinkedIn

Three short paragraphs: the problem of trusting downloaded software, what the tool does without
running anything, the measured accuracy and its limits. Link.

### GitHub release notes

Generated from the changelog's Unreleased section by the release script; lead with continued scans
of large apps, Electron endpoints and storage, setup `--remove`, next steps, the smaller first
answer for agents, and the corpus.

### MCP directory description (under 100 characters)

`Static, execution-free inspection of binaries, Electron apps, APKs and archives, with evidence.`

## Sustainable growth

See `90-day-roadmap.md`. In short: release, list, one launch, then a steady rhythm of one useful
technical post or improvement a week, answering every issue within two days.

## Metrics

| Metric                                                   | Source                                            | Available now                                                                         |
| -------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Stars, forks                                             | GitHub repository                                 | yes                                                                                   |
| Unique visitors, clones, referrers                       | GitHub Insights → Traffic (owner only, 14 days)   | yes, to the owner                                                                     |
| npm downloads                                            | `api.npmjs.org/downloads`                         | yes                                                                                   |
| External issues and pull requests, external contributors | GitHub                                            | yes                                                                                   |
| Organic mentions                                         | search HN, Reddit, X by hand                      | by hand                                                                               |
| Setup failures, first successful analyses                | would need telemetry                              | **no, and none will be added**: hexvero has no telemetry; ask users in issues instead |
| Documentation conversion                                 | GitHub traffic to README anchors is not available | no                                                                                    |

No hidden tracking, no install pings. If a measure needs consent, ask for it in an issue or a
discussion, not in the tool.
