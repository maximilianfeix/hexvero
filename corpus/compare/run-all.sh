#!/bin/sh
# The whole comparison, in order. Everything it needs comes from the environment (README.md):
#   HEXVERO_DIR  REA_PKG_DIR  MCP_SDK_DIR  COMPARE_SCRATCH  [HEXVERO_COMMIT]  [NODE]  [REPS]  [SETS]
# NODE is the Node binary that runs the scripts and both tools (default: node on PATH).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-node}
REPS=${REPS:-5}
SETS=${SETS:-dev,validation,holdout}
results=${COMPARE_RESULTS:-$here/results}
mkdir -p "$results"

# Timing discipline: wait for a 1-minute load average of at most 4, for at most 20 minutes.
: > "$results/load-wait.log"
waited=0
while :; do
  load=$(sysctl -n vm.loadavg | tr -d '{}' | awk '{ gsub(",", ".", $1); print $1 }')
  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') waited ${waited}s load1 ${load}" | tee -a "$results/load-wait.log"
  if [ "$(echo "$load <= 4" | bc)" = 1 ]; then echo "calm" >> "$results/load-wait.log"; break; fi
  if [ "$waited" -ge 1200 ]; then echo "not calm after 20 minutes: every timing is taken under load" | tee -a "$results/load-wait.log"; break; fi
  sleep 60; waited=$((waited + 60))
done

"$NODE" "$here/environment.mjs" --stage before
# A. correctness
"$NODE" "$here/observe-hexvero-pinned.mjs"
"$NODE" "$here/observe-rea.mjs"
"$NODE" "$here/observe-rea.mjs" --reuse --store-calls-as-storage --out "$results/rea.observations.alt-store.json"
# D. fixed cost of an MCP session
"$NODE" "$here/mcp-catalog.mjs" --reps "$REPS"
# B and C. the five questions, timed
rm -f "$results/cli.runs.jsonl" "$results/mcp.runs.jsonl"
"$NODE" "$here/run-cli.mjs" --reps "$REPS" --sets "$SETS"
"$NODE" "$here/run-mcp.mjs" --reps "$REPS" --sets "$SETS"
"$NODE" "$here/environment.mjs" --stage after
"$NODE" "$here/score-all.mjs"
"$NODE" "$here/summarize.mjs"
