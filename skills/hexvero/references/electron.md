# Electron and JavaScript apps

Targets: an `app.asar`, an unpacked app directory, or a single bundle file.

## What to read

| Question                                             | Collection                                    | Notes                                                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which IPC channels exist, who sends and who handles? | `ipcChannels`, then `ipc` for call sites      | `ipc` rows have `module`, `api`, `channel`, `line`, and `via` when the channel came through another name, a constant, a helper function or a handler table |
| What can web content call?                           | `contextBridge`                               | `api`, `member`, the `channel` it forwards to (null when none or ambiguous); a row with `member: null` could not be read                                   |
| How are windows configured?                          | `webPreferences`                              | one row per setting as written, with `file`, `line` and `window` (counted per file); a value is never an assumed Electron default                          |
| Which servers does it talk to?                       | `endpoints`                                   | `kind` (fetch, http-client, xhr, websocket, …), `method`, `evidence`; `value: null` is a call whose address could not be read                              |
| What does it store locally?                          | `storage`                                     | `kind`, key, `op` (read, write, delete)                                                                                                                    |
| URLs that only appear as text                        | `urls`                                        | not requests; never call them endpoints                                                                                                                    |
| Module structure                                     | `modules`, `edges`, `externals`, `sourceMaps` | roles main, preload, renderer                                                                                                                              |

## Large apps

The first `hexvero_analyze` reads up to 5,000 JavaScript files (entry file first, then shallow paths). If `complete` is false:

- `hexvero_analyze {targetId, scan: "all"}` reads the rest in batches.
- `include: ["src/main/"]` reads only unread files under a path, when the question is about one area.
- Every collection page of a partial scan carries `partial`; say "in the scanned part" until the scan is complete.

## Reading the evidence

- A security finding such as `nodeIntegration: true` is a setting written in the code, attributed to a window. It is not proof that a page can reach Node; say what would have to be true (a page with injected script, no `contextIsolation`).
- A channel name built at run time cannot be named statically; hexvero leaves it out rather than guessing.
- An alias it cannot resolve is left out too. Absence in a list is therefore weaker evidence than presence; check `limitations` and, if needed, search with `hexvero_strings {text}` or read recovered files.
- For a bundle, `hexvero_recover {targetId, outputDir}` writes the modules as files you can read; `hexvero_sourcemap {targetId, line, column}` maps a generated position to the original source when a map is present.
