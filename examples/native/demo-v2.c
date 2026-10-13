/* hexvero example: version 2 adds read_config() (getenv) and changes the version string. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

const char *demo_version = "demo 1.1.0";

__attribute__((noinline)) int checksum(const char *s) {
  int h = 0;
  while (*s) h = h * 31 + *s++;
  return h;
}

__attribute__((noinline)) const char *read_config(void) {
  const char *value = getenv("DEMO_CONFIG");
  return value && strlen(value) ? value : "default";
}

__attribute__((noinline)) int run_tool(const char *command) {
  printf("running %s with %s\n", command, read_config());
  return system(command);
}

int main(int argc, char **argv) {
  puts(demo_version);
  if (argc > 1) return run_tool(argv[1]);
  return checksum(read_config()) & 1;
}
