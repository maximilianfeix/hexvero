# Security

hexvero parses untrusted input by design. Parsers are bounds-checked, allocations are capped and
malformed files become `AnalysisError` results or `limitations`, never crashes. The UI server binds
to loopback only and requires a per-session bearer token; cross-origin requests are rejected.

Please report vulnerabilities privately through GitHub's security advisories on this repository
rather than public issues. Include the target file (or a minimal reproduction), the command, your
Node.js version and the observed behavior. You will get a response within a few days.
