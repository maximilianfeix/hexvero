/* Corpus program (validation set): a small command dispatcher.
 *
 *   dispatch <command> [argument]
 *
 * It contains ordinary calls, returns of calls (jumps when optimized), a function that calls
 * itself, handlers reached only through a table of pointers, and a function nobody calls.
 * MIT licensed, written for this corpus. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define NOINLINE __attribute__((noinline))

struct command {
  const char *name;
  int (*run)(const char *arg);
};

struct node {
  int weight;
  struct node *left;
  struct node *right;
};

static struct node n3 = {3, NULL, NULL};
static struct node n4 = {4, NULL, NULL};
static struct node n2 = {2, &n3, NULL};
static struct node n1 = {1, &n2, &n4};
/* Read through a volatile pointer, so the compiler cannot work the sum out at build time. */
static struct node *volatile root = &n1;

/* Returns the result of puts: at -O2 the whole function is one jump to puts. */
NOINLINE static int emit(const char *text) { return puts(text); }

/* Rejects names no command can have. Calls strlen with an ordinary call (the result is compared
 * afterwards, so the call cannot become a jump). */
NOINLINE static int plausible(const char *name) {
  size_t n = strlen(name);
  return n >= 3 && n <= 6;
}

/* Walks the tree. It calls itself for both children. */
NOINLINE static int tree_sum(const struct node *n) {
  if (n == NULL) return 0;
  return n->weight + tree_sum(n->left) + tree_sum(n->right);
}

/* Handler, reached only through the table. The only user of atoi. */
NOINLINE static int cmd_double(const char *arg) { return atoi(arg) * 2 + 1; }

/* Handler, reached only through the table. The only user of getenv; ends by returning emit(). */
NOINLINE static int cmd_env(const char *arg) {
  const char *value = getenv(arg);
  return emit(value != NULL ? value : "(unset)");
}

static const struct command commands[] = {
    {"double", cmd_double},
    {"env", cmd_env},
};

/* Finds a command by name. Calls plausible and strcmp with ordinary calls. */
NOINLINE static const struct command *lookup(const char *name) {
  if (!plausible(name)) return NULL;
  for (size_t i = 0; i < sizeof commands / sizeof commands[0]; i++)
    if (strcmp(commands[i].name, name) == 0) return &commands[i];
  return NULL;
}

/* Its only statement returns emit(). */
NOINLINE static int usage(void) { return emit("usage: dispatch <double|env> [argument]"); }

/* Called by main as the last thing it does. The only user of printf. */
NOINLINE static int finish(int status) {
  int total = tree_sum(root);
  printf("status %d, weight %d\n", status, total);
  return status & 0xff;
}

/* Kept in the binary by the used attribute, called by nobody, in no table. The only user of
 * remove. */
NOINLINE __attribute__((used)) static int audit_cleanup(const char *path) { return remove(path) == 0; }

int main(int argc, char **argv) {
  if (argc < 2) return usage();
  const struct command *command = lookup(argv[1]);
  if (command == NULL) return usage();
  int status = command->run(argc > 2 ? argv[2] : "HOME");
  return finish(status);
}
