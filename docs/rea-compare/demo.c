#include <stdio.h>
#include <stdlib.h>
#include <string.h>

__attribute__((noinline)) static int run_command(const char *name) {
  const char *shell = getenv("DEMO_SHELL");
  char buf[256];
  snprintf(buf, sizeof buf, "%s -c 'echo %s'", shell ? shell : "/bin/sh", name);
  return system(buf);
}

__attribute__((noinline)) static unsigned long checksum(const char *s) {
  unsigned long h = 5381;
  while (*s) h = h * 33 + (unsigned char)*s++;
  return h;
}

int main(int argc, char **argv) {
  const char *name = argc > 1 ? argv[1] : "world";
  printf("checksum(%s) = %lu\n", name, checksum(name));
  return run_command(name);
}
