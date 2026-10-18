# hexvero

Electron release diff for security review. hexvero compares two builds of an Electron app (an
`app.asar`, a `.app`, an install directory or a release ZIP) and reports what changed in IPC
channels, `contextBridge` members, window settings, network hosts and storage, with the file and
line on both sides, plus a release policy check for CI (text, JSON, Markdown, SARIF). It only reads
the files; nothing is executed. The same zero-dependency parsers also read ELF, PE, Mach-O, Go,
.NET, WebAssembly, EVM, SQLite, plist, APK, source maps and HAR. CLI, MCP server and web UI.

```bash
npx hexvero demo
npx hexvero compare old/YourApp.app new/YourApp.app --report report.html
npx hexvero init old/YourApp.app
npx hexvero check old/YourApp.app new/YourApp.app --policy .hexvero/policy.json
npx hexvero setup --apply
```

Documentation and source: https://github.com/maximilianfeix/hexvero
