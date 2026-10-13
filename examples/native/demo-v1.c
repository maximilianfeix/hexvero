/* hexvero example: a tiny native program in two versions (MIT). Build: cc -O0 -o demo-v1 demo-v1.c */
#include <stdio.h>
#include <stdlib.h>

const char *demo_version = "demo 1.0.0";

__attribute__((noinline)) int checksum(const char *s) {
  int h = 0;
  while (*s) h = h * 31 + *s++;
  return h;
}

__attribute__((noinline)) int run_tool(const char *command) {
  printf("running %s\n", command);
  return system(command);
}

int main(int argc, char **argv) {
  puts(demo_version);
  if (argc > 1) return run_tool(argv[1]);
  return checksum("demo") & 1;
}
