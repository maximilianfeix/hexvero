# FAQ

**What is hexvero good for?**
Reading what a build contains and what changed between two builds, without running them:
for Electron apps the IPC channels, preload members, window settings, endpoints and storage keys
with file and line; for native binaries imports, libraries, symbols and hardening. Start with
`npx hexvero demo`, then `npx hexvero compare old.asar new.asar --report report.md`.

**What can it not establish?**
What the program does at run time: whether code is reached, which values computed at run time
take, whether anything is exploitable. Channel names or URLs built at run time are listed as
unresolved or shown as `${…}`. It also misses things it could read in principle: on the newest
blind set it found 12 of 57 IPC channels (`corpus/holdout4/README.md`).

**Do I need an analysis engine installed?**
No. Everything above works with Node.js 22.12 or newer. radare2, rizin or Ghidra are optional
and only add disassembly, decompilation and call graphs for native binaries.

**How are facts and conclusions kept apart?**
A filled dot (`●`) is read from the file as written; a hollow dot (`○`) is inferred from a
pattern or followed through a constant or alias. Endpoints carry `literal` or `inferred`;
interface rows carry `link direct`, `resolved` or `unresolved`. Window settings derived from
Electron defaults say `default on` / `default off`. Anything that could not be read is a
limitation with its code and, where known, file and line.

**What does an incomplete analysis mean?**
Some part was not read: a large app read 5,000 files at a time until `--all`, a file above a size
cap, a call whose channel is a parameter. The output says so where it matters, every list page
says it is partial, and a comparison reports items in unread files as `unknown`, never as
added or removed. Absence from a list is weaker evidence than presence.

**What data is processed locally?**
All of it. hexvero makes no network calls; the UI listens on 127.0.0.1 with a per-session token
and loads no fonts or scripts from the network. If you drive it through a cloud-hosted coding
agent, what the agent reads is sent to that agent's model provider like any tool output.

**Is it safe to open any file because nothing is executed?**
No. Parsing a hostile file still processes attacker-controlled bytes. Parsers are bounded in
size, depth and time and run in a worker with a heap cap, but no parser is proven safe against
every crafted input. Use it on software you own or may examine.

**Can text inside the target mislead an agent?**
Strings, file contents and names from the target are marked as data in every MCP result, the
server instructions say so, and a test plants instruction-like text in a target to check it.
Reports quote target text so it cannot add Markdown, links or shell syntax.

**How do I report a regression?**
Open an issue with the bug template (https://github.com/maximilianfeix/hexvero/issues/new?template=bug.yml):
the `hexvero doctor` output, the command, what it said and what is actually in the file (file and
line), and the file or a minimal reproduction if you can share it.
