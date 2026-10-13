# Examples

Inputs for the demos in the README and for the end-to-end tests in `e2e/`. Everything here was
written for hexvero and is MIT licensed; nothing is taken from a real product.

| File                                           | What it is                                                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notesdesk-1.4.0.asar`, `notesdesk-1.5.0.asar` | A small Electron note-taking app in two versions, packed as ASAR by `scripts/build-examples.mjs`. 1.5.0 replaces the `shell:open` IPC channel with `update:check`, turns `nodeIntegration` off and the sandbox on. |
| `notesdesk-1.5.0.bundle.js`                    | The renderer bundle of 1.5.0 on its own (webpack 5 layout, four modules) for `hexvero recover`.                                                                                                                    |
| `native/demo-v1.c`, `native/demo-v2.c`         | A tiny C program in two versions. v2 adds `read_config()` (which calls `getenv`) and changes the version string. Build them with `cc -O0 -o demo-v1 native/demo-v1.c`.                                             |

Regenerate the archives with `node scripts/build-examples.mjs`; the output is byte-for-byte
reproducible. Try them:

```bash
hexvero analyze examples/notesdesk-1.5.0.asar
hexvero collection examples/notesdesk-1.4.0.asar webPreferences
hexvero compare examples/notesdesk-1.4.0.asar examples/notesdesk-1.5.0.asar ipcChannels
hexvero recover examples/notesdesk-1.5.0.bundle.js ./recovered
```
