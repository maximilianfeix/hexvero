# Overnight log (2026-10-14/15)

Every distribution and release action, with its real link and status. Status words: DONE,
PUBLISHED, PENDING, BLOCKED, REJECTED, NOT ATTEMPTED. Outcomes are only what was observed.

## Starting point (2026-10-14 21:45 CEST)

- GitHub: 3 stars, 0 forks; 96 views by 3 unique visitors in 14 days, all from github.com.
- npm: the downloads API reports nothing for `hexvero` yet.

## Actions

| Time (CEST) | Destination                         | Link                                                               | Angle                                                                               | Status        | Result                                                   |
| ----------- | ----------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------- |
| 21:05       | hexvero PR, rounds 3 to 5           | https://github.com/maximilianfeix/hexvero/pull/89                  | accuracy, speed, security; first CI run on Linux, Windows, macOS                    | DONE (merged) | Windows failed once (CRLF, chmod test), fixed; all green |
| 21:25       | Release 0.4.0                       | https://github.com/maximilianfeix/hexvero/releases/tag/v0.4.0      | npm with provenance                                                                 | PUBLISHED     | registry install test passed                             |
| 21:30       | doyensec/awesome-electronjs-hacking | https://github.com/doyensec/awesome-electronjs-hacking/pull/11     | Electron static inventory with file and line                                        | PENDING       |                                                          |
| 21:38       | TensorBlock/awesome-mcp-servers     | https://github.com/TensorBlock/awesome-mcp-servers/pull/3793       | MCP server, Security section                                                        | PENDING       |                                                          |
| 21:44       | Official MCP registry               | https://registry.modelcontextprotocol.io/v0/servers?search=hexvero | `io.github.maximilianfeix/hexvero` 0.4.0, published by CI with GitHub OIDC (PR #90) | PUBLISHED     | listed                                                   |
| 21:20       | Repository homepage                 | https://maximilianfeix.github.io/hexvero/                          | hexvero.dev serves a wrong certificate; homepage fields moved to working addresses  | DONE          |                                                          |

## Checked and not done

| Destination                        | Why                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| punkpeye/awesome-mcp-servers       | requires a Glama score badge; adding a server to Glama needs an account (sign-up with CAPTCHA or OAuth), which the agent may not create. BLOCKED until the owner adds hexvero on glama.ai. Its CONTRIBUTING also contains an instruction addressed to automated agents (an emoji marker in the PR title); not acted on. |
| hesreallyhim/awesome-claude-code   | recommendations only through the web issue form, made by a human, and at least 100 stars. NOT ATTEMPTED.                                                                                                                                                                                                                |
| analysis-tools-dev/static-analysis | needs at least 20 stars and a contributor minimum; hexvero has 3 stars. NOT ATTEMPTED until it qualifies.                                                                                                                                                                                                               |
| modelcontextprotocol/servers       | accepts issues only, no pull requests. NOT ATTEMPTED.                                                                                                                                                                                                                                                                   |
| wong2/awesome-mcp-servers          | no pull requests; submissions through mcpservers.org. PENDING (form).                                                                                                                                                                                                                                                   |
| sindresorhus/awesome-electron      | 100 stars and 30 days since the first release required. NOT ATTEMPTED.                                                                                                                                                                                                                                                  |
| docker/mcp-registry                | expects a containerised server; hexvero reads local files. NOT ATTEMPTED (poor fit).                                                                                                                                                                                                                                    |
| Reddit                             | the browser blocks reddit.com and the public rules endpoint returns a bot check, so no subreddit's current rules could be verified. BLOCKED; drafts in `docs/growth/`.                                                                                                                                                  |
| DEV (dev.to)                       | its guidelines say AI-assisted articles should not promote any program "including your own". An AI-written article about hexvero would break that. NOT ATTEMPTED; a draft for the owner to rewrite.                                                                                                                     |
| Hacker News                        | AI-written submissions and comments are not allowed. NOT ATTEMPTED; facts and outline for a human-written Show HN.                                                                                                                                                                                                      |
