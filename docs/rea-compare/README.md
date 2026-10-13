# REA comparison scripts

These are the scripts behind the "Compared with REA 6.4.0" section of
[docs/benchmarks.md](../benchmarks.md), as they were run on 2026-10-13. They are a record
of the method, not a maintained benchmark suite: they expect a working directory laid out as below
and macOS (`/usr/bin/time -l`, applications under `/Applications`).

## Setup

```sh
export BENCH=/some/empty/dir EXAMPLES=/path/to/hexvero/examples
mkdir -p "$BENCH"/{bin,out,results,inputs/native,install} && cp -R . "$BENCH/scripts" && cd "$BENCH"
mv scripts/plans plans
sed -i.bak -e "s|\$EXAMPLES|$EXAMPLES|g" -e "s|\$BENCH|$BENCH|g" plans/*.json

# One Node for both tools. On Node 25, `npm install rea-agents` silently resolves to REA 4.0.1,
# because 6.4.0 does not list Node 25 in its engines field; Node 24.21.0 was used for everything.
mkdir node24 && curl -fsSL https://nodejs.org/dist/latest-v24.x/node-v24.21.0-darwin-arm64.tar.gz | tar -xz --strip-components=1 -C node24
export PATH=$PWD/node24/bin:$PATH
(cd install && npm init -y && npm install rea-agents@6.4.0 @modelcontextprotocol/sdk gpt-tokenizer)

# Wrappers so both tools are called by name with that Node.
printf '#!/bin/sh\nexec %s/node24/bin/node %s/install/node_modules/rea-agents/scripts/rea.mjs "$@"\n' "$PWD" "$PWD" > bin/rea
printf '#!/bin/sh\nexec %s/node24/bin/node %s/packages/cli/bin/hexvero.js "$@"\n' "$PWD" /path/to/built/hexvero > bin/hexvero
chmod +x bin/rea bin/hexvero

cp scripts/demo.c inputs/native/demo.c && (cd inputs/native && cc -O1 -o demo demo.c)
```

## Runs

```sh
. scripts/env.sh
node scripts/mcp-catalog.mjs rea-default -- node install/node_modules/rea-agents/scripts/rea.mjs --mcp
node scripts/mcp-catalog.mjs rea-compact REA_MCP_INPUT_SCHEMA_PROFILE=compact -- node install/node_modules/rea-agents/scripts/rea.mjs --mcp
node scripts/mcp-catalog.mjs hexvero -- hexvero mcp
node scripts/count-tokens.mjs
sh scripts/run-small.sh                      # Electron example, native program, diff: one cold and three warm runs per step
sh scripts/run-large.sh                      # installed app archives (Discord, Claude, Termius, ChatGPT; skip what you lack)
sh scripts/run-large-rea.sh ChatGPT 3600     # about 14 minutes
node scripts/summarize.mjs                   # results/runs.jsonl -> results/summary.md
for p in plans/*.json; do node scripts/mcp-task.mjs "$p"; done
```

| Script                                             | Purpose                                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `measure.mjs`                                      | one command under `/usr/bin/time -l`: wall time, peak RSS, sampled process-tree RSS, exit code, output bytes                     |
| `run-small.sh`, `run-large.sh`, `run-large-rea.sh` | the task runs; REA is tried with its default integrity policy first and repeated with `record-and-continue` only when it refuses |
| `mcp-catalog.mjs`, `count-tokens.mjs`              | `tools/list` size in bytes and in `o200k_base` tokens                                                                            |
| `mcp-task.mjs`, `plans/*.json`                     | the same task as a sequence of MCP calls: calls, latency, result bytes                                                           |
| `mkinput.mjs`, `rea-extract.mjs`                   | build the input files REA's view and compare commands need; reduce REA's evidence to the facts compared against the known answer |
| `summarize.mjs`                                    | table of all runs                                                                                                                |

Inputs (sha256): `notesdesk-1.4.0.asar` `875c2bb7…6606ed20`, `notesdesk-1.5.0.asar`
`03ee8043…6d7f4554`. The application archives were the versions installed on the test machine
(Discord `d37245e5…`, Claude `e0f0a709…`, ChatGPT `75e397e2…`) and are not redistributed, so those
rows cannot be reproduced exactly elsewhere.
