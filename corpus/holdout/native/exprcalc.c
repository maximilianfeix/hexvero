/* Corpus program (hold-out set): a calculator for integer expressions.
 *
 *   exprcalc "2 * (3 + 4) - -5" [trace]
 *
 * The tokenizer is a state machine whose states are functions in a table. The parser is a
 * recursive-descent parser (expression -> term -> factor -> expression) that reports what it
 * does to a visitor, a pair of callbacks chosen at run time. The program has ordinary calls,
 * returns of calls (jumps when optimized), functions reached only through pointers, and a
 * function nobody calls.
 * MIT licensed, written for this corpus. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define NOINLINE __attribute__((noinline))

enum token { TOK_NUMBER, TOK_OPERATOR, TOK_OPEN, TOK_CLOSE, TOK_END, TOK_BAD };

struct lexer {
  const char *at;
  enum token kind;
  long number;
  char operator;
};

/* A state looks at the input and returns the index of the next state, or -1 when a token is
 * complete. */
typedef int (*state_fn)(struct lexer *);

enum { STATE_BLANK, STATE_DIGITS, STATE_PUNCTUATION };

struct visitor {
  void (*number)(long value);
  void (*binary)(char operator, long result);
};

struct parser {
  struct lexer lexer;
  const struct visitor *visitor;
  int errors;
};

static int steps;

/* ---- tokenizer states: each is reached only through the table below ---- */

/* Skips blanks and decides which state reads the token. */
NOINLINE static int state_blank(struct lexer *lx) {
  while (*lx->at == ' ' || *lx->at == '\t') lx->at++;
  if (*lx->at >= '0' && *lx->at <= '9') return STATE_DIGITS;
  return STATE_PUNCTUATION;
}

/* Reads a number. The only user of strtol. */
NOINLINE static int state_digits(struct lexer *lx) {
  char *end;
  lx->number = strtol(lx->at, &end, 10);
  lx->at = end;
  lx->kind = TOK_NUMBER;
  return -1;
}

/* Reads one character. The only user of strchr. */
NOINLINE static int state_punctuation(struct lexer *lx) {
  char c = *lx->at;
  if (c == '\0') {
    lx->kind = TOK_END;
    return -1;
  }
  lx->at++;
  lx->operator = c;
  if (c == '(') lx->kind = TOK_OPEN;
  else if (c == ')') lx->kind = TOK_CLOSE;
  else lx->kind = strchr("+-*/", c) != NULL ? TOK_OPERATOR : TOK_BAD;
  return -1;
}

static const state_fn states[] = {state_blank, state_digits, state_punctuation};

/* Runs the state machine until one token is complete. The call is through the table. */
NOINLINE static void next_token(struct lexer *lx) {
  int state = STATE_BLANK;
  while (state >= 0) state = states[state](lx);
}

/* ---- visitors: reached only through a struct visitor ---- */

/* The only users of printf with these formats; printf is also called by report. */
NOINLINE static void trace_number(long value) { printf("push %ld\n", value); }
NOINLINE static void trace_binary(char operator, long result) {
  printf("%c -> %ld\n", operator, result);
}

NOINLINE static void count_number(long value) { steps += value != 0; }
NOINLINE static void count_binary(char operator, long result) {
  steps += operator != 0 || result != 0;
}

static const struct visitor tracing = {trace_number, trace_binary};
static const struct visitor counting = {count_number, count_binary};

/* ---- parser ---- */

static long parse_expression(struct parser *p);

/* Does the arithmetic. Calls nothing. */
NOINLINE static long apply(char operator, long left, long right) {
  switch (operator) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    default: return right == 0 ? 0 : left / right;
  }
}

/* factor := number | '(' expression ')' | '-' factor
 * Calls parse_expression for a parenthesis (the recursion closes here) and itself for a sign. */
NOINLINE static long parse_factor(struct parser *p) {
  if (p->lexer.kind == TOK_NUMBER) {
    long value = p->lexer.number;
    p->visitor->number(value);
    next_token(&p->lexer);
    return value;
  }
  if (p->lexer.kind == TOK_OPEN) {
    next_token(&p->lexer);
    long value = parse_expression(p);
    if (p->lexer.kind != TOK_CLOSE) p->errors++;
    next_token(&p->lexer);
    return value;
  }
  if (p->lexer.kind == TOK_OPERATOR && p->lexer.operator == '-') {
    next_token(&p->lexer);
    return -parse_factor(p);
  }
  p->errors++;
  return 0;
}

/* term := factor { ('*' | '/') factor } */
NOINLINE static long parse_term(struct parser *p) {
  long value = parse_factor(p);
  while (p->lexer.kind == TOK_OPERATOR && (p->lexer.operator == '*' || p->lexer.operator == '/')) {
    char operator = p->lexer.operator;
    next_token(&p->lexer);
    value = apply(operator, value, parse_factor(p));
    p->visitor->binary(operator, value);
  }
  return value;
}

/* expression := term { ('+' | '-') term } */
NOINLINE static long parse_expression(struct parser *p) {
  long value = parse_term(p);
  while (p->lexer.kind == TOK_OPERATOR && (p->lexer.operator == '+' || p->lexer.operator == '-')) {
    char operator = p->lexer.operator;
    next_token(&p->lexer);
    value = apply(operator, value, parse_term(p));
    p->visitor->binary(operator, value);
  }
  return value;
}

static int failed;

/* Parses the whole text. The parser lives on this function's stack, so its calls are ordinary
 * calls at every level. */
NOINLINE static long evaluate(const char *text, const struct visitor *visitor) {
  struct parser p = {.lexer = {.at = text}, .visitor = visitor, .errors = 0};
  next_token(&p.lexer);
  long value = parse_expression(&p);
  if (p.lexer.kind != TOK_END) p.errors++;
  failed = p.errors;
  return value;
}

/* ---- output ---- */

/* Writes a message to standard error. Its only statement returns what fputs returns: when
 * optimized the function loads stderr and jumps to fputs. The only user of fputs. */
NOINLINE static int complain(const char *message) { return fputs(message, stderr); }

/* Called by main as the last thing it does. One exit returns complain(), the other prints.
 * main also returns complain() itself when it is given too many arguments. */
NOINLINE static int report(long value) {
  if (failed) return complain("exprcalc: syntax error\n");
  printf("%ld (%d steps)\n", value, steps);
  return 0;
}

/* Kept in the binary by the used attribute, called by nobody, in no table. The only user of
 * getenv and of atoi. */
NOINLINE __attribute__((used)) static int debug_level(void) {
  const char *level = getenv("EXPRCALC_DEBUG");
  return level != NULL ? atoi(level) : 0;
}

int main(int argc, char **argv) {
  if (argc > 3) return complain("usage: exprcalc <expression> [trace]\n");
  const struct visitor *visitor = argc > 2 ? &tracing : &counting;
  long value = evaluate(argc > 1 ? argv[1] : "1 + 2 * 3", visitor);
  return report(value);
}
