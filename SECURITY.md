# Security

## Reporting a vulnerability

Report privately through GitHub's security advisories on this repository
(**Security → Report a vulnerability**), not in a public issue. Include the target file or a
minimal reproduction, the exact command, your hexvero and Node.js versions, and what happened. You
will get an answer within a few days; a fix and an advisory follow as soon as one is ready.

Only the latest release receives security fixes.

## What counts

hexvero reads untrusted files by design, so these are in scope:

- a crafted input that makes a parser crash the process, hang, or use unbounded memory or CPU
  despite the worker's time and heap limits;
- anything that writes outside the directory or file a user named (`recover`, `export`, scan state,
  caches), or follows a link out of an analyzed directory;
- target content that ends up executed, or passed to a shell or an engine as a command;
- the local web server answering without its token, from another origin, or to a non-loopback
  address by default;
- `setup` damaging an agent client's configuration or writing without `--apply`;
- secrets from the environment or from targets printed where they were not asked for.

Out of scope: findings that an analysis missed or got wrong (open a normal issue; the corpus is
where accuracy is measured), and the behaviour of radare2, rizin or Ghidra themselves.

## How hexvero protects you

- It never executes a target. Engines are started as separate processes that only read the file,
  with a timeout, and their whole process group is killed on timeout or cancellation.
- Parsers are bounds-checked and capped; malformed files become structured errors or limitations.
  Analyses run in a worker with a time and heap limit in the MCP and HTTP servers.
- The UI server binds to loopback, requires a per-session bearer token, and rejects cross-origin
  requests.
- `setup` is a dry run unless `--apply` is given, backs up every file before writing, and can
  remove its entry again.
- There is no telemetry and no network access in the tool itself.

The full review is in `docs/audits/security-review.md`.
