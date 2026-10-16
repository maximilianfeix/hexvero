Your Electron app's 1.5.0 is ready. Can a web page in it now reach something it couldn't in 1.4.0? Did a window lose its sandbox? Does the code call a server it didn't call before?

The diff of two minified `app.asar` bundles won't tell you. Running the new build to find out is exactly what you wanted to avoid. So I built a tool that reads both builds statically and tells you what changed, with the file and line behind every change, and an honest list of what it *couldn't* figure out.

![hexvero comparing two builds of an Electron app](https://raw.githubusercontent.com/maximilianfeix/hexvero/main/docs/screenshots/ui-compare.png)

Everything below is reproducible in about ten seconds. You need Node 22+.

## 1. Two builds, one command

```bash
npx hexvero demo
```

This copies two builds of a small example Electron app (NotesDesk 1.4.0 and 1.5.0, written for these examples, nothing from a real product) into `./hexvero-demo` and compares them.

## 2. What a page can reach

In Electron, a page talks to the main process through the preload script: `contextBridge` exposes members, each sends on an IPC channel, and `ipcMain.handle` answers. hexvero joins the three:

```text
interfaces (2)
  + preload.js::notesdesk::checkUpdate  @ b: preload.js:9, handler main.js:30 · link direct
  - preload.js::notesdesk::openInShell  @ a: preload.js:9, handler main.js:30 · link direct
```

1.4.0 let any page open a path in the system shell through `openInShell`. 1.5.0 removes it and adds `checkUpdate`, whose handler at `main.js:30` fetches an update URL. `link direct` means the bridge member and the handler use the same literal channel, so the link isn't a guess.

## 3. What a window may do

```text
windows (1)
  ~ main.js::win  @ b: main.js:8
      nodeIntegration: true → false, nodeIntegrationInEffect: "on" → "off", sandbox: false → true
```

Settings are reported **as written**. If a value isn't written and rests on Electron's default for the version in `package.json`, it says `default on` / `default off` instead of pretending it read it.

## 4. What it could *not* tell

This is the part I care about most:

```text
Not established
  ! b: 1 IPC call(s) pass a channel that is not a literal or a constant that could be followed
    (a parameter, a computed value). … ipcMain.handle at main.js:33. (ipc_channel_unresolved)
```

1.5.0 registers `plugin:${name}` channels with names from an environment variable. No static reading can list them. So instead of guessing (or silently dropping them), hexvero names the call and the line, and the IPC finding turns from "confirmed" to "inferred". Same in comparisons: an item in a file the other build didn't read is `unknown`, never `removed`.

## 5. Check it, write it down

```bash
npx hexvero ui --demo --open
npx hexvero compare hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --report report.md
```

The local web UI (127.0.0.1, per-session token, nothing loaded from the network) opens the source lines behind every `file:line`. The report is plain Markdown you can attach to a release review; same inputs, same bytes. [Here's the example report.](https://maximilianfeix.github.io/hexvero/demo/)

![source lines around main.js:30](https://raw.githubusercontent.com/maximilianfeix/hexvero/main/docs/screenshots/ui-source.png)

## What it doesn't do (honestly)

- It reads files; it never runs the app. A finding is what the code **contains**, not what it does, and not proof that anything is exploitable.
- It misses things. On my newest blind test set (an app written by someone without access to hexvero, measured once) it found **12 of 57** IPC channels and **5 of 8** version changes, mostly because channels came from a registry function it doesn't evaluate. The misses are [published in the repo](https://github.com/maximilianfeix/hexvero/blob/main/corpus/holdout4/README.md).
- "Doesn't execute the target" isn't a safety guarantee: parsing hostile bytes is still parsing hostile bytes (bounded in size, depth and time).

## On your own app

```bash
npx hexvero compare old/MyApp.app/Contents/Resources/app.asar \
                    new/MyApp.app/Contents/Resources/app.asar --report report.md
```

It also reads ELF/PE/Mach-O, APKs, .NET, WebAssembly and more, and ships an MCP server so a coding agent (Claude Code, Cursor, Codex…) can run the same investigation with small, cited answers.

It's MIT and open source: **[github.com/maximilianfeix/hexvero](https://github.com/maximilianfeix/hexvero)**. If it gets a fact wrong on your app, an issue with the file and line is the most useful thing you can send me. And if it showed you something you didn't know about your build, a star helps others find it.

---

*I'm the author of hexvero. This post was drafted with the help of an AI assistant; every output in it was produced by running the tool. Only use it on software you own or are allowed to examine.*
