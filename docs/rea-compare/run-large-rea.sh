#!/bin/sh
# REA on one large app.asar: default integrity policy first; if REA refuses with artifact_integrity_mismatch
# (its documented default), repeat with --integrity-policy record-and-continue as its error message instructs.
# usage: run-large-rea.sh <AppName> [timeout-seconds]
. "$(dirname "$0")/env.sh"; cd "$BENCH"
APP=$1; LIMIT=${2:-3600}; ASAR=/Applications/$APP.app/Contents/Resources/app.asar
MEASURE_TIMEOUT_S=$LIMIT node scripts/measure.mjs big-rea-$APP-default out/rea-$APP.json -- rea analyze-javascript-application "$ASAR" --json
if grep -q artifact_integrity_mismatch out/rea-$APP.json 2>/dev/null; then
  cp out/rea-$APP.json out/rea-$APP.integrity-error.json
  MEASURE_TIMEOUT_S=$LIMIT node scripts/measure.mjs big-rea-$APP-record-and-continue out/rea-$APP.json -- rea analyze-javascript-application "$ASAR" --integrity-policy record-and-continue --json
fi
ls -l out/rea-$APP.json
