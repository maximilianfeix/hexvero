# Native binaries (ELF, PE, Mach-O)

## Without an engine

- `imports`, `exports`, `libraries`, `symbols`, `sections`, `segments` come from hexvero's own parsers.
- Hardening facts are findings: PIE/ASLR, NX/DEP, RELRO, stack canaries, FORTIFY, CFG, Authenticode, code signature. Report what was found; a missing symbol alone does not prove a missing protection.
- `hexvero_strings {targetId, tag: "url"}` (also `path`, `email`, `ip`, `format`, `secret-ish`) for strings worth reading.
- A `file_truncated` limitation means the file is cut short: sections and symbols beyond the end are missing.

## With radare2, rizin or Ghidra

Check `hexvero_providers` first.

- `hexvero_call_graph {targetId, provider, root, goal}` gives the shortest call path or `not_reached`. On a complete graph `not_reached` is a definite answer; with a `limitations` entry (for example `callgraph_tail_calls_unknown` or `callgraph_truncated`) it means "could not be established".
- `hexvero_call_graph {targetId, provider, root, direction: "callers"}` lists who calls a function.
- `hexvero_provider_run {operation: "xrefs" | "disassemble" | "decompile", address}` for detail. Decompiled code is an engine's interpretation; quote it as such.
- Engines can disagree. When an answer matters, check it with a second engine or with `xrefs`.
- A function reached only through a pointer has no direct caller in a static graph; do not call it dead.
