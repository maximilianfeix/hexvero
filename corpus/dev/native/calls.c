/* Corpus program: direct calls, tail calls, a function nobody calls, a function reached only
 * through a pointer. MIT licensed, written for this corpus. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define NOINLINE __attribute__((noinline))

/* Called by parse with an ordinary call. */
NOINLINE static int validate(const char *s) { return s != NULL && strlen(s) < 64; }

/* Called by main with an ordinary call (its result is used afterwards). */
NOINLINE static int parse(const char *s) {
  if (!validate(s)) return -1;
  return atoi(s) + 1;
}

/* Calls system with an ordinary call (the buffer lives on its stack). */
NOINLINE static int run_command(const char *name) {
  char buf[128];
  snprintf(buf, sizeof buf, "echo %s", name);
  return system(buf);
}

/* Its only statement returns another function's result: a tail call when optimized. */
NOINLINE static int dispatch(const char *name) { return run_command(name); }

/* Kept in the binary, called by nobody. The only user of puts. */
NOINLINE __attribute__((used)) static int unused_helper(int x) { return puts("never") + x; }

/* Reached only through the table below, never by a direct call. */
NOINLINE static int by_pointer(int x) { return x * 7 + 3; }

static int (*volatile table[])(int) = {by_pointer};

int main(int argc, char **argv) {
  int n = parse(argc > 1 ? argv[1] : "1");
  n += table[0](n);
  printf("%d\n", n);
  return dispatch(argc > 2 ? argv[2] : "world");
}
