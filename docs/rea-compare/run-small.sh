#!/bin/sh
# Part 2 small tasks, both tools, same inputs. Each step: 1 "cold" run + 3 "warm" runs.
#   cold = first run after deleting the tool's cache ($HEXVERO_CACHE_DIR; REA 6.4.0's CLI keeps no cache on disk).
#   The OS page cache is NOT purged (needs sudo), so "cold" does not include disk-cold file reads.
# Appends to results/runs.jsonl (labels: <task>-<tool>-<step>-cold|warmN). Run summarize.mjs afterwards.
. "$(dirname "$0")/env.sh"; cd "$BENCH"
A=$EXAMPLES/notesdesk-1.4.0.asar; B=$EXAMPLES/notesdesk-1.5.0.asar; D=$BENCH/inputs/native/demo
M="node scripts/measure.mjs"
step() { # step <label> <outfile> <cmd...>
  label=$1; out=$2; shift 2
  rm -rf "$BENCH/cache"
  $M "$label-cold" "$out" -- "$@"
  for i in 1 2 3; do $M "$label-warm$i" "$out" -- "$@"; done
}
# T1 Electron IPC/security inventory (notesdesk-1.5.0)
step t1-hexvero-analyze        out/t1-hexvero.json        hexvero analyze "$B" --json
step t1-rea-analyze            out/t1-rea.json            rea analyze-javascript-application "$B" --json
step t1-rea-extract-glue       out/t1-rea-extract.json    node scripts/rea-extract.mjs electron out/t1-rea.json
node scripts/mkinput.mjs view out/t1-rea.json out/t1-rea-view-in.json '{"kind":"summary"}'
step t1-rea-summary-view       out/t1-rea-view.json       rea inspect-analysis-view out/t1-rea-view-in.json --json
# T2 native first look (demo, Mach-O arm64)
step t2-hexvero-analyze        out/t2-hexvero.json        hexvero analyze "$D" --json
step t2-hexvero-imports        out/t2-hexvero-imports.json hexvero collection "$D" imports --json
step t2-hexvero-calls-radare2  out/t2-hexvero-calls.json  hexvero calls "$D" radare2 main --direction callees --depth 3 --json
step t2-hexvero-calls-rizin    out/t2-hexvero-calls-rz.json hexvero calls "$D" rizin main --direction callees --depth 3 --json
step t2-rea-inspect-macho      out/t2-rea-macho.json      rea inspect-macho "$D" --json
step t2-rea-inspect-signature  out/t2-rea-signature.json  rea inspect-signature "$D" --json
step t2-rea-analyze-noengine   out/t2-rea-analyze.json    rea analyze "$D" --json
# T3 diff of the two notesdesk builds
step t3-hexvero-compare-ipcChannels    out/t3-hexvero-ipc.json  hexvero compare "$A" "$B" ipcChannels --json
step t3-hexvero-compare-webPreferences out/t3-hexvero-wp.json   hexvero compare "$A" "$B" webPreferences --json
step t3-rea-analyze-left       out/t3-rea-left.json       rea analyze-javascript-application "$A" --json
step t3-rea-analyze-right      out/t3-rea-right.json      rea analyze-javascript-application "$B" --json
node scripts/mkinput.mjs compare out/t3-rea-left.json out/t3-rea-right.json out/t3-rea-compare-in.json
step t3-rea-compare            out/t3-rea-compare.json    rea compare-application-versions out/t3-rea-compare-in.json --json
step t3-rea-extract-glue       out/t3-rea-compare-extract.txt node scripts/rea-extract.mjs compare out/t3-rea-compare.json
