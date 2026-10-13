# Source this file from the working directory's scripts/ copy (see README.md).
# BENCH is an empty working directory you choose; EXAMPLES is this repository's examples/ folder.
: "${BENCH:?set BENCH to the benchmark working directory}"
: "${EXAMPLES:?set EXAMPLES to the examples/ directory of the hexvero repository}"
export BENCH EXAMPLES
export PATH=$BENCH/bin:$BENCH/node24/bin:$PATH   # bin/rea and bin/hexvero are exec wrappers around that Node
export HEXVERO_CACHE_DIR=$BENCH/cache/hexvero    # scratch cache, deleted before each cold run; ~/.cache/hexvero is never touched
