# hexvero

**Know what changed inside your Electron release.**

![hexvero: the trace of a new preload member from window to handler and host, with file and line at each step, and hexvero check failing the release policy with exit 3](https://raw.githubusercontent.com/maximilianfeix/hexvero/main/docs/social-preview.png)

hexvero compares two builds of an Electron app (an `app.asar`, a `.app`, an install directory or
a release ZIP) and reports what changed in IPC channels, `contextBridge` members, window settings,
network hosts and storage, with the file and line in both builds. A JSON policy turns that into a
CI gate (exit `3` when violated, `4` when it cannot decide; text, JSON, Markdown, SARIF 2.1.0).
`hexvero audit` applies single-build checks known from Electronegativity. It only reads the
files; nothing is executed.

```bash
npx hexvero demo                                                     # two example builds, what changed
npx hexvero compare old/YourApp.app new/YourApp.app --report report.html
npx hexvero init old/YourApp.app                                     # a starting policy
npx hexvero check old/YourApp.app new/YourApp.app --policy .hexvero/policy.json
npx hexvero audit YourApp.app --format sarif > audit.sarif           # one build
npx hexvero ui --demo --open                                         # local web UI
npx hexvero setup --apply                                            # MCP server for coding agents
```

Needs Node.js 22.12 or newer. The same zero-dependency parsers also read ELF, PE, Mach-O, Go, .NET,
WebAssembly, EVM, SQLite, plist, APK, source maps and HAR.

- Website and example comparison: https://maximilianfeix.github.io/hexvero/
- Docs, CI recipe and GitHub Action: https://github.com/maximilianfeix/hexvero
- Moving from Electronegativity: https://maximilianfeix.github.io/hexvero/compare/electronegativity/

MIT. Use it only on software you may examine.
