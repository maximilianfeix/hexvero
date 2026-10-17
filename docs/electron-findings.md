# Electron findings: conditions and sources

What hexvero says about an Electron application's windows, under which condition it says it, and
which page of Electron's documentation the statement rests on. The documentation was read on
2026-10-13; where Electron changes a rule, this file and `windowEffects()` in
`packages/core/src/javascript/app.ts` change together.

Nothing here describes a running application. hexvero reads what the code writes. It does not
know the Electron version that is shipped, command-line switches such as `--no-sandbox`, or a
setting that is changed at run time.

## Four kinds of value

| In the code                                                  | `webPreferences` row                | `windows` column |
| ------------------------------------------------------------ | ----------------------------------- | ---------------- |
| A literal: `sandbox: false`, also `!0` / `!1`                | `value: false`                      | `false`          |
| An expression: `sandbox: !isDev`                             | `value: null`, `computed: "!isDev"` | `computed`       |
| Nothing                                                      | no row                              | `not written`    |
| Two different literals in two separate objects of one window | two rows                            | `conflicting`    |

A computed or conflicting value decides nothing: no app-wide flag, no finding of its own, and
every column derived from it is `unknown`. The limitation `webpreferences_computed` lists the
computed ones with file, line and expression.

A setting also reads as `computed` where the code next to the window does not decide it:

- the window's options take something that could not be followed: a parameter
  (`new BrowserWindow(options)`), a call, a condition between two objects, or a spread of a name
  that is not an object of the file. A key written after that place stands; every other key is
  not known. The limitation `window_options_unresolved` names these windows;
- the options object that was followed may be changed after its declaration. A write to one key
  (`prefs.sandbox = false`, `prefs.sandbox ||= x`, `delete prefs.sandbox`) makes that key
  computed; anything that may change the object without being read here makes every key
  computed: a second assignment to the name, the object handed to a function
  (`Object.assign(prefs, …)`, `tweak(prefs)`) or copied elsewhere, a deeper or computed write.
  This is a reading of the file's text, not a data-flow analysis: it concerns windows that take
  options from a named object, and it errs towards `computed`.

Options are followed where they are built from objects the code names: a constant of the file or
of another module (`Object.assign({}, BASE, { … })`, `{ ...BASE, sandbox: false }`,
`Object.freeze({ … })`), the shorthand `{ webPreferences }`, a class field or a single
`this.options = { … }` at the top of the constructor read through `this.options` (only when
nothing else in the file writes that field or hands it on), and a factory function that returns
such an object. A name is followed to the declaration it has where it is used, so a parameter
or an inner declaration of the same name (and a minifier's short name reused in another
function) is not taken for it. An argument of `Object.assign` that cannot be read makes every key
of the arguments before it computed.

Within one object the later write of a key wins, as in JavaScript, also when one of the two is in
an object that is spread into it (`{ sandbox: true, ...base }` takes `base`'s value) or returned
by a helper whose argument is laid over it. The same holds one level up: `webPreferences` is a
key of the window's options, so in `{ ...base, webPreferences: {…} }` the later object replaces
the whole `webPreferences` that `base` brought, and in `{ webPreferences: {…}, ...base }` it is
the other way round.

## Defaults are assumptions

When a setting is not written, the value in effect is Electron's default, and the default depends
on the version:

| Setting              | Default                                                                                 | Since | Source                                |
| -------------------- | --------------------------------------------------------------------------------------- | ----- | ------------------------------------- |
| `nodeIntegration`    | `false` (was `true`)                                                                    | 5.0   | [Breaking changes, 5.0][bc]           |
| `webviewTag`         | `false` (was `true`)                                                                    | 5.0   | [Breaking changes, 5.0][bc]           |
| `enableRemoteModule` | `false`; the module is removed in 14.0                                                  | 10.0  | [Breaking changes, 10.0 and 14.0][bc] |
| `contextIsolation`   | `true` (was `false`)                                                                    | 12.0  | [Breaking changes, 12.0][bc]          |
| `sandbox`            | `true` (was `false`), "unless `nodeIntegration: true` or `sandbox: false` is specified" | 20.0  | [Breaking changes, 20.0][bc]          |

The only version hexvero can read is the range `package.json` asks for (`"electron": "^38.0.0"`).
That is the application's own metadata: it may be absent from a packaged app, and it does not
prove which runtime is shipped. A value derived from it is therefore written `default on` or
`default off`, and `pageRequire` is `yes by default` or `no by default`. They never read as `on`,
`off`, `yes` or `no`, which are reserved for what the code writes. With no version named, the
derived value is `unknown`.

## The derived columns of `windows`

| Column                     | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Source                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `nodeIntegrationInEffect`  | the literal; else the default for the named version                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | [Breaking changes, 5.0][bc]                    |
| `contextIsolationInEffect` | the literal; else the default for the named version                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | [Breaking changes, 12.0][bc]                   |
| `sandboxInEffect`          | `on` if `app.enableSandbox()` is an unconditional statement at the top of a file ("any `sandbox: false` calls are overridden"); else `off` if `nodeIntegration` is `true` ("The sandbox will automatically be disabled when `nodeIntegration` is set to `true`"); else the literal; else the default for the named version. `unknown` if `enableSandbox()` sits in a function or behind a condition and the result would not be `on` anyway, and `unknown` when `nodeIntegration: true` stands next to `sandbox: true` or `app.enableSandbox()`: the documentation does not say which of the two decides | [Process sandboxing][sb], [WebPreferences][wp] |
| `pageRequire`              | `yes` only with Node integration on **and** context isolation off: "`require()` cannot be used in the renderer process unless `nodeIntegration` is `true` and `contextIsolation` is `false`". As certain as its least certain part; `unknown` for the undocumented pair above unless context isolation is written as on                                                                                                                                                                                                                                                                                  | [Breaking changes, 12.0][bc]                   |

`basis` states, per window, which of these rules produced each value.

Two things the columns do not say, because the documentation makes them independent of these
settings: a preload script that is not sandboxed "will always have access to node APIs no matter
whether node integration is turned on or off" ([WebPreferences][wp]), and with context isolation
off the preload and the page share one JavaScript world.

## Findings

Every finding below is `inferred`: it is read from a pattern in the code, not observed.

| Kind                                | Raised when                                                                                    | Text depends on                                                                                                                                                                                                                                                                                                                                                                                                                                          | Source                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `electron.node-integration`         | a window writes `nodeIntegration: true`                                                        | `pageRequire` of **that** window. `yes`: "page scripts can require Node modules, so script injection there becomes code execution". `no`: page scripts do not get `require()`. `… by default`: worded as an assumption that names the version. `unknown`: says that it is not known. All variants add that Node integration keeps the renderer out of the sandbox. When several windows write it, the one where page scripts get `require()` is reported | [Security, 2][sec], [Breaking changes, 12.0][bc], [WebPreferences][wp] |
| `electron.node-integration-default` | nothing is written and the named version is older than 5, so `pageRequire` is `yes by default` | names the version and says the shipped runtime was not checked                                                                                                                                                                                                                                                                                                                                                                                           | [Breaking changes, 5.0][bc]                                            |
| `electron.context-isolation`        | a window writes `contextIsolation: false`                                                      | fixed: preload and page share one JavaScript world                                                                                                                                                                                                                                                                                                                                                                                                       | [Security, 3][sec]                                                     |
| `electron.sandbox`                  | a window writes `sandbox: false`                                                               | fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                    | [Security, 4][sec]                                                     |
| `electron.web-security`             | a window writes `webSecurity: false`                                                           | fixed: "it will disable the same-origin policy" and sets `allowRunningInsecureContent` unless that is set                                                                                                                                                                                                                                                                                                                                                | [Security, 6][sec], [WebPreferences][wp]                               |
| `electron.insecure-content`         | a window writes `allowRunningInsecureContent: true`                                            | fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                    | [Security, 8][sec]                                                     |
| `electron.webview-tag`              | a window writes `webviewTag: true`                                                             | fixed: "The `preload` script configured for the `<webview>` will have node integration enabled when it is executed"                                                                                                                                                                                                                                                                                                                                      | [WebPreferences][wp]                                                   |

No finding says that a single setting makes an application exploitable. `nodeIntegration: true`
alone leads to "page scripts can require Node modules" only together with context isolation that
is written as off in the same window; whether script injection is possible at all is outside what
hexvero reads.

## Not read

Electron fuses, Content Security Policy, `setWindowOpenHandler` and `will-navigate` handlers,
permission request handlers, `<webview>` attributes, whether an IPC handler validates its sender
([Security, 17][sec]), and `webPreferences` keys other than `preload`, `nodeIntegration`,
`contextIsolation`, `sandbox`, `webSecurity`, `allowRunningInsecureContent`, `webviewTag`,
`nodeIntegrationInSubFrames`, `nodeIntegrationInWorker` and `enableRemoteModule`.

[bc]: https://www.electronjs.org/docs/latest/breaking-changes
[wp]: https://www.electronjs.org/docs/latest/api/structures/web-preferences
[sb]: https://www.electronjs.org/docs/latest/tutorial/sandbox
[sec]: https://www.electronjs.org/docs/latest/tutorial/security
