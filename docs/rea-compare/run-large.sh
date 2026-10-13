#!/bin/sh
# Large real app.asar inputs from /Applications. hexvero: cold + 2 warm per app (analyze summary) and one full export.
# REA: Discord and Claude here (cold + 1 warm); ChatGPT takes ~14 min, run it separately: sh scripts/run-large-rea.sh ChatGPT 3600
. "$(dirname "$0")/env.sh"; cd "$BENCH"
M="node scripts/measure.mjs"
for APP in Discord Claude Termius ChatGPT; do
  ASAR=/Applications/$APP.app/Contents/Resources/app.asar
  rm -rf "$BENCH/cache"
  $M big-hexvero-$APP-analyze-cold out/hexvero-$APP.json -- hexvero analyze "$ASAR" --json
  for i in 1 2; do $M big-hexvero-$APP-analyze-warm$i out/hexvero-$APP.json -- hexvero analyze "$ASAR" --json; done
  rm -f out/hexvero-$APP.export.json
  $M big-hexvero-$APP-export out/hexvero-$APP.export.log -- hexvero export "$ASAR" out/hexvero-$APP.export.json
  ls -l out/hexvero-$APP.export.json
done
for APP in Discord Claude; do
  ASAR=/Applications/$APP.app/Contents/Resources/app.asar
  $M big-rea-$APP-default-cold out/rea-$APP.default.json -- rea analyze-javascript-application "$ASAR" --json
  if grep -q artifact_integrity_mismatch out/rea-$APP.default.json; then P="--integrity-policy record-and-continue"; L=record-and-continue; else P=""; L=default; fi
  if [ -n "$P" ]; then $M big-rea-$APP-$L-cold out/rea-$APP.json -- rea analyze-javascript-application "$ASAR" $P --json; fi
  $M big-rea-$APP-$L-warm1 out/rea-$APP.json -- rea analyze-javascript-application "$ASAR" $P --json
done
