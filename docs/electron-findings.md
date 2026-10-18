# Electron findings: conditions and sources

What hexvero says about an Electron application's windows, under which condition it says it, and
which page of Electron's documentation the statement rests on. The documentation was read on
2026-10-13 (the security guide's sections 13, 14 and 20 again on 2026-10-17); where Electron changes a rule, this file and `windowEffects()` in
`packages/core/src/javascript/app.ts` change together.

Nothing here describes a running application. hexvero reads what the code writes. It does not
know command-line switches such as `--no-sandbox`, or a setting that is changed at run time. The Electron version that is shipped, and its fuses, are read only from a packaged build (see
[Runtime](#runtime-of-a-packaged-build-runtime)); an `.asar` or app directory alone does not
ship them. The window defaults below rest on the version `package.json` names in either case; the
runtime version is reported, not used for them.

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
  not known. When the key written after it is the whole `webPreferences` (`webPreferences: {…}`,
  `webPreferences: prefs`, the shorthand `{ ...display.bounds, frame: false, webPreferences }`)
  and the object it names can be read, it replaces whatever the spread brought, so every setting
  is known, also one it does not write (that one takes Electron's default). This holds only for
  the window's own options and for an object nothing unreadable reaches: a spread inside the later
  object or in the declaration it names (`{ ...prefs, sandbox: true }`), a `webPreferences` that
  is a condition or a parameter not every caller fills in, and a spread after it
  (`{ webPreferences: {…}, ...opts }`) keep the settings computed. So does a later member of the options that may write the key
  without the reading naming it, and it makes every key before it computed as an unknown spread
  does: a quoted `"webPreferences": …`, a computed key `[k]: …`, a method or accessor. This holds
  with or without a spread before the settings (`{ webPreferences: {…}, [k]: 1 }`). A computed
  key whose value is read (`[TITLE]` with `const TITLE = "title"`) is that key, so another one
  replaces nothing and `[KEY]` with `KEY = "webPreferences"` is the later `webPreferences`.
  `__proto__: …` sets the prototype and never replaces an own key, but Electron reads the
  options by property access, so a key the object does not write may come from the prototype: in
  a window's options it makes `webPreferences` unknown unless the options write their own, and in
  a `webPreferences` object every key it does not write reads as computed (the ones it writes
  stand). An accessor or async member that cannot be named (`get [k]()`, `async *gen()`,
  `get 1()`) may be any key. Inside a `webPreferences` object a key is read however it is
  written: `"nodeIntegration": true` (which esbuild's minifier writes unquoted, so the plain and
  the minified build read the same), `["sandbox"]: false`, and `[NI]: true` with
  `const NI = "nodeIntegration"`, also `"preload": …` and `["preload"]: …`. `[NI]` is read only
  where NI is bound, by scope, to that one declaration with a string literal that is never
  assigned again: a parameter of the same name (`function make(SB) { … [SB]: true … }` beside
  `const SB = "sandbox"`), a loop variable, a pattern or a `catch` binding is another name, and
  its key is not read, also where the window's options are evaluated from the calls of the
  function (a parameter whose argument is not known is not the outer constant). An accessor,
  method or generator of a setting (`get contextIsolation() {…}`, `get [NI]() {…}`,
  `sandbox() {…}`) makes that key computed; one whose key is not read (`get [k]() {…}`,
  `async [k]() {}`, `*[k]() {}`) may be any key. A quoted or computed key or an accessor in an
  object that is the value of another key (`inner: { get nodeIntegration() {…} }`) is not a
  setting. A computed key whose name is not read (`[process.env.K]: false`), also in a later
  argument of `webPreferences: Object.assign({…}, { [k]: true })`, may be any setting, and
  replaces what was written before it: every key before it is computed, and a key written after
  it stands. The limitation
  `window_options_unresolved` names the windows whose settings are not all known;
- the options object that was followed may be changed after its declaration. A write to one key
  (`prefs.sandbox = false`, `prefs.sandbox ||= x`, `delete prefs.sandbox`) makes that key
  computed; anything that may change the object without being read here makes every key
  computed: a second assignment to the name, the object handed to a function
  (`Object.assign(prefs, …)`, `tweak(prefs)`) or copied elsewhere, a deeper or computed write.
  This is a reading of the file's text, not a data-flow analysis: it concerns windows that take
  options from a named object, and it errs towards `computed`.

Options are followed where they are built from objects the code names: a constant of the file or
of another module (`Object.assign({}, BASE, { … })`, `{ ...BASE, sandbox: false }`,
`Object.freeze({ … })`), the shorthand `{ webPreferences }`, and a factory function that returns
such an object. A name is followed to the declaration it has where it is used, so a parameter,
a `catch (…)` binding or a declaration of the same name in an inner block (also a block at the
top of the file, and a minifier's short name reused in another function) is not taken for it.
An argument of `Object.assign` that cannot be read makes every key of the arguments before it
computed. Options read from a field of an object (`new BrowserWindow(this.options)`,
`webPreferences: this.prefs`) are not followed at all: a field can be changed in more ways than a
reading of the text sees (`Object.assign(this, …)`, `Reflect.set`, a computed key, an alias of a
nested object, a prototype), so those windows read as computed with `window_options_unresolved`.

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

The only version these defaults use is the range `package.json` asks for (`"electron": "^38.0.0"`);
the runtime version of a packaged build is listed in `runtime` and not used here.
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
| `electron.bridge-exposure`          | a preload hands a privileged object to pages as it is (see below)                              | lists each one as `window.<api>.<member> (<exposed>)` with the value as written and its place; quotes [Security, 20][sec]                                                                                                                                                                                                                                                                                                                                | [Security, 20][sec]                                                    |
| `electron.navigation`               | the app has a window or a navigation handler                                                   | names the targets of `setWindowOpenHandler` with what they return, and of `will-navigate` / `will-frame-navigate` listeners; a kind with no row reads "no … found in the files read", and the detail says how many files were read and what is not followed                                                                                                                                                                                              | [Security, 13 and 14][sec]                                             |

No finding says that a single setting makes an application exploitable. `nodeIntegration: true`
alone leads to "page scripts can require Node modules" only together with context isolation that
is written as off in the same window; whether script injection is possible at all is outside what
hexvero reads.

## Privileged objects exposed through contextBridge (`bridgeExposures`)

Electron's security guide, section 20: "You should not directly expose Electron's APIs,
especially IPC, to untrusted web content in your preload scripts", and "Exposing raw APIs like
`ipcRenderer.on` is dangerous" ([Security, 20][sec]). hexvero lists a row when the value of an
exposed member, or the exposed value as a whole, is one of these, read from tokens (a comment or a
string never counts):

| Written as the value                                                                                                                                                                                                                        | `exposed`                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `ipcRenderer` (`{ ipcRenderer }`, `ipc: ipcRenderer`, `exposeInMainWorld("ipc", ipcRenderer)`)                                                                                                                                              | `ipcRenderer`                                 |
| a method of it as a reference: `ipcRenderer.send`, `ipcRenderer.on.bind(ipcRenderer)`                                                                                                                                                       | `ipcRenderer.send`, `ipcRenderer.on`          |
| `shell`, or one of its methods as a reference                                                                                                                                                                                               | `shell`, `shell.openExternal`                 |
| the `electron` module itself, `require("electron")`                                                                                                                                                                                         | `electron`                                    |
| a Node module object: `fs`, `fs/promises`, `child_process`, `net`, `dgram`, `http`, `https`, `http2`, `tls`, `vm`, `worker_threads`, `cluster`, `module`, `process` (also `node:`); a method of one by reference only where it acts (below) | the module name, e.g. `fs`; `fs.readFileSync` |
| the globals `process` and `require`, where the file declares no such name                                                                                                                                                                   | `process`, `require`                          |

A name counts as electron's or Node's only through a declaration in the same file:
`require("electron")` or `import … from "electron"` (destructured, renamed, `import * as`), what
bundlers write for them (`import_electron.ipcRenderer`, `__toESM(require("fs"))`, `o.ipcRenderer`
in a minified file), and `y = x` / `y = x.ipcRenderer` after such a declaration. Which
declaration a use means is read by scope (the resolver's binding of the name where the value is
written; where it cannot say, the innermost function around it that declares the name, and two
declarations in one function decide nothing). A declaration, parameter or loop variable of the
same name in another function changes nothing. The name is not taken where it is bound as a
parameter, loop or catch variable (`for (const ipcRenderer of …)`, `forEach(ipcRenderer => …)`,
`catch (ipcRenderer)`) where the value is written or around the `exposeInMainWorld` call, or where
the same binding is written again after its declaration (`let r = ipcRenderer; r = {…}`, also
`r ||= …`, `r++`); a write that resolves to another binding, or to none, is not counted. Modules
that only compute or inform (`path`, `url`, `util`, `events`, `os`) are not listed.

Every member of a privileged Node module handed over by reference is listed (`fs.promises`,
`fs.createWriteStream`, `net.Socket`, `module.require`, `process.mainModule`, …) except the few
that only inform: `fs` `stat*`, `lstat*`, `exists*`, `access*`, `constants`, `realpath*` (and
the same of `fs/promises`); `process` `env`, `versions`, `platform`, `arch`, `version`, `pid`,
`cwd`, `uptime`. The list is of harmless members because one of acting members could not be
complete. The module object itself is always listed, and so is every member of `ipcRenderer` and
`shell`.

Not this observation: a member that wraps the object in a function of its own
(`send: (c, d) => ipcRenderer.send(c, d)`, `openUrl(u) { return shell.openExternal(u) }`, a
getter), the result of a call (`wrap(ipcRenderer)`), or a property of an object of the file. Whether
a wrapper narrows anything is not read.

The finding is `inferred`: the value is read as written, the meaning of its name from the file's
declarations. When an exposed value cannot be read (a value built elsewhere, a spread or a computed
key), the limitation `context_bridge_members_unreadable` says that whether it exposes a privileged
object directly is not established; an empty `bridgeExposures` list never reads as "none exposed"
while that limitation stands, and a comparison marks an exposure that only one side lists as
`unknown` when the other side has such an entry in the same file.

Where the scope of an exposed name cannot be read to the end, the row is kept, never dropped, and
carries `undecided`: `budget` (the resolver's work budget for the file ran out, so "no binding"
could not be told from "not read"; the file's privileged declarations of the name are then taken,
several of different meaning named together as `ipcRenderer or shell`), `scope` (two declarations
of the name in one function, or more declarations than are kept, leave open which is meant), or
`writes` (more writes of the name than are kept). The limitation `bridge_exposures_undecided`
lists these rows; such a row may be another binding of the same name. In a comparison the file
then counts as one with unresolved bridge values, so an exposure only the other side lists there
is `unknown`. Paths that end the reading for other reasons keep the row too: a walk back for a
shadowing parameter that runs out of its range takes no shadowing, and a cut inventory is
`context_bridge_truncated`.

## Bridge objects of other modules and functions (`contextBridge`)

A preload often exposes an object it does not write itself. These values are read member by
member, by the same rules as an object literal in the preload (a member's channel, spreads,
computed keys, privileged values), in the file where the members are written; a row's `file` and
`line` are there:

| Exposed value                                                                                                                   | Read as                                                  |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `X` imported from a module of the app (`import { X }`, `import X`, `import * as X`, `const X = require(…)`, also tsc's `x_1.X`) | the export's value in that module                        |
| `createApi(…)`, a function of the file whose one return is `return {…}` as its last statement, or `=> ({…})`                    | the returned object literal, read where it is written    |
| a member `{ auth }` or `auth: authApi` whose name is an object literal of the file (a `const` nothing writes) or an import      | its members as `auth.loginRequest`, three levels at most |
| a member whose name is a function of the file, or a `const` whose value is a function or a call (`makeHandlerInvoker("x")`)     | one member with the channel of the IPC calls in it       |
| `...NS` with `import * as NS` (or a whole `require`)                                                                            | every named export of NS as a member                     |
| `...ns_exports` with esbuild's `var ns_exports = {}; __export(ns_exports, { k: () => k })` (`import * as` bundled)              | the getters' names, each read as the value it returns    |

An export is found as `export const|let|var P = …`, `export function P`, `export default …`,
`export { L as P }`, `exports.P = …` and `module.exports.P = …` (tsc's `exports.P = void 0` and
`Object.defineProperty(exports, "__esModule", …)` say nothing), `module.exports = …`, and a key of
`module.exports = { P: v }`; a default import of a CommonJS module takes `module.exports`. Followed
three modules deep (`ipc` in the preload, `auth` in `preload.base`, its default export in
`platform/auth`). A member of a nested object literal stays one member, as in a preload of its own
(`versions: { app: … }` is `platform.versions`).

A member is not read as written, and the entry stays as it was (the exposed value one entry with
`member: null`, a named member with `channel: null`), when it may not be what is written: the
module does not define the export once (two definitions, `export *`, `export { a } from "./b"`,
`__exportStar`, `Object.defineProperty(exports, "P", …)` for a namespace), the name or a member of
it is written in its module (the write forms of `writes.ts`, also `Object.assign` and the like,
through another name for it, `const p = platform; p.a = …`, three names deep; handed to any
function except the global `Object.freeze` / `keys` / `values` / `entries`, `JSON.stringify`,
`String`, `Boolean`, `console.*` and `contextBridge.exposeInMainWorld` on a proven contextBridge
(a local function or a shadowed `console` of that name is one); a value of an object or array
literal other than the one exposed and the module's own exports, unless that literal is held
under a name that is itself unchanged (`var ipc = { auth: auth_default }`); a part of `a ||
name`, `a ?? name` or `c ? name : d`; and past the work budget, where nothing is proven), a module that imports it writes a member of it (also as a namespace, `import * as
base; base.api.a = …`) (every importer except the exposing preload, whose
writes before the call are members as above; past 64 importers the value is not read), the module
is not among the files (a package, a file outside the app; only relative specifiers are followed),
or it is more than three modules deep, or past 64 modules opened. `context_bridge_module_unread`
names each such value with its module and the reason. A function with more than one return, or
whose return is not an object literal, gives one entry with `member: null`. Inside the other
module an unreadable spread or computed key is one entry with `member: null` there.

A member whose call goes through a method or function of another module (`listDevices: () =>
client.invoke(Channel.ListDevices)` with `client` an instance made in place, `openDialog =
makeHandlerInvoker("openDialog")` with the factory in another module) takes the channel of the
rows those calls give (`ipc`, `via: wrapper`) when they name exactly one; the member's tokens are
kept for that up to 4,000. The parameter of the function that returns the bridge is not bound
to what the call passes beyond that (`createApi(ipcRenderer)` with `ipc.invoke("x")` inside gives
`channel: null`).

Corpus (hit of expected, per input): holdout7 Padwright bridge members 3 of 13 → 13 of 13 in each
of the plain, bundled and minified builds and 2 of 13 → 13 of 13 in v2, bridge member channel
all hit; holdout to holdout6 unchanged. Electron Fiddle 0.38.0 and 0.39.0, Discord and Claude.app:
the same `contextBridge`, `bridgeExposures`, `ipc` and `ipcChannels` rows as before.

## Generic forwarders and the page's calls of them (`contextBridge`, `ipc` `via: bridge`)

A member that passes its first parameter on as the channel (`invoke: (channel, ...args) =>
ipcRenderer.invoke(channel, ...args)`, electron-react-boilerplate's
`ipcRenderer: { sendMessage(channel, ...args) { ipcRenderer.send(channel, ...args) } }`) has no
channel of its own; the page scripts name them. Such a member is a forwarder when its first
parameter is never written in its body, is the whole first argument of every ipcRenderer call
there, and those calls use one IPC method besides `removeListener`, `off` and
`removeAllListeners` (a reference `ipcRenderer.send`, also `.bind(ipcRenderer)`, counts too).
Members of nested object literals count, three levels deep (`electron.ipcRenderer.sendMessage`).
The member's row says `forwards: "ipcRenderer.send"`, and the channel stays null.

A check of the channel is recorded only where it decides every IPC call, in these shapes: `if
(!LIST.includes(channel)) return;` or `throw …` (also `{ …; return; }` whose statements before the
exit do not use the channel, as Element writes it, the exit a statement of that block of its own:
an exit that is only the body of an `if`, `while` or `else` in it leaves nothing for sure) before every call; `if (LIST.includes(channel))
{ … }` with every call inside, `if (LIST.includes(channel)) call;` and `if (…) return call;` (as
esbuild rewrites the early exit); and `LIST.includes(channel) && call` as a statement of its own or
an arrow's whole body. The check must be a statement of the function's own body: inside a block of
another statement (`if (process.env.STRICT) { … }`, `try`, a loop, a `switch` case) or the body of
a condition or loop without braces it is not read. The exit must leave without an IPC call (`if
(!LIST.includes(channel)) return ipcRenderer.invoke(…)` is the opposite of a check), and a `!`
before an `&&` check inverts it. `LIST` is an array literal (or `new Set([…])`) of strings that
nothing writes (no file assigns an `includes` or `has`, `Array.prototype.includes = …`) and that is used only in `LIST.includes(…)` / `LIST.has(…)` (`S.add(…)`,
`L.push(…)` or handing it to a function may change it): `allowed` lists them. The same shapes with
`channel.startsWith("x:")` (also `?.`) give `prefix`. Any other use of the parameter (a check that
does not stop the call, `if (LIST.includes(channel)) log(channel)`, `const ok =
LIST.includes(channel)`, `validate(channel)`, a ternary, a log) gives `guard: "unknown"`; a
parameter of the same name of an inner function is not the channel. The ipcRenderer calls are read
on a name for it and on `X.ipcRenderer` with X the electron module (`electron_1`,
`import_electron`, a minifier's `o`).

The calls are read in every file that is not a main-process file and does not expose anything:
`window.api.m(arg)`, `globalThis.api.m(arg)`, `self.api.m(arg)`, `api.m(arg)` where the file binds
no `api` (no declaration, parameter, import or require of it where it is used), `const X =
window.api; X.m(arg)`, `const { api } = window` (also renamed, `{ api: e }`, as minifiers write
it), `const { m } = window.api; m(arg)`, with `?.` and nested members. A write that may give
the global another value (`window.api = …`, `window["api"] = …`, `Object.assign(window, { api
})`, `Object.defineProperty(window, "api", …)`, and in a classic script, one that is no CommonJS
or ES module, a top-level `var api = …` or an assignment to an unbound `api`; a bare `var api;`
gives no value) may replace the bridge on the pages that load that script. Which pages load which
script is not read (no HTML is parsed for it), so every page row is listed as read and each such
write is named in `bridge_global_written`. A write of a local or a
parameter of that name is none. Not read, and named in `bridge_calls_unread` with the reason: a
file that takes ipcMain from electron (by its tokens: `require("electron").ipcMain`, `{ ipcMain
} = require("electron")`, `import { ipcMain } from "electron"`, `electron.ipcMain`), a worker
script (`new Worker("./w.js")`, `new SharedWorker(…)`, located from the calling file; one that is
not located is named too), and a file with a `with` statement. Each call is one `ipc` row in the calling file: `api` the
forwarded method, `via: "bridge"`, `member` (`electron.ipcRenderer.sendMessage`), the channel its
first argument names (a literal, a constant, another module's constant, or what the bounded
resolver reads; else null, named in `ipc_channel_unresolved`), and with a recorded check
`allowed`: `yes` or `no` against it, `unknown` with `guard: "unknown"`. A row with `allowed: no`
is kept: the page asks for that channel. Where the name of such a call also read as a direct
call of Electron's ipcRenderer (`const { ipcRenderer } = window; ipcRenderer.invoke("x")`), the
bridge row replaces that row. When the preloads that expose the api do not forward the member the
same way (another method or check, or one exposes it as a plain member, or a member whose value
holds the path, `ipcRenderer` for `ipcRenderer.send`), or any exposure of the api has an entry that
was not read (`build(ipcRenderer)`, a spread), its calls give no rows, and
`bridge_forwarder_ambiguous` names it. Every use of a local that holds the api costs 64 of the work
budget. At most 200 page scripts and 5,000,000 of their tokens
are read, and 2,000 calls per file; past that `bridge_calls_capped` names the files. Which page a
window loads is not read, so a call is matched to every preload that exposes the api. In a
comparison these limitations, and `bridge_calls_unread` and `context_bridge_module_unread`, leave
a one-sided IPC or contextBridge item unknown only in the files they name (`at file:line`; the page
scripts that name the api for `bridge_forwarder_ambiguous`); one that names only some (`… and N
more`) applies to every file.

## Navigation and new-window handlers (`navigationHandlers`)

Electron's security guide, section 13 (limit navigation: "you can call `event.preventDefault()` in
a `will-navigate` handler") and section 14 ("register a handler to monitor the creation of windows,
and deny any unexpected window creation", [Security, 13 and 14][sec]); `will-frame-navigate` is the
webContents event that also covers frames ([webContents][wc]). One row per registration:

| Written                                                                                  | `kind`                 | `target`                                                     |
| ---------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------ |
| `win.webContents.setWindowOpenHandler(…)`                                                | `setWindowOpenHandler` | `win`, the window's name in `windows` (`targetKind: window`) |
| `win.webContents.on("will-navigate", …)` (also `once`, `addListener`, `prependListener`) | `will-navigate`        | as above                                                     |
| `….on("will-frame-navigate", …)`                                                         | `will-frame-navigate`  | as above                                                     |
| inside `app.on("web-contents-created", (e, contents) => …)` on `contents`                | as above               | `app` (`targetKind: app`)                                    |
| on any other receiver (`view.webContents`, `this.contents`)                              | as above               | the receiver as written (`targetKind: webContents`)          |

`win.webContents` names the window `win` only where `win` is that window by scope: a parameter of
that name (`function f(win) { win.webContents… }`) or a local declared with something other than
`new …` is another binding and reads `targetKind: webContents`; a name declared without a value
and assigned the window (`let win; … win = new BrowserWindow()`) is matched by its name, as
`windows` names it. `contents` inside `web-contents-created` is `app` only where it is that
callback's own parameter, not a parameter of the same name of a function inside it. `window` is the
window's name, `app`, or null for `targetKind: webContents`; a comparison matches rows by file,
kind, `targetKind` and `window`, so a receiver a minifier renames is no removed and added handler.

`returns` (only for `setWindowOpenHandler`) is `deny` or `allow` only when every return of the
handler is an object literal whose `action` is that string literal: `() => ({ action: "deny" })`,
`return { action: "deny" }`, and the minified `(open(u), { action: "deny" })`. A handler passed by
name, a conditional, two different literals, a nested function, a body whose last statement is no
return (a path then returns nothing), or no return at all is `unknown`. Within one literal the later
key wins, as in JavaScript (`{ action: "deny", action: "allow" }` is `allow`, `{ ...base, action:
"deny" }` is `deny`); a spread or a computed key after the action may replace it
(`{ action: "deny", ...extra }`, `{ action: "deny", [k]: "allow" }`), so that is `unknown`, as
is an accessor, method or generator after the action (`get`, `set`, `async`, `*`, `m() {}`) or
one named action anywhere (`get action() {}`, `action() {}`). A shorthand of another name
(`{ action: "deny", url }`) cannot replace it.
Nothing here says that a handler is safe or unsafe, nor whether it checks the URL or the sender
([Security, 17][sec] is not read).

Absence is said only as "no setWindowOpenHandler found in the files read" or "no will-navigate or
will-frame-navigate listener found in the files read", with the number of files read; a handler
registered through code hexvero does not follow (a computed event name, a helper that is handed the
webContents) is not seen, and a partial scan adds "in the scanned part".

## Remote module turned on (`remoteEnabled`)

`@electron/remote` gives a page's scripts main-process modules and objects; since version 2 it
works only for a webContents the main process passes to `enable()` of `@electron/remote/main`
(after `initialize()`). One row per call or load, read from tokens (a comment or a string is never
one):

| Written                                                                                          | `kind`       | `target` / `targetKind`                                     |
| ------------------------------------------------------------------------------------------------ | ------------ | ----------------------------------------------------------- |
| `R.enable(win.webContents)` with R bound to the main module (below)                              | `enable`     | `win` / `window`, as `navigationHandlers` names a window    |
| `R.enable(contents)` inside `app.on("web-contents-created", (e, contents) => …)`                 | `enable`     | `app` / `app`                                               |
| `R.enable(param)`, `param` a parameter of the function the call is in (a helper)                 | `enable`     | the parameter's name / `unknown` (its callers are not read) |
| `R.enable(view.webContents)`, `R.enable(getContents())`, any other argument                      | `enable`     | the argument as written / `webContents`                     |
| `R.initialize()`                                                                                 | `initialize` | null                                                        |
| `require("@electron/remote")` or `import … from "@electron/remote"` (also `/renderer`), any file | `use`        | null                                                        |

R is the main module (`@electron/remote/main`, also `@electron/remote/main/index.js`) when it is
bound to it in the file: `const R = require(…)`, also wrapped in a bundler's interop helper
(`__toESM`, `__importStar`, `__importDefault`, `_interopRequireWildcard`,
`_interopRequireDefault`; a default one is then called as `R.default.enable(…)`) and in a minified declaration list (`var o=require(…),e=…`); `import R
from`, `import * as R from`; `const { enable, initialize: init } = require(…)` and `import {
enable as en } from`, called as `en(…)`; and `require(…).enable(…)` itself (Joplin:
`require('@electron/remote/main').enable(this.win_.webContents)`). The tsc and esbuild call form
`(0, R.enable)(…)` counts as `R.enable(…)`. A use counts only where the name is that binding by
scope: a parameter or another local of the same name (`function f(remoteMain) {
remoteMain.enable(…) }`) is not it, and a name written after its declaration (any write form,
`writes.ts`) gives no rows. The window is named as for navigation handlers: `win.webContents` is
the window `win` only where `win` is that window by scope; `this.win_.webContents` is matched by
the name `win_`.

The finding `electron.remote-enabled` names the enabled targets; with only `use` rows it says
"@electron/remote is loaded; enable not found in the files read". It is `inferred`. Per file at
most 200 rows, 2,000 in all; past that `remote_enabled_truncated` says so. The scope reading
shares the bounded work budget of the navigation reader (2,000,000 steps per file); past it no
further call is taken. The existing `electron.remote` finding (a text match of `@electron/remote`,
`require("electron").remote` or `enableRemoteModule: true`) is unchanged.

Each file that loads `@electron/remote` gives one `use` row. In a webpack bundle, `12: (e) => {
e.exports = require("@electron/remote/main") }` and `var a = n(12)` bind `a` to the main module.
The policy rule's identity of an enable is its `targetKind` and the window's name, as windows are
matched by name: a minifier that renames the window variable between two builds gives a newly
enabled window (the same holds for `window-more-permissive`).

Not read: `enable` called through another name than these (`const e = R.enable; e(w)`, a module
object handed to a function), the module bundled into the app (its code is then the app's and its
`enable` is a function of the bundle), the Electron 13 and older `enableRemoteModule` option
(it is a `webPreferences` key, listed there), and which callers hand a helper its webContents.

The policy rule `remote-enabled` ([cli.md](cli.md)) reports an `enable` row whose target (kind and
window) no `enable` row of the before build has.

## Command-line switches and certificate checks (`switches`)

Process-wide settings that weaken a check for every window, read from tokens (a comment or a
string is never one) in files that contain `appendSwitch`, `appendArgument`,
`certificate-error`, `setCertificateVerifyProc` or `ELECTRON_DISABLE_SECURITY_WARNINGS`.
Literal-first: a name or value is known only where it is a string literal, a template without
`${…}` or a constant the resolver reads; anything else is `null` and the row says so.

| Written                                                                                                  | `kind`                    | read                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `app.commandLine.appendSwitch(name[, value])`                                                            | `switch`                  | `name` without leading dashes; `value` with `valueRead` `none` / `literal` / `unknown`                                          |
| `app.commandLine.appendArgument(arg)`                                                                    | `argument`                | `name` is the argument; a `--switch` (also `--switch=…`) on the list below is dangerous                                         |
| `app.on("certificate-error", (event, webContents, url, error, cert, callback) => …)`                     | `certificate-error`       | `accepts`: whether `callback(true)` (also `!0`) is called; `preventsDefault`: `event.preventDefault()` is called in the handler |
| `ses.setCertificateVerifyProc((request, callback) => …)`                                                 | `certificate-verify-proc` | `accepts`: whether `callback(0)` is called; `-2`, `-3` and other numbers (also constants such as `var F = -2`) reject           |
| `process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = …` (also `["…"]`), `window.` / `globalThis.` / `self.` | `security-warnings`       | the value as written (`true`, `"true"`, `!0` → `true`); never dangerous: it hides the console warnings only                     |

`app` is Electron's only where it is bound to it by scope: `const { app } = require("electron")`
(also renamed, `{ app: a }`), `import { app } from "electron"`, `X.app` with X bound to
`require("electron")` (also through `__toESM` and the other interop helpers), `import * as X` or
`import X from "electron"`, webpack's `n(91288)` for a module id whose body is `e.exports =
require("electron")`, or `const cl = app.commandLine; cl.appendSwitch(…)`. A parameter named
`app`, a local object `{ commandLine: … }`, or `commandLine` of anything else gives no row. A
name of the electron module that is written again (Claude: `let T = require("electron"); T =
u(T)`) is still taken for it; which value the write gives is not read. A `certificate-error`
listener on `app` reads the sixth parameter as the callback; on `X.webContents` or `contents` the
fifth (webContents' own event); on any other receiver both, and the less safe answer is kept
(`targetKind: "unknown"`).

`accepts` is `always` when the accepting call is a statement of the handler's own body (also in a
comma sequence, `e.preventDefault(), l(!0)`), with no `return` or `throw` before it;
`conditional` when it sits in a nested block, behind `if`/`else`/`?:`/`&&`/`||`/`??`, after a
return, in a loop, `try` or `switch`, or in a nested function (`setTimeout(() => callback(true))`);
`never` when every call passes a literal that rejects; `unknown` when the handler is not a function
literal written there, the callback is handed on or stored, or an argument is not read. The
callback is read only where every parameter up to it is a plain name: a rest parameter, a
destructuring pattern or a default value up to that position is `unknown`, and a handler with
fewer parameters counts as never accepting only when its body does not read `arguments`. A
`certificate-error` handler that never accepts (`callback(false)` only, or no callback parameter)
gives no row; a verify proc always gives one (`setCertificateVerifyProc(null)` none).

Dangerous switches (`dangerous: true`, with `reason`), each from the switch's own documentation:

| Switch                                | Documentation                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ignore-certificate-errors`           | "Ignores certificate related errors." ([Electron][switches])                                                                                                                    |
| `ignore-certificate-errors-spki-list` | "A set of public key hashes for which to ignore certificate-related errors." ([Chromium][chromium-switches])                                                                    |
| `allow-insecure-localhost`            | "Enables TLS/SSL errors on localhost to be ignored (no interstitial, no blocking of requests)." ([Chromium][chromium-switches])                                                 |
| `disable-web-security`                | "Don't enforce the same-origin policy; meant for website testing only." ([Chromium][chromium-switches])                                                                         |
| `allow-running-insecure-content`      | "By default, an HTTPS page cannot run JavaScript, CSS or resources from HTTP URLs. This provides an override to get the old insecure behavior." ([Chromium][chromium-switches]) |
| `no-sandbox`                          | "Disables the Chromium sandbox. Forces renderer process and Chromium helper processes to run un-sandboxed." ([Electron][switches])                                              |
| `disable-gpu-sandbox`                 | "Disables the GPU process sandbox." ([Chromium][chromium-switches])                                                                                                             |
| `disable-site-isolation-trials`       | "Disables site isolation." ([Chromium][chromium-switches])                                                                                                                      |
| `remote-debugging-port`               | "Enables remote debugging over HTTP on the specified `port`." ([Electron][switches])                                                                                            |
| `remote-debugging-pipe`               | "Enables remote debug over stdio pipes" ([Chromium][chromium-switches])                                                                                                         |
| `disable-features`                    | only when its value is read and lists `IsolateOrigins`, `SitePerProcess` or `site-per-process`; an unread value is `dangerous: null`                                            |

Not on the list: `js-flags` (Electron: "Specifies the flags passed to the V8 engine"; whether a
flag weakens anything depends on the flag, which is not judged), `enable-logging` and every other
switch (`dangerous: false`). A switch whose name is not read is `dangerous: null`. A certificate
handler that accepts is dangerous: Electron's `app` documentation says "to trust the certificate
you should prevent the default behavior with `event.preventDefault()` and call `callback(true)`";
whether `preventDefault` is also called is recorded, not required. A verify proc that reports `0`
is dangerous: the `session` documentation says `0` "Indicates success and disables Certificate
Transparency verification", `-2` "Indicates failure", `-3` "Uses the verification result from
chromium".

Names are normalized before the check: trimmed, leading dashes stripped, split at the first `=`
(`appendSwitch("disable-web-security=1")`, `appendArgument("--ignore-certificate-errors=true")`,
whose part after `=` is the value), and lowercased for the comparison only (the row keeps the
name as written; Chromium itself matches names case-sensitively, so this errs towards danger). A
name with any character outside `a-z`, `0-9` and `-` after that is `dangerous: null`, never safe.
`disable-features` values are split on commas, trimmed and compared case-insensitively. An
`appendArgument` that does not start with a dash is a positional argument, not a switch.

The finding `electron.unsafe-switch` (`inferred`) names the dangerous rows. Per file at most 200
rows, 2,000 in all, and a reading budget of 400,000 steps per file; past either
`switches_truncated` says so. The cap drops only rows known to be harmless: a dangerous or
undecided row takes the place of the last harmless one kept. `switches_truncated` on either side
makes the comparison of `switches` incomplete (`values_unresolved`), so `new-unsafe-switch` is
undecidable then. In a comparison a row is matched by file, kind, target kind and
name (the same pair twice as a multiset); `evidence`, `target` and `reason` are no change of their
own.

Not read: a switch appended through a function's parameter (Claude: `function F1(e, t, …) {
e.appendSwitch(t, …) }` called as `F1(T.app.commandLine, …)`), names built in a loop (Discord:
`for (let s of switches) app.commandLine.appendSwitch(s)` is a row with `name: null`), a
certificate handler or verify proc passed by name (`app.on("certificate-error", onCertError)`:
`accepts: "unknown"`), `session.setCertificateVerifyProc` judged per session (the receiver is kept
as written), `<webview allowpopups>`, `will-attach-webview` handlers, and the `webPreferences`
keys `experimentalFeatures`, `enableBlinkFeatures` and `commandLineSwitches` (see
[Not read](#not-read); [Security, 9–12][sec]).

The policy rule `new-unsafe-switch` ([cli.md](cli.md)) reports a dangerous row (a switch by name
and value, a certificate handler or verify proc by what it accepts) that no row of the before
build has; a row whose danger could not be told is an unknown finding.

[switches]: https://www.electronjs.org/docs/latest/api/command-line-switches
[chromium-switches]: https://peter.sh/experiments/chromium-command-line-switches/

## Storage keys through wrappers and enums (`storage`)

A storage call whose key is (or is built from) a parameter of the function or method it is in
makes that function a wrapper:

```js
class AppState {
  save(key, value) {
    localStorage.setItem(key, String(value));
  }
  retrieve(key) {
    return JSON.parse(localStorage.getItem(key) || "null");
  }
  a() {
    this.save(GlobalSetting.isUsingSocketFirewall, true);
  }
}
```

The key is then read at each call of the wrapper in the same file, with what that call passes, and
each readable call is a row of its own: the call's file, line and column, the op of the storage
call inside the wrapper, and `via` naming the wrapper (`AppState.save`, `prefs.get` for a method of
an object literal, `put` for a function). A wrapper whose storage calls have both outcomes
(`save` writes or, with no value, removes) gives one row per op at each call. Calls are found as
the resolver finds them for IPC and endpoint helpers, and only where the name means the wrapper:

- `this.name(…)` only inside the wrapper's own class body, where the innermost function around
  the call that is no arrow is a method of that body (or the call is in a field initializer,
  `x = this.retrieve(…)`), and static to static only: `this` in an instance method or field is
  an instance, in a `static` method or field the class. In a plain `function`, a method of an object literal or another class,
  `this` is something else, and the call does not count. A method belongs to the class whose body
  is directly around it; a method of an object literal inside a class method is not one.
- `x.name(…)` on an instance of the class (`x = new Name(…)` once) or on the object literal of
  helpers (declared once at the top of the file, also in a minifier's `var a = …, c = { … }`).
- `name(…)` for a function declared once (`function name`, `const name = …`) and never assigned
  again; `exports.name = function …` is a property, not a binding, and a plain `name(…)` is no
  call of it.
- A parameter, local, `catch (name)` or block declaration of the name around a call binds the
  name there, and that call does not count.
- A method or object-literal function whose name is also assigned as a member anywhere in the
  file (`x.save = …`, `x["save"] = …`, `A.prototype.save = …`, `Object.defineProperty(x, "save",
  …)`, a `save` key of an object literal passed to `Object.assign`) has no call read: `x.save(…)`
  may call that other function. A value that is no function does not count: a literal, an object
  or array literal, and `R.save = new R(…)`, a class's own static instance (Monaco's icons in
  Fiddle's bundle are written so, and without this exception Fiddle's `save` wrapper is lost).
  `new` of anything else (`new Proxy(f, {})`, `new Function(…)`, an unknown constructor) may be
  callable and counts.

A class is the one written as `class Name`, `var Name = class` or `exports.Name = class`. Two
classes of one name in one file are not told apart by an instance `x.name(…)`.

A key is read when it is a literal, a constant, a template or `+` of those, or a member of a
compiled TypeScript string enum of the file, `GlobalSetting.theme` or `c.GlobalSetting.theme` as
webpack writes an import (`(function (e) { e.theme = "theme" })(u || (t.GlobalSetting = u = {}))`).
In front of the enum's name only a name bound to a module object where the chain stands counts:
declared once, never assigned again, as `c = n(33271)` with `n` the module function's require
parameter, `x = require("./x")` or `i = __toESM(require_x())`, in the function around the use (or
one it is nested in, also when the declaration comes later in the module, as webpack writes
functions before `const r = n(…)`), with no parameter, `catch` binding or other declaration of the
name in between. Any other call (`c = getConfig("x")`) or binding is no module. Which module that is, is not
looked at: the enum's name and member decide. `other.GlobalSetting.theme` on any other object is
not read as a storage key (IPC channels, read as before, take the enum's name and member whatever
the object in front is). The enum's name must mean the enum everywhere in the file: tsc's export chain
`t.A = t.GlobalSetting = t.B = void 0` announces it; any other binding of the name, and any write
to a member outside the definition (`GlobalSetting.theme = "other"`), makes it ambiguous, and
nothing is read through it. A member the enum does not have is not read.

A call whose key cannot be read keeps the row of the storage call inside the wrapper with
`value: null` and the parameter as `expression`, so an unread key is never hidden. Not read: a
wrapper called from a wrapper of another file, a key the wrapper takes from `this` (`this.prefix +
key`), a plain function another module exports as the wrapper (below), and constants a minifier
declares in a list (`var a = 1, K = "key"`) where the resolver does not read them (inside a
wrapper's own key they are read, below). At most 64 wrapper questions per file and 64 call sites per wrapper are read, each within the
resolver's work budget. In a file with more than 50,000 functions (`function` and `=>`) wrappers
are not followed per call at all (limitation `storage_wrappers_skipped`, for an application and
for a single script), and the resolver reads
at most 60,000 functions of a file. False keys are worse than unread ones: where a rule above is
not met, the key stays unread.

In a comparison, an unread key hides only items of its own kind in its file: an unread
`sessionStorage` key does not make a new `localStorage` key unknown.

### Wrappers of another module

A method of a class or object literal whose storage call's key reads exactly one of its
parameters (and nothing of `this`), unchanged in the body, is also followed into the modules that
import it, with the mechanism that follows IPC wrapper classes (`ipcMainManager.handle` in Electron
Fiddle, see wrappers.ts):

```js
// web-store.js
const PREFIX = "tidemark.";
const key = (name) => `${PREFIX}${name}`;
export const local = { get: (name) => localStorage.getItem(key(name)), … };
// renderer.js
import { local } from "./renderer/web-store.js";
local.get(LAST_PROJECT); // LAST_PROJECT = "lastProject": localStorage read tidemark.lastProject
```

The receiver must be proven to be an instance of that class or that object: `import { local }
from`, `const { SettingsStore } = require("./store")` then `new SettingsStore()` (a name declared
once; a call such as `s.set(…)` does not count as a change of `s`, an assignment to `s` anywhere in
the file does), `const store = require("./store")` with `module.exports = new Store()` there, `new
(require("./store").SettingsStore)()`, re-exports as for IPC wrappers, and the same in one
esbuild bundle (ESM modules hoisted into one scope, `__commonJS` with `require_x()`, plain and
minified; `var store = require_x()` counts when every `module.exports = …` of the bundle says the
same). A method
name another class also defines counts only on such an instance. The name must mean the import at
the call: a parameter, local, destructuring pattern, `for … of` head or `catch` binding of it in
between is something else, and gives no row. A method whose name is assigned as a member in the
calling module or in the wrapper's (`local.get = f`, `Object.assign(x, { get })`, `Reflect.set(x,
"get", f)`) gives no row in that module.

Replacements from other modules are read in the wrapper's module and in every module that imports
it, directly or through a re-export (`export { … } from`, `export *`, `module.exports =
require("./store")` in any form, also under a condition or replaced later: reading too much here
only blocks more). For every other reading (endpoints, IPC channels, bridge members, window
options, wrapper calls) `module.exports = require("./x")` passes module `./x` on whole, like
`export *`, only when it is the file's one write of `module.exports` or `exports`, a statement of
its own at the top of the file (not in a function or block, not under `if` or `else`, not in a
ternary, `&&` or `||`), ends there (`;`, `}`, the end of the file, or on the next line a statement
that cannot continue it: not a template, which would make it a tagged call, nor `(`, `[`, `.`,
`?.`, an operator, `in` or `instanceof`), and nothing else replaces the exports
(`module.exports = f(module.exports)`, `exports = …`, `Object.assign(module, …)`,
`Object.defineProperty(module, …)`, `module["exports"] = …`, `module[k] = …`, or `module` used any
other way, `const m = module`, `f(module)`); members added after it (`module.exports.extra = …`)
are read as before. The receiver must be proven to be the wrapper: the class, its prototype
(`Store.prototype`, also as a name bound to it, `const P = Store.prototype` or `const P =
require("./store").Store.prototype`, `Object.getPrototypeOf(s)`, `s.constructor.prototype`,
`s.__proto__`), or an instance (also through aliases, `const t = s`). These forms are seen:

- a write of the method: `R.save = f`, `R["save"] = f`, `R.save ||= f` and every other
  assignment operator, `++`/`--`, a target of a destructuring assignment (`[R.save] = …`, `({ a:
  R.save } = …)`) or of a `for (R.save of …)` head;
- a removal: `delete R.save`, `Reflect.deleteProperty(R, "save")`;
- `Object.assign(R, { save })` and `Object.defineProperties(R, { save: … })` (another argument than
  an object literal, or a spread in one, counts as any method), `Object.defineProperty`,
  `Reflect.defineProperty` and `Reflect.set` with that name (a name computed at run time counts as
  any method), and a computed member write `R[name] = f` (any method);
- `Object.setPrototypeOf(R, …)` or `Reflect.setPrototypeOf(R, …)`: any method;
- a write to the export the wrapper is reached through, `m.store = new Proxy(m.store, …)` or
  `m.Store = class {…}` with `m = require("./store")`: any method of it.

Each replaced method gives no row in any module, and the limitation `wrapper_method_replaced`
names it with the place of the write; when the receivers of a module's writes cannot be read
within their work budget (200,000 steps per module, and 3,000,000 for the application: the tokens
of the modules opened plus that work), the methods of that name of every wrapper count as
replaced, and the limitation says "a member write not read within the replacement budget … at
file:line"; a module not read at all once the application's budget is used up makes every method
of the wrappers it imports count as replaced ("… imports it and was not read within the
replacement budget of the application"). That holds for storage keys; for IPC wrapper methods
the calls are read as before the check existed, and the limitation `wrapper_replacements_unchecked`
names the modules not checked. Modules are read in an order that a file growing between two
builds does not change: the modules that define wrappers, then the rest, each by path; the 200
calling files whose calls are read are the first 200 by path. Calls of a wrapper whose methods all
count as replaced are not read. The same writes in the wrapper's own file count as well, which
is where they are in one bundle (esbuild, webpack): for storage wrappers (every form above, so
`({ a: local.get } = …)`, `local.get ??= f`, `Object.assign(local, o)` and `Reflect.set(local, k,
f)` in a bundle give no `via` row through `local.get`, as they give none across modules; since
#202), for IPC wrappers (`w.handle = () => {}` on an
instance of a class whose `handle` forwards to `ipcMain.handle`) and for methods with an IPC object
parameter (`Svc.prototype.register = function (ipc) {…}`, `t.register = (ipc) => {}`), a call of
the replaced method in that file gives no row, and `wrapper_method_replaced` names the method
and the line of the write (since #201; before, only a write in another module was seen). A write
on one instance counts for the class, so the calls on its other instances give no row either. In
the file itself the writes are read only where a call of a wrapper method in that file gives a
row, and a write whose receiver is not read within the file's replacement budget (200,000 steps;
the largest bundle of Discord, Claude.app and Electron Fiddle needs 86,000) proves nothing: the
calls are read as before that check, and the limitation `wrapper_replacements_unchecked` names
the file. So does a computed member write in the wrapper's own file whose key is not read
(`this[key] = value` in a setter of the class, as Electron Fiddle's `AppState` and got's
`Request` have): it may replace a method, which is not proven, and the calls are read. A key
that is one string constant bound by scope (`const k = "handle"; Ipc.prototype[k] = f`) or a
loop over a list of strings (`for (const m of ["handle", "on"]) Ipc.prototype[m] = f`) replaces
those methods there, as it does across modules. A write to another object of the same method name (`srv.handle = f`, lodash's
`_.get = baseGet`), or in a module that imports none of these modules, changes nothing. Not seen,
so a call there may still be read although the method was replaced: a replacement through a
global (`window.__s.save = f` with `window.__s` set elsewhere), through `require.cache`, through
`require(n)` with a name computed at run time, on an instance handed as a value to a function of
a module that does not import the wrapper (`exports.patch = (s) => { s.save = f }`), and on any
receiver that cannot be traced to the wrapper. A
`static` method is called on the class, never on an instance, and is no wrapper method (this also
holds for IPC wrappers and for the in-file rules above). Of `export *`, the module's own export of
a name wins, and a name two `export *` sources give is ambiguous and not followed. A parameter of
another module's function counts as an instance only when every call the calling modules make
passes one, and the function does not assign the parameter (`use(s) { s = new Map(); … }`); when
a calling module's calls are not all read, no parameter counts.

The argument is read in the calling module (a literal, a constant, another module's constant such
as a member of a compiled string enum, `StorageKey.Theme`, or what the resolver reads through
call sites, whole), and the wrapper's key expression is then evaluated in its own module with
that value for the parameter (`key(name)` above, also when the minifier declares `key` and
`PREFIX` in a list). Each call is a row at the call with `via` the wrapper (`local.get`,
`SettingsStore.set`; a minified name such as `c.get` in a bundle). A call whose argument or key is
not read whole is an unknown row at the call with the argument's name as `expression` (in one
bundle only when the file has no unknown row of that kind already: the storage call inside the
wrapper keeps its own unread row, as before). Calls on `this` stay with the in-file rules above.
Bounds: the storage calls with an unread key of at most 64 per file are looked at, at most 256
wrapper calls per file are read (an argument longer than 64 tokens is not followed through the
resolver: an unknown row), within the readers' work budget per file, at most 200 calling files and
2,000 such rows per application; past them the limitation `storage_wrappers_capped` says so (one
entry for the application, with the number of files and the first five). In
one bundle, a call whose argument is no literal or constant is not read through the resolver once
the file has an unknown row of its kind. Not followed across modules: a plain function as
the wrapper (`exports.save = (key, v) => localStorage.setItem(key, v)`, `import { save }`), an
electron-store instance a wrapper module holds, and HTTP requests made through a wrapper of
another module (endpoints below).

## Requests through HTTP client modules (`endpoints`)

A call of Node's `http` or `https` module or of Electron's `net` is an `http-client` endpoint row,
read as a `fetch` URL is, when the name it is made on is bound to that module:

- `X = require("node:https")` (also `http`, and through a bundler's interop call,
  `X = __toESM(require("https"))`, then `X.get(…)` and `X.default.get(…)`), `import X from
  "https"`, `import * as X from "https"`;
- a request function bound by name: `const { get, request: r } = require("https")`, `import {
  request as r } from "node:http"`, and esbuild's `(0, X.get)(…)` for such an import;
- Electron: `const { net } = require("electron")` or `import { net } from "electron"`, then
  `net.request(…)`, and `E.net.request(…)` with `E = require("electron")` (esbuild's
  `import_electron.net.request(…)`);
- a request function held as a value, taken from a binding above: `const req = https.request`,
  `const g = https.get`, `const g = require("https").get`, `const { get, request: r } = https`,
  esbuild's `var send = import_https.default.request`, `const l = net.request`, `const l =
  E.net.request`, and `const { net } = E`;
- a request library called itself: `axios(url)`, `axios(url, config)`, `axios({ url, method })`,
  `got(url)`, `got(url, options)`, `got({ url })`, `ky(url)`, `ky(url, options)`, `needle(method,
  url, …)`, `needle.request(method, url, …)`, `superagent(method, url)`, `superagent(url)`, and
  esbuild's `(0, import_axios.default)(url)` (also minified, `(0,o.default)(…)`);
- an instance with a base URL: `const api = axios.create({ baseURL })` (also on esbuild's
  `import_axios.default`, on `require("axios")` itself, and made where it is used,
  `axios.create({…}).get(…)`), `got.extend({ prefixUrl })`, `ky.create({ prefixUrl })` and
  `ky.extend({ prefixUrl })`; then `api.get(…)`, `api.post(…)`, `api(url)`, `api({ url })`.

A function value or an instance must be a declaration (`const|let|var NAME = …`, also later in a
declaration list, `var o = r(require("axios")), q = o.default.create(…)`) whose value is that one
expression, made from a binding proven at the declaration; the name follows the rules below
(shadowing, `refersTo`), and a declaration that an assignment writes to gives an unknown row
(`<expression>`) where it is meant. A write is an assignment (`=`, a compound assignment, `++`,
`--`), a destructuring assignment (`({ api } = o)`, `({ k: api } = o)`, `[api] = l`, nested, with
a default or a rest) or a `for (api of …)` / `for (api in …)` head; a declaration pattern, a
parameter pattern and an object literal are none. A pattern whose parameter list or argument list
is more than 300 tokens long is taken for a write (and the file flagged) rather than walked. A call before the declaration of an instance or
a function value gives no row (the binding does not exist there yet). Only writes in the range
the declaration is seen in (the block of a `let`/`const`, else its function) are asked about, at
most 64 per declaration and 32,000 per file; past that the binding counts as written. The same
holds for the module bindings: a write is matched only with the declarations of its name whose
range holds it. A declaration (`let o = e`, also later in a list) is no write, and a write of a
local of the write's own scope is not charged to any client binding: a `var` of the function the
write is in, a `let`/`const`/`class` of a block that holds the write (also one declared after it,
in its dead zone), a function declaration or a parameter of that function (`function f(e) { let
o = e; o = o + 1 }` in a minified bundle whose top-level `o` is `https`). The rest count against
at most 2,000 writes and 32,000 questions per file. A write that means no single declaration
though the binding it sees is one of several declarations of the name in one scope (`var h =
require("https"); var h = require("https"); h = x`) counts for those declarations of that scope.
Past these bounds, and in a file with more functions than the resolver reads (60,000), every name
written from there on counts as written: its calls are unknown rows where they mean it, also
where the address is a literal (a known row of such a name becomes unknown), and the file is
flagged with its own limitation, `client_writes_skipped`. Past the 2,000 checked calls
(`client_calls_skipped`), a call on a name with a declaration written again is an unknown row,
not read by the name rule.

Bindings follow block scopes: a `let`/`const` binds in its block (also before its declaration,
in the dead zone), a `var` in its function; a call outside the block of a client's `let`/`const`
does not mean it. A call whose receiver is a local of a function between it and the client's
declaration (also a later declarator of a list, `var t = [], n = new WeakMap`, which the scope
tables do not hold) is not a call of the client. This is stricter than 0.9.8, which took some writes
and calls in an inner block or function for the outer binding: rows change both ways (an outer
binding no longer charged with an inner local's write keeps its address; a write to an outer
binding from an inner block now makes its calls unknown). A call on a name with no binding
visible, where the file assigns that global (`h = require("https")`, `h = other` on an
undeclared `h`), is an unknown row; with no such assignment the name rule of 0.9.2 reads the
address written at the call, as it always did.

An instance whose binding is used otherwise than for requests (`NAME.<verb>(…)`, `NAME(…)`) may
have its defaults changed, so all its requests are unknown rows (`<expression>`):
`api.defaults.baseURL = …`, `Object.assign(api.defaults, …)`, `api.interceptors.request.use(…)`
(an interceptor can set `baseURL` or `url`), got's `g.defaults.options.prefixUrl = …`, the
instance passed to a function (`setup(api)`), assigned, put in an object (`module.exports = {
api }`) or exported (`export const api = …`). Another module that imports an exported instance
can change it too, so an exported instance is never read with its base. At most 4,096 uses per
instance are looked at (past that, unread). Where the file touches a library's own defaults,
interceptors or hooks (`axios.defaults.baseURL = …`, also on esbuild's `import_axios.default`),
a request of it with a relative address is an unknown row (the global base is not known), an
absolute one is kept (an interceptor rewriting an absolute address is not followed), and an
instance made from it is unread. A superagent agent (`const agent = superagent.agent()`,
`require("superagent").agent()`) is read like superagent's verb methods, under the same rules.

The method of a library call is the verb method (`get` → `GET`), the method argument (`needle`,
`superagent`, a string literal of 3 to 7 letters), or the `method` option of a config object
written at the call; without one it is the library's default, `GET` (for an axios instance the
`method` of its `create` options when that is one literal). A config passed as a name
(`axios(url, config)`) may set a method: the row has none; for an instance with a base
(`api.get("/u", opts)`) it may also set the base, so the row is unknown (`expression` the name).
`superagent(url)` and `superagent(url, callback)` (a function written there, or a first argument
that is a string literal and no method name) are a GET of the first argument. A config written at the call (the
second argument; the third for axios `post`, `put` and `patch`, whose second is the body) that
changes the address is an unknown row whose `expression` names the option: `options.baseURL`,
`options.allowAbsoluteUrls`, `options.socketPath`, `options.url` (axios); `options.prefixUrl`,
`options.baseUrl`, `options.allowAbsoluteUrls`, `options.url` (got); `options.prefixUrl`,
`options.prefix`, `options.baseUrl`, `options.url` (ky); `<options>` for a spread, a computed key
or a method in it. A config passed as a name to the library itself is not read (the address is
kept).

An instance's base is read only from an object literal written in the `create`/`extend` call,
and only when it is one known string (a literal or a constant, written as nothing else) that is
absolute (`https://…`) or an absolute path, without a query or fragment (the base and the
input are joined as text, so one would swallow the input; got refuses it). Anything else makes every request of the instance an unknown row: `options.baseURL` /
`options.prefixUrl` for a base that is not known, `<options>` for options passed as a name or
with a spread, `options.<key>` for one of the options above (ky 2's `prefix` and `baseUrl`, got
9's `baseUrl`, `allowAbsoluteUrls`), `<expression>` for an instance made from an instance
(`api.extend(…)`). The address is joined by each library's rule, as its source reads:

- axios (`buildFullPath`, `combineURLs`): an input that is absolute (`scheme://` or `//`) is
  used as it is; any other is joined with one `/`, without the base's trailing and the input's
  leading slashes (`baseURL: "https://x/v1/"`, `"/users"` → `https://x/v1/users`); an empty input
  (`api.get("")`) is an unknown row, as any argument with no text; an input that starts with a gap (`${…}/x`) or another module's constant is an
  unknown row (whether it is absolute is not known);
- got and ky 1 (`prefixUrl`): the base with a trailing `/` added, then the input as written
  (`"users"` → `https://x/api/users`). An input with a leading slash (got and ky 1 throw), an
  absolute one (got 16 uses it as it is, older got and ky 1 append it to the prefix) or one that
  starts with a gap or another module's constant is an unknown row. ky 2 throws on `prefixUrl`; the
  rows are those of ky 1.

A protocol-relative result (`//cdn.example/x`) is not taken for an address: an unknown row.
`fetch(new Request(url, init))` and `globalThis.fetch(…)` of it read the URL of the `Request` as
a `fetch` URL is read, and `fetch(r)` with `const r = new Request(…)` (a declaration before the
call, never written again; at most 64 such names per file). `Request` must be the global one: a
binding of the name visible at the call (`const { Request } = require("undici")`), an import of
the name anywhere in the file (`import Request from …`, `import { Request }`, `import { Foo as
Request }`) or an assignment of the global (`globalThis.Request = …`, `window.`, `self.`, a bare
`Request = …`) leaves the row unknown, as before. The method is the one of `fetch`'s own init when it writes one (an init that
is not read, or one with a spread, gives no method), otherwise the `Request`'s init `method`.

The name must mean that binding at the call: a parameter of the name in a function between the
call and the binding (also in the parameter list the call stands in, `function f(https, a =
https.get(…))`), a `catch` binding, or another declaration of the name visible at the call
(`const|let|var|function|class NAME`, a destructuring pattern, `const { get } = o`, `[get] = o`,
a `for (const https of …)` head; a named function expression binds its name inside itself only)
is another object. A declaration of the name in another function or block shadows only there,
and a class field (`class A { https = 1 }`) or an object key binds nothing. An assignment whose
name means the binding (`h = mock`) makes it no proven client. The declarations of a name are
read once per file into ranges.

Where no binding is proven, the rule of 0.9.2 applies: a call on `http`, `https`, `axios`, `got`,
`ky`, `superagent`, `needle`, `$http` or a name bound to one of those modules anywhere in the file
is a request when its URL is read as an address, without unknown rows. A local of such a name
counts by what it is bound to:

- `require("<client module>")`, also through an interop call or a pattern, and webpack's
  `n(<id>)` where module `<id>` of the same file only passes a client module on (`7(e) {
  e.exports = require("https") }`, also `7: function (e) {…}`): the client. Such an `n(<id>)`
  binding is a proven client under any name.
- Another module (`require("./cache")`, `n(<id>)` of a module that passes `fs` on): that module,
  no row; under a client's own name (`const axios = require("./http")`, a wrapper module) the
  name rule still holds.
- `n(<id>)` of a module this file does not show: under a client's own name (`const https =
  n(5)`) the name rule holds; under another name (`const r = n(7)`) the object is not known, and
  the call is an unknown row (`<expression>`), never the address.
- Anything else, and a parameter of a name the file binds to a client module: another object.

A declaration that an assignment writes to (`let h = require("https"); h = fake;`, also `h ??=
fake`) may hold something else at any call, before or after the assignment: a call where the name
means that declaration is an unknown row (`<expression>`), never the address. An assignment of
another client module (`if (x) https = require("http")`) keeps the binding a client; when the two
modules differ, an options object without `url` is not read (its default protocol is not known). At most 2,000 client calls are
checked per file (limitation `client_calls_skipped`); the further ones are read by that rule, so
a literal address past the cap is still a row. Unknown client rows past 200 per file are folded
into one `<expression>` row with its count, so they cannot push known addresses out of the list
(2,000 rows per list). The request libraries named by
`require` (`axios`, `got`, `ky`, `superagent`, `needle`) count the same way, read as above. For
Node's modules the method is `GET` for `get`, `POST` etc. for the verb methods, and for `request`
the `method` option when the call writes one.

The URL argument is read like a `fetch` URL: a literal, a constant, a template, and a parameter of
the function around the call, followed to the call sites of that function with the resolver's
rules (as for storage wrappers above: a function declared once, `this.name(…)` only in its own
class, no shadowing binding, no member assignment of the name, at most 64 call sites, depth 3).
An anonymous function called where it is written (`async function (t, e) { … }(t, e)`,
`(function (u) { … })(x)`, `!function (u) { … }(x)`, `((u) => { … })(x)`) has that call as its
one call site; the parenthesis around it must group it, not open a call it is an argument of
(`foo(function (u) { … })(x)` calls what `foo` returns), and
`new URL(t)` is read also when `URL` comes from `node:url` under another name (`import { URL as
Nt } from "node:url"`, `new url.URL(…)`), where that name means the import (a parameter `Nt` is
something else). Only a value shaped like an address counts (a scheme,
`/path`, or another module's constant). When some call sites give an address and others cannot be
read, the call has a row per address and keeps an unknown row too (`expression` names the
argument): Electron Fiddle 0.39.0's `sfw.mjs` reads
`https://api.github.com/repos/SocketDev/sfw-free/releases/latest` from `Gt()` → `Rt(t)` → an
inline `async function (t, e)` → `Mt(t)` → `kt.get(new Nt(t), …)`, and keeps an unknown row for
the redirect `Mt(c.location, …)` and the download `Mt(t, { headers })`, whose URLs exist only at
run time.

An options object is read only when every part of the address is known: `hostname` (or `host`),
`path` (default `/`) and `protocol` (default `https:` for `https`, `http:` for `http` and Electron's
`net`), each one whole string; `url` for `net` and the request libraries. Anything else is an
unknown row whose `expression` says which part was not read: `options.hostname` (also when none is
written: Node then sends the request to localhost, which is not taken for an address),
`options.port`, `options.defaultPort`, `options.socketPath`, `options.lookup` and
`options.createConnection` (not read at all), `options.url` for Node's `http` and
`https` (which take no `url` option), `options.path`, `options.protocol`, and `<options>` for an
object with a spread of something unknown. Node merges an options object over a URL
(`https.request(url, { hostname })`): when the second argument is an object literal that sets
`protocol`, `hostname`, `host` or `path`, those parts replace the URL's, and only when each is
known (a `host` or `hostname` with a port is unknown: Node takes it as a bare name); one of the options above, a spread or a part that is not known makes the row unknown. An
options object passed as a name there is not read (the URL is kept). An argument that cannot be read is an unknown row with
the argument as `expression`; nothing is guessed.

An address another module exports as a template on its own constant (`module.exports = {
DIRECTORY_URL: `${API_ROOT}/directory/top` }` with `const API_ROOT = "https://…"`), also when a
third module passes it on with a spread (`module.exports = { ...endpoints }`) or a bundler wraps
the modules (esbuild, plain and minified), is read for `fetch` and the clients above. Every gap of
the template must be one name of a string constant of that module, declared before the template,
and written exactly once in the whole file: a second declaration, an assignment (`API_ROOT = …`,
`+=`, `++`), or another binding of the name (a parameter, also of an arrow `API_ROOT => …`, a
destructuring pattern, a `for (const API_ROOT of|in …)` head) makes the entry unread, and the request keeps its unknown row. Anything else in a gap (`${API_ROOT.trim()}`,
a call, a name the module does not declare) is not read either. At most 64 such names are checked
per file.

A client known by its name only (`https.get(…)` where `https` is not bound in the file,
`axios.post(…)`) is read as before, without unknown rows; where a parameter or local of that name
is meant as a parameter (`function login(axios, body)`), the URL is read at the call only, not
through call sites; a declaration, pattern or `for … of` of the name, and a member of another
object (`this.https.get(…)`), make it no client by name (only the shape rule for unknown objects
applies). Not read: modules a bundler refers to by number (webpack's `r = n(65692)` for
`e.exports = require("https")`, as in Fiddle's main bundle, where Sentry's `t.net.request(…)` and
`electron-devtools-installer`'s `s.net ? s.net.request : r.get` stay without a row in both
versions), a client passed around as a value other than by the declarations above (an argument,
a property, a conditional `x ? net.request : https.get`, a value taken from an instance), wrappers
called from another module, a call of an instance made where it is written
(`axios.create({…})(url)`), interceptors and hooks that rewrite the address
(`api.interceptors.request.use(…)`, got and ky `hooks`), query strings added by `params` /
`searchParams`, needle's and superagent's requests without a method argument written as a
literal (the address is read, the method is not), and a `Request` built from another `Request`
or passed through a function.

## IPC built from data: tables, routes, parameters (`ipc`, `ipcChannels`, `contextBridge`)

Applications often generate their IPC from data instead of writing one call per channel. Four
such forms are read, each in the plain, bundled (esbuild) and minified build. They are read by
the bounded resolver (`packages/core/src/javascript/resolve.ts`, nothing is run); anything
outside the rules below gives an unreadable or unresolved row as before, never a guessed
channel.

**What counts as a write.** One definition serves every reader (`packages/core/src/javascript/writes.ts`).
A constant (a top-level `const`, `let` or `var` with a literal, or a table) keeps its value only
when nothing in the file writes it. A name is written by:

- an assignment with any operator: `=`, `+=`, `-=`, `*=`, `/=`, `%=`, `**=`, `<<=`, `>>=`,
  `>>>=`, `&=`, `|=`, `^=`, `&&=`, `||=`, `??=`;
- `++` or `--`, before or after it;
- an array or object pattern that is assigned, at any depth: `[CH] = …`, `[, CH] = …`,
  `({ CH } = …)`, `({ k: CH } = …)`, `({ CH = 1 } = …)`, `[[CH]] = …`;
- the head of a loop: `for (CH of …)`, `for (CH in …)`;
- any of these in parentheses: `(CH) += …`, `((CH))++`;
- a `var` declared again with a value in a block of the same scope: `if (x) { var CH = "b" }`.

Its own declaration (also in a list, `var a = 1, CH = 2`, and in a declaration pattern
`const { CH } = …`), a parameter default (`function f(CH = 1)`), a class field
(`class A { CH = 1 }`) and a computed key (`o[CH] = …`) are no writes of it. A line break
ends a declaration list where no operator continues it (`let a = 1⏎return g(), CH += "x"`
writes `CH`; `CH⏎++y` steps `y`). A method head is `name(…) {` with its brace on the line of
the `)` (also `[k](…) {`, `"key"(…) {`); `foo(CH = 1)⏎{ }` is a call that assigns `CH`. Where a minifier
reuses a short name, a write other than a plain `=` to a parameter, a `catch` binding, a
pattern element of a declaration or a `const|let|var` of a function or block around it is that
local's own (`function f() { let d = 0; d++ }` leaves the top-level `d` alone); a plain `=`
counts in any scope, as before. A `var` belongs to the function body around it; where that body
is not recognized for certain (a class body, `static { … }`, an unrecognized `) {`), it is no
local of any function, and the write counts for the top-level name. A constant declared inside a
bundler's module wrapper counts every write of its name. Up to 0.9.8 only a plain `=` counted,
and `%=`, `&=`, `|=`, `^=` and `>>>=` were not even single tokens: the old value was reported as
known after any other write (#198). A minifier's `n=e,o=e` in a function counted only its first
assignment.

A member is written the same ways through a chain of members and elements from a name
(`T.A += …`, `T["A"]++`, `T?.a.b = …`, `[T.A] = …`, `({ k: T.A } = …)`, `for (T.A of …)`,
`delete T.A`, `(T).A = …`, `(T.A) = …`): `T.A` is then unknown, and any key of `T` for a
computed one (`T[k] = …`), for `Object.assign(T, …)`, `Object.defineProperties(T, …)` and the
other writers below, and for a write through another name for it (`const U = T; U.A = …`, also
`var c = {…}, o = c` as minifiers write it). A module that writes its own table or constant
(`Channels.OPEN = "…"`, `KEYS.theme = …`, `exports.CH` assigned again, or inside a function)
hands the written entries to no other module; tsc's `exports.a = exports.b = void 0` declares
the exports and is no write.

**What counts as a change of a table or list.** The values are read only when the table or list
is a `const` object or array literal (also in `Object.freeze(…)`, and in a declaration list as
minifiers write it, `var a = …, T = {…}`) that nothing may change. Anywhere in the file, these
make it unknown:

- a write to the name, or to a member or element at any depth (above): `T.x = …`, `T[k] = …`,
  `T.a.b += …`, `R[0].channel = …`, `T.x++`, `[D[0].channel] = …`;
- `delete T.x`, `delete T[k]`;
- a mutating method on it or on a member, also called with `?.`: `push`, `pop`, `shift`,
  `unshift`, `splice`, `set`, `delete`, `clear`, `fill`, `copyWithin`, `sort`, `reverse`
  (`R[0].list.push(…)`, `E.splice?.(0, 1)`);
- `Object.assign`, `Object.defineProperty`, `Object.defineProperties`, `Object.setPrototypeOf`,
  `Reflect.set`, `Reflect.defineProperty`, `Reflect.deleteProperty`, `Reflect.setPrototypeOf`
  with it or a member of it as the target (`Object.assign(R[0], …)`, `Reflect.set(T.a, …)`);
- a member write through a loop variable or callback parameter that runs over a list:
  `for (const r of R) r.channel = …`, `for (const [i, r] of R.entries()) r.channel = …` (also
  `values()`), `R.forEach((r) => { r.kind = … })` (also `map`, `filter`, `find`, `findLast`,
  `some`, `every`, `reduce`, `flatMap`), also through another name for the element
  (`const x = r; x.channel = …`), and a named callback (`R.forEach(tweak)`) that writes its
  parameter or is not a function of the file (`String`, `Boolean`, `Number`, `parseInt`,
  `parseFloat` and the URI coders only read);
- a function of the file the table is passed to that writes it at any depth (`tweak(R)` with
  `list[0].channel = …` in it);
- for the readers of tables built into IPC, also an alias that is written (`const U = T;
  U.c = …`) and passing it to a function whose body is not read (`register(T)`,
  `globalThis.mutate(T)`). These readers are: the members built from a table (the generated
  invokers and `api[k] = …` loops below), every loop over a list or over a table's keys
  (`for (const r of R) …`, `R.forEach(…)`, `for (const k of Object.keys(T)) ipcMain.on(T[k], …)`)
  and a member read by a key a loop finds (`T[k]`). A channel `T.k` or `T["k"]` (also `T[KEY]`
  with `KEY` a constant), endpoints, storage keys and window options take a table passed to such
  a function as it is written. Up to 0.9.8 the loops it read took such a table as written too.

Reads, in every reader: a member, `typeof`, a spread, `for … of`, a template (`` `${T}` ``),
another name for it that nothing writes (`const X2 = T`, `const y = T || {}`,
`const z = x ? T : null`), a test or comparison (`!T`, `T === x`, `T != null`, `case T:`,
`if (T)`, `while (T && T.A)`, and minified `T && f()`), the source of a destructuring
(`const { A } = T`), passing it to `console.*`, `JSON.stringify`, `String`, `structuredClone`,
`Array.isArray`, `Object.freeze` / `isFrozen` / `keys` / `entries` / `values` /
`getOwnPropertyNames`, or to a function of the file that does not write its parameter (read up to
three calls deep), and handing it on as a value: `module.exports = T`; an element of an array or
object literal bound to a declaration (`const L = [T]`, `const W = { x: T }`) when that name is
itself unchanged by the same rules; and `return T` from a named function whose every call's
result is discarded, destructured (`const { A } = get()`) or bound to a name that is unchanged
(`const r = get()`). A container or result used any other way may write the table:
`[T][0].A = …`, `L[0].A = …`, `W.x.B = …`, `get().A = …`, `get()["B"] = …`,
`Object.assign(get(), …)`, `r[k] = …`, a container passed to a call (`f({ T })`), a function
handed around. No use of the table at all: an object key
(`{ T: 2 }`), a class member (`class Q { T() {} }`), a label (`T: for (;;) { break T }`), and
another binding of the name: a parameter (`function h(T)`, `(a, T) => a`), a `catch (T)`, a
pattern element of its own (`function g({ T })`, `const { a: T } = o` in a function).

A table passed to a function of the file that writes one of its members (`function mut(o) {
o.A = … }`, `mut(T)`) changes it for every reader that reads it strictly (above); a literal key
(`T.A`, `T["A"]`) keeps reading it as written, as 0.9.8 did. This is a decision: the function's
writes are not followed to the keys they change. The query of a URL (`url.searchParams.set(…)`, `url.search = …`, `url.hash = …`) is no
change of the address a local `new URL(…)` holds. The same holds, for now, for a write through a container, a function's
result or an alias built with `||`, `??` or `?:` (`const L = [T]; L[0].A = …`,
`const y = T || {}; y.A = …`): the loops above do not read `T`, a literal key `T.A` still does,
as in 0.9.8.

Not seen: a write through what a method returns (`R.find(f).channel = …`), through an element
handed to a function (`for (const r of R) tweak(r)`), and a write in another module.

**Bridge members and senders from a channel table.** The forms:

| written in the preload                                                                                                    | members                     |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `{ ...Object.fromEntries(Object.entries(T).map(([m, ch]) => [m, (...a) => ipcRenderer.invoke(ch, ...a)])) }`              | one per key, with its value |
| the same through a function of the file, `function invokers(t) { return Object.fromEntries(…) }` and `{ ...invokers(T) }` | one per key                 |
| `exposeInMainWorld("x", Object.fromEntries(…))`, or a name declared as such                                               | one per key                 |
| `for (const [k, ch] of Object.entries(T)) api[k] = (...a) => ipcRenderer.send(ch, ...a)` after `const api = {…}`          | one per key                 |
| `Object.keys(T).forEach((k) => { api[k] = (...a) => ipcRenderer.invoke(T[k], ...a); })`                                   | one per key                 |
| `api["open"] = …` or `api[KEY] = …` with `KEY` a constant, outside any loop                                               | the key it names            |

The object must be read whole (a closed object, every key known), and every member must be a
function of the file whose body is exactly one call `ipcRenderer.<method>(<channel>, …)`: an
expression body or `{ return …; }`, the method one of `invoke`, `send`, `sendSync`,
`sendToHost`, `postMessage`, `on`, `once`, `addListener`. The member's channel is that first
argument, evaluated with the loop's binding; a channel that is not one whole string leaves the
member with `channel: null`. These give one entry with `member: null`
(`context_bridge_members_unreadable`), never a guessed member: a member that does anything else
first (`{ log(m); return ipcRenderer.invoke(ch); }`), a table that may have changed (above), a
spread of something else, a loop over keys known only at run time, and a write in a round after
anything that may skip it (see "Control flow" below). A write `api[k] = …` or `api.x = …` counts
only when `api` there is the binding of the exposed object: a parameter or local of the same
name, as minifiers reuse `e`, is another object. Electron Fiddle 0.38.0 and 0.39.0 each lost nine
false members of `window.__SENTRY_IPC__` that way (the writes of Sentry's enum IIFEs,
`function (e) { e.EVENT = "…" }`).

contextBridge copies the object when `exposeInMainWorld` is called, so only a write before the
call is a member: one in the same function body as the call, in source order, or in the callback
of an array method there (`forEach`, `map`, `filter`, `reduce`, …), which runs where it is
written. A write after the call is not exposed (also when the same object is exposed again
later: the second exposure takes the members written up to it, the first does not). When the
call is in a function that runs from the top of the file, the writes at the top are placed
against where it runs from: a function declared there whose every other mention is at the top
(`function expose() {…}` and `expose();`, `setTimeout(later, 0)`), or a function written in
place there (a listener `window.addEventListener("DOMContentLoaded", () => {…})`,
`process.once("loaded", …)`, an IIFE). A write at the top before that place is a member (before the
first call, when it is called more than once); one between two calls (`if (a) expose(); api.c =
…; if (!a) expose();`) may be exposed by the later call or not, and gives one entry with
`member: null`; one after the last call `expose()` is not exposed; one after a listener or a function handed on may run
before it or not, and gives one entry with `member: null`. A write in a function that runs from
the top before the exposure (`setup()` called there, also a function declared below and
hoisted, an IIFE) is a member as well. A write in a loop that the call is in too (`for (…) { if
(i === 1) expose(…); api.x = …; }`, also a loop without braces) may run before the call in a
later round, and gives one entry with `member: null`, as does a write inside any other function
(an event listener, a promise callback, a helper called from somewhere else). When the name is
assigned a whole new object (`let api = {}; …; api = { only }`), the members are those of the
object it holds at the call, read only when that is proven: every assignment of the name is in
the call's function before the call, and the last one is a statement `api = {…}` (or a part of a
comma sequence that is one, as minifiers join statements; also in a declaration list
`var { a } = x, api = {…}`) in the call's own block, not the body of a condition or loop;
anything else is one entry with `member: null`. Writes to the object before that assignment went
to the object it held then, and are no member. Not seen: a reassignment by destructuring
(`[api] = …`, `({ api } = …)`), which leaves the first object's members listed.

The senders are read with the same evaluation: `ipcRenderer.invoke(ch, ...a)` inside such a
callback gives one row per channel (`via: "resolved"`, method `element`). The list a `forEach` /
`map` callback or a `for … of` loop runs over may read a parameter of the function it is in
(`Object.entries(table)` in `invokers(table)`); it is then read once per call site of that
function, each with its binding. `T[k]` with `k` bound to one key reads that member (so
`for (const k of Object.keys(CH)) ipcMain.on(CH[k], f)` registers the values of `CH`, never its
keys). `Object.fromEntries(list,)`, `Object.entries(o,)` and `Object.freeze(o,)` with a trailing
comma read as without it.

**Receivers from a list of routes.** `for (const route of ROUTES) ipcMain[route.kind](route.channel,
route.fn)` gives one row per element. The method is the element's `kind` when that is one string
naming an IPC method of the object (`on`, `once`, `handle`, `handleOnce` for ipcMain; `on`,
`once`, `send`, `invoke`, `sendSync`, `postMessage` for ipcRenderer). Any other value gives the api
`ipcMain.[unknown]`: the channel is listed, and the call is neither a sender nor a receiver in
`ipcChannels`, `interfaces` and the release report. `ROUTES.forEach((r) => ipcMain.handle(r.channel,
r.fn))` and `for (const r of ROUTES) ipcMain.handle(r.channel, r.fn)` give one row per element too.
A computed method that is one string or a string constant (`ipcMain["handle"](…)`, `ipcMain[M](…)`
with `const M = "handle"`) is read as that method, in or outside a loop, as esbuild's minifier
writes the first form (`ipcMain.handle(…)`); before, both gave `ipcMain.[unknown]` in the source
and the bundle, and the minified build listed `ipcMain[M]` twice.
A list that may have changed (above, including `[...BASE, {…}]` spreads and writes to an element
or through the loop variable), an element that is not read (not an object, a channel from
`process.env`), and a call in a round after anything that may skip it give one row without a
channel (`ipc_channel_unresolved`; for the computed form with api `ipcMain.[unknown]`). This also
holds for the loops 0.9.8 read already. A channel named by a constant of another module
(`Channels.LIBRARY_LIST` with `const { Channels } = require("../shared/channels")`) is a reference
filled in once that module is read. A table there with computed entries
(`Object.freeze({ LIST: PREFIX + "list", OPEN: "doc:open" })`) now exports those entries too, read
by evaluation (listed in `evaluated`); up to this release only its literal entries were.

**Control flow in a round.** A member write or an IPC call that a round of a `for … of` loop or
of a `forEach` / `map` callback makes only after one of `if`, `else`, `continue`, `break`,
`return`, `throw`, `switch`, `case`, a nested `for` / `while` / `do`, `try`, `?`, `&&`, `||` or
`??` (anywhere before it in the round) is not made in every round: it gives an unreadable entry
or an unresolved row instead of one per element.

**ipcMain passed as an argument.** A method of a class or object literal, or a named function,
whose parameter `P` is used as an IPC object (`P.handle(…)`, also `on`, `once`, `handleOnce`,
`send`, `invoke`, `sendSync`, `postMessage`). The parameter must not be written in the body: an
assignment (`ipc = …`, `ipc ||= …`, `ipc++`), a `for (ipc of …)` or `for (ipc in …)` head, a
destructuring assignment (`({ ipc } = …)`, `[ipc] = …`), or a `var ipc` there make it another
object. Its call sites are found with the wrapper machinery (`wrappers.ts`): calls of the method on
a proven instance of the class (`new C`, `module.exports = new C()` reached through `require` or
`import`, re-exports, the module wrappers of esbuild and webpack, and in one bundle what the
bundled module assigns to its `module.exports`), and calls of the function by name, under the keys
it is exported as, and from other modules (`require("./x").register(ipcMain)`,
`const { register } = require("./x")`). Every other use of the function or method counts as a
call site too: `f.call(thisArg, X)` passes X, and `f.apply(…)`, `f.bind(…)`, `f` handed on as a
callback (`forEach(f)`, `setTimeout(f, …)`) or to another name pass something that is not read.
The calls on the parameter become rows only when there is at least one call site and every one
passes the same object: `ipcMain` (or `ipcRenderer`) itself, another name for it,
`electron.ipcMain`, or a parameter whose own call sites all pass it. A name `ipcMain` that is
declared where it is passed with a value that is not Electron's (`{ const ipcMain = new
EventEmitter(); register(ipcMain); }`) is that other object, when the value is provably not
Electron's: `new X(…)`, a literal, an object or array literal, a function or class, with nothing
after it. Any other value (`getIpc()`, a condition) may be Electron's ipcMain, and is read as
before. One call site that passes
anything else, or that is not read, gives no rows at all. The rows are in the file of the function,
at the call inside it, with `via: "parameter"` and `wrapper` naming it (`PrefsService.register`, a
minifier's name in a minified build); a call the object has no such method for
(`ipcRenderer.handle`) gives none, and a sending call through ipcRenderer has `args`.

Limits: a file is read for this when it calls `handle`, `handleOnce`, `invoke` or `sendSync`
on a parameter, whatever the parameter is named (`register(m) { m.handle(…) }`); for `on`,
`once`, `send` and `postMessage`, which other objects have too, only when its text also names
`ipc` (a parameter `ipc`, a comment, an import of `ipcMain`). Other modules are read for calls of a
function or method only when it looks like IPC: its parameter's name contains `ipc`, or it calls
`handle`, `handleOnce`, `invoke` or `sendSync` on it. A function in a module that another module
imports and that does not look like IPC gives no rows (its calls there are not read). This reading
of other modules is a stage of its own, apart from the one for channel-forwarding wrappers, so it
never takes from that stage's budgets. Per file at most 2,000 calls on parameters are read, with a
work budget of their own (400,000 token visits); past either the file gives no such rows, without
a limitation (as before this release, when none were read). A function declared inside another
one is looked for only in that function's body. When the stage of other modules may have missed
calls (an importer past its limit of 200 files or its budget, and for plain functions also more
than 256 calls of other modules' functions in one file), the methods of the classes and instances
a module exports, or the functions it exports, give none, and `ipc_wrappers_capped` names the files
that were not read to the end; a function only its own file calls is still decided there. Not read: `event.reply` inside a listener registered this way, an anonymous
function, an arrow function in a class field, and a nested destructuring pattern
(`({ a: { ipc } } = …)`).

**Budgets.** Per file, at most 256 IPC calls are read once per element of a list (the computed
`ipcMain[r.kind](…)` and the loops the scan leaves open); the later ones stay without a channel
(the computed form as `ipcMain.[unknown]`, with a reason) and are named in
`ipc_channel_unresolved`. The step-by-step members of an exposed object share the bridge walk's
budget (400,000 token visits per file, less the file's length): every `api[…] = …` costs 8 before
anything is read for it, and 2,000 more when it writes the exposed object itself and its loop is
read; an `api.x = …` that stays a member costs 8. Whether a write is to the exposed object is
charged to the resolver's own work, so writes to other bindings of the same name take nothing from
that budget. Past it the file's members are marked as cut (`context_bridge_truncated`). The walks
back to a loop and to a callback around a call are charged to the resolver's work for the file.

**Channel-forwarding functions of another module.** A function a module exports that passes its
first parameter on, whole, as the channel of an IPC call (`export function addHandler(channel,
handler) { ipcMain.handle(channel, …) }`, `export const ipcMainHandle = (channel, listener) =>
ipcMain.handle(channel, listener)`, the curried `export const makeHandlerInvoker = (channel) =>
(...args) => ipcRenderer.invoke(channel, ...args)`; the helpers `findWrappers` reads in one file)
gives a row at every call of it in another module, with the channel the call's first argument
names: `addHandler("x", f)` after `import { addHandler }` (also renamed, `{ handle as
handleOnMain }`), `ipc.addHandler(…)` after `import * as ipc`, `(0, ipc_1.addHandler)(…)` as tsc
writes it, `require("./ipc").addHandler(…)` and `const { addHandler } = require("./ipc")`. The
export counts when it is written as `export function f`, `export const f =`, `export { f as k }`,
`exports.k = f`, `module.exports.k = f` or `module.exports = { k: f }`, and nothing writes `f`
after its declaration. The rows have `via: "wrapper"` and `wrapper` naming the module and the
export (`ipc/heroic.addHandler`); the call inside the function stays without a channel, as in one
file. A parameter or local of the same name at the call is not the export. A helper whose body
writes its parameter (`channel = "x:" + channel`) is no forwarder, now also in one file (before,
its calls gave the channel as passed). The calls share the cross-module wrapper stage and its
limits (200 importing files, the work budget per file, `ipc_wrappers_capped`); per file at most
2,000 such calls are read, the rest named by `ipc_wrappers_capped` too. Not read: a call through
an import list longer than the file's constants read (about 200 names in one `import { … }`), which
gives no row and no limitation, and a forwarder declared inside a bundler's module wrapper.

**A module of the app under the name `ipcMain`.** A file that binds `ipcMain` or `ipcRenderer` to a
module of the application (a relative specifier: `import * as ipcMain from "./ipc-main"` as GitHub
Desktop writes it, `import ipcMain from "./x"`, `import { a as ipcMain } from "./x"`, `const ipcMain
= require("./x")`, also through `__importStar`, and `const { a: ipcMain } = require("./x")`) calls
that module. The direct `ipcMain.x` row is dropped only where the name is the module object
itself (`import * as ipcMain`, `const ipcMain = require("./x")`, also through `__importStar`),
the module is read and exports a channel-forwarding function of the method's name, and the row
through it (above) was given for that same call. A name taken out of the module (`const {
ipcMain } = require("./x")`) and every other case keep the direct row, as before: such a module may hand Electron's object on (`export { ipcMain } from
"electron"`, `module.exports = require("electron").ipcMain`). A key the module defines twice
(`exports.addHandler = a; exports.addHandler = b`), a forwarder the importer replaces
(`ipc.addHandler = …`, `Object.assign(ipc, …)`, `addHandler = …`), and a helper that calls IPC
with a parameter of the same name of an inner function (`forEach((channel) =>
ipcMain.handle(channel, …))`) give no rows through it.

**Channel helpers inside a bundled module.** A `function guarded(channel, fn) { ipcMain.handle(channel,
…) }` declared inside another function (the body of a module esbuild or webpack wraps, or an inner
helper) is now called wherever its name is bound to it in that scope, so its calls give the
channels (`via: "resolved"`, method `parameter`). Up to this release such a helper read as
shadowed at every call, and the bundled and minified builds of holdout6 missed `shot:save` and
`shot:share`, which the plain build read.

Corpus, before → after (hit/missed/false, per class): holdout6 IPC channels 52/12/0 → 64/0/0,
senders and receivers 89/23/0 → 136/0/0, bridge members 60/20/0 → 80/0/0, bridge member channel
60/0/0 → 80/0/0; holdout2 bridge members 129/6/0 → 133/2/0, senders and receivers 238/14/0 →
242/10/0, changes in contextBridge 1/1/0 → 2/0/0; holdout IPC channels 69/3/0 → 72/0/0, senders
and receivers 110/22/0 → 113/25/0 (the three channels now found in the minified time-tracker
build have preload senders that no build of it reads); holdout3, holdout4 and holdout5 unchanged.
Electron Fiddle 0.38.0 → 0.39.0: `ipc`, `ipcChannels` and the comparison unchanged, 51 members of
`window.ElectronFiddle`, 45 linked to a main-process end, as before.

## Payload shape of an IPC call (`ipc`, field `args`)

A new field in what a renderer sends on an existing channel does not change the channel list, so
the `ipc` row of a call that sends also records the shape of the arguments after the channel, as
written at the call: `ipcRenderer.send`, `invoke`, `sendSync`, `postMessage`, `webContents.send`,
`event.reply` and `event.sender.send` (also under another name, with a channel from a constant or
resolved, and the rows of a table of channels). Receivers (`on`, `handle`) have no `args`.

| written after the channel                 | `args`                         |
| ----------------------------------------- | ------------------------------ |
| nothing                                   | `()`                           |
| `{ dir, packageManager }, ...names`       | `({dir, packageManager}, ...)` |
| `{ b: 1, a, m() {}, "c-d": 2 }`           | `({a, b, "c-d", m})`           |
| `{ a, ...rest }`, `{ [k]: 1, a }`         | `({a, …})`                     |
| `id, () => x`, `f({ a })`, `{ a } \|\| b` | `(_, _)`, `(_)`, `(_)`         |

An object literal argument (exactly `{…}`, nothing after it) gives its property names, sorted by
code unit, shorthand, `key: value`, methods and accessors alike; a name that is not an identifier
or an integer is quoted. A `...spread` or a computed key leaves names unknown: the list then ends
in `…`, and nothing is guessed. A `...spread` argument is `...` (the number of arguments at run
time is not known); any other argument is `_`, a value that is not described further. At most 32
arguments and 64 names per object are written, with `… +N more` for the rest. A call whose
brackets do not close (a file read only in part) is `not read`.

`args` is compared as content; the identity of the row stays `module+api+channel`, so a changed
payload is one changed call, never a removed and an added one. Calls of one channel that repeat in
a file are paired by content first; those that then differ only in `args` are still paired, one to
one when there is one per side, otherwise as one changed item that lists every side's shapes. The
release report lists the `ipc` calls whose `args` changed (other `ipc` rows stay summary only,
as `ipcChannels` names them).

Electron Fiddle 0.38.0 → 0.39.0: `compare … ipc` gives `0 added, 0 removed, 1 changed`, the call
`.webpack/renderer/main_window/preload.js::ipcRenderer.invoke::NPM_ADD_MODULES` with `args:
"({dir, packageManager}, ...)" → "({dir, packageManager, useSocketFirewall}, ...)"`; its
`src/preload/preload.ts` diff is exactly that field. Before, all 157 rows were unchanged.

Not read: the payload of a call through a wrapper method or a channel-forwarding helper (`via:
wrapper`) or through a name another file defines (`via: global`): those rows have no `args`, as
the arguments of the wrapper are not necessarily what it sends. Keys are taken as written, not normalised: `{1.5: x}` and `{"1.5": x}`, `{0x10: x}` and `{16: x}`, `{["a"]: 1}` and `{a: 1}` give different shapes, as does a transpiler's spread helper (`_objectSpread({}, o, {a})` is `(_)`) against `{...o, a}`; `__proto__: p` counts as an unknown name. A comparison with an export written by 0.9.4 shows `args` on every sending call, as those rows have none. What a value argument holds (`_`),
the keys of an object held in a variable, and what the receiver reads from the payload.

## Optional chaining on IPC calls

An IPC call written with optional chaining gives the row of the plain call, with the same channel,
api, sender or receiver and `args`: `ipcRenderer?.send("x", …)`, `ipcRenderer.send?.("x")`,
`ipcMain?.handle(…)`, `event.sender?.send(…)`, `event?.reply(…)`, `win?.webContents?.send(…)`,
`contextBridge?.exposeInMainWorld(…)`. The call is made whenever the object is there, which is
what a row says of a plain call too. `?.` is read as `.` only before the names of IPC methods and
of the objects IPC is called on (`send`, `invoke`, `on`, `handle`, `reply`, `webContents`,
`sender`, `ipcRenderer`, …); elsewhere it stays as written.

The forms esbuild (and TypeScript, Babel) lower `?.` to for older targets are read the same way,
plain and minified: `X == null ? void 0 : X.send(…)`, `X == null || X.send(…)`,
`(_a = E) == null ? void 0 : _a.send(…)`, `(_a = E) === null || _a === void 0 ? void 0 :
_a.send(…)`, and for an optional call `(_a = E.send) == null ? void 0 : _a.call(E, …)`, also
`(_b = (_a = win.webContents).send) == null ? void 0 : _b.call(_a, …)`. Only where the receiver is
provably the same object: the temporary is assigned from a chain of names in the same
expression, and `.call` gets that chain (or the temporary it was assigned to) as its receiver.
Another name after the test (`(_a = ipcRenderer) == null ? void 0 : socket.send(…)`), another
receiver of `.call`, and `.apply(…)` give no row.

## Runtime of a packaged build (`runtime`)

A packaged build (a macOS `.app`, a Windows or Linux install directory, a release ZIP of either)
ships the Electron runtime next to the app, and hexvero reads its bytes; it runs nothing. An
`.asar` or app directory opened alone has no `runtime` list, and `data.runtime` says
`shipped: false` ("not shipped in this input").

| Row                                        | Read from                                                                                                                                                         | Known only when                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `electron`, `chromium`                     | the fragment `Chrome/<a.b.c.d> Electron/<x.y.z>` followed by a NUL byte, which Electron compiles into its binary for the user agent                               | every occurrence in the binary agrees (a universal macOS binary holds one per architecture) |
| `node`                                     | `https://nodejs.org/download/release/v<x.y.z>/node-v<x.y.z>.tar.gz` (and `-headers.tar.gz`), Node's `process.release` URLs                                        | every occurrence agrees                                                                     |
| `fuses`, `fuse.<name>`                     | the wire after `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`: a schema version byte, a count byte, one byte per fuse (`0` off, `1` on, `r` removed)                          | schema version 1 and the same byte at that position in every wire                           |
| `asarIntegrity`, `asarIntegrity:<archive>` | macOS `ElectronAsarIntegrity` in `Contents/Info.plist`; Windows the resource `Integrity/ElectronAsar` (a JSON list of `file`, `alg`, `value`) of the app's `.exe` | the record is there and readable; Linux is `unknown`                                        |
| `support`                                  | the end-of-life date of the Electron line in the snapshot of Electron's release data hexvero ships                                                                | the version is known and its line is in the snapshot                                        |

The binary is `Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`
(then the `Versions/Current` and top-level links, followed only inside the bundle) on macOS, and
on Windows and Linux a file of at least 1 MiB next to `resources/` that starts as a PE (`MZ`) or
ELF file and that the packaging names: electron-builder writes `<productName>.exe` on Windows
(productName defaults to `name`) and `<name>` in lower case on Linux, unless
`build.executableName` (or `build.win`/`build.linux`) says otherwise; @electron/packager and
Electron Forge use `executableName` or the app name. On Windows an `.exe` carrying the resource
`Integrity/ElectronAsar` counts too (the 8 largest are looked at; not in a ZIP). At most 4 such
files are scanned, and the 3 largest unnamed PE or ELF files next to them. When no named file
holds markers, up to 8 unnamed files are scanned, and one is taken only with both an Electron
user agent and a fuse wire (Electron has had fuses since version 12, while a helper can hold a
user agent alone); the `electron` row says it was taken by its markers. All files scanned for one build count against 2 GiB (by the bytes read); any unnamed file of the cross-check left unscanned (over that, or over 1 GiB) makes the reading `unknown`. When
any two scanned files hold Electron markers that disagree (versions or fuse wires), which is the runtime
is not known: every reading is `unknown`, with `electron_runtime_not_read` naming both, and the
app pick keeps its `electron_app_pick_unverified` warning. Passed over: `chrome-sandbox`, `chrome_crashpad_handler`, `crashpad_handler`, `Update.exe`, `squirrel.exe`, `elevate.exe` and libraries (`.so`, `.dll`, …);
at most 5,000 names are listed and the 64 largest files probed, and when nothing is found within those caps the reason says so. On Windows the integrity resource is taken only from an `.exe` that holds the Electron marker; otherwise it is `unknown`. Measured on 2026-10-18 on three installed
apps:

| App                         | Electron                | Chromium       | Node    | Fuse wire             | Integrity record                                                         |
| --------------------------- | ----------------------- | -------------- | ------- | --------------------- | ------------------------------------------------------------------------ |
| Claude 2.42304.0            | 44.7.2                  | 152.0.7977.149 | 24.21.0 | `010011011`           | `Resources/app.asar`: covers the loaded archive, the header hash matches |
| Discord 0.0.414 (universal) | 42.11.8 (2 occurrences) | 148.0.7778.280 | 24.19.0 | `001000011` (2 wires) | `Resources/default_app.asar` only: does not cover `app.asar`             |
| LM Studio 0.3.31            | 37.7.1                  | 138.0.7204.251 | 22.20.0 | `10110001` (8 fuses)  | `Resources/default_app.asar` only; Electron loads `app/`                 |

The versions agree with Electron's release data for those releases. The fuse names, in wire
order, are those of Electron's `build/fuses/fuses.json5` (`_version: 1`): `run_as_node`,
`cookie_encryption`, `node_options`, `node_cli_inspect`, `embedded_asar_integrity_validation`,
`only_load_app_from_asar`, `load_browser_process_specific_v8_snapshot`,
`grant_file_protocol_extra_privileges`, `wasm_trap_handlers`, written as in Electron's
[fuses guide][fuses] (`runAsNode`, …). An older Electron has fewer (Electron 37 and 40: eight);
a position past the nine is listed as `#10`, … with value `unknown`, and a wire of another schema
version names none.

The integrity record of the archive Electron loads is matched by name: on macOS the key
relative to `Contents` (`Resources/app.asar`), on Windows the path relative to the `.exe`,
compared in lower case (`resources\app.asar`), as Electron's `archive_win.cc` looks it up.
Electron's hash is the SHA-256 of the archive's header string; hexvero reads that header alone
(the 16-byte pickle and the header, up to 64 MiB) and says `matches` or `differs`. Entry paths are
normalized (`./`, `../` inside the build), each archive file is hashed once however many entries
name it, and at most 64 MiB of headers are hashed per build; past that an entry is `not compared`,
with the reason. That is all it
checks: whether Electron validates the archive at startup depends on the fuse
`embeddedAsarIntegrityValidation`, which the detail names.

Support is "supported", "past end of support" or "prerelease", always with the end-of-life date,
the snapshot date and the day it was judged on ("Electron 37.7.1 is past its end of support
(2026-01-15, from the snapshot of 2026-10-18, as of 2026-10-18)"); a date after the snapshot is
"planned", as Electron's schedule may move it. A line's end of life is the release day of the
next stable line, so on that day it is past. An alpha, beta or nightly of a line not yet past is
a "prerelease", not "supported". The
snapshot (`packages/core/src/data/electronReleases.ts`) holds every non-nightly release with its
date, Chromium and Node versions from <https://releases.electronjs.org/releases.json>, and per
major line the stable and end-of-life dates from <https://releases.electronjs.org/schedule.json>;
`node scripts/electron-releases.mjs` refreshes it (by hand, never in CI). Support status says
nothing about vulnerabilities. It is judged against the day of the analysis, so the same build
can be supported today and past end of support after the date.

Limits: a binary over 1 GiB is not scanned and every reading is `unknown` with the limitation
`electron_runtime_not_read` (as when the binary is missing); a Windows or Linux candidate inside a ZIP is inflated into memory only once its first bytes (read without inflating the entry) show a PE or ELF file (the macOS framework is taken by its name), and all the runtime candidates of one build inflated together stay within the target's size limit (512 MiB by default) and the ZIP's own inflate budget.
The binary is read in windows of 8 MiB with 256 bytes of overlap; at most 64 occurrences of each
marker are kept, and a 65th makes that value `unknown`, never a pick among them; at most 4,096
strings that start like a marker (` Electron/`, Node's URL prefix) are examined, and more make
the value `unknown` with that reason, so a file of repeats costs one pass. `Info.plist` and
the integrity resource are read up to 1 MiB, the PE resource directory up to 32 MiB.

Which app Electron runs in its resources directory depends on the version and on the fuse
`onlyLoadAppFromAsar` (`app.asar`, `app/`, `default_app.asar` since Electron 15.0.0-beta.6,
electron#30667 on main on 2021-09-09 and its backport #30900, in `shell/common/node_bindings.cc`
and on main `shell/browser/app_package.cc`; `app/` first before, `lib/browser/init.ts`;
`app.asar` alone with the fuse on, see the [fuses guide][fuses]). The fuse arrived in the same
change, so a schema 1 wire with 6 or more positions means `app.asar` first and one with fewer
means `app/` first and no such fuse; without a wire, the version decides, and 15.0.0 alphas,
betas 1 to 5 and the 15 and 16 nightlies stay open (`electron_app_pick_unverified`), as does a wire whose length disagrees with the version. Electron 14
and earlier cannot have the fuse. hexvero reads the binary only when the candidates there would
give different apps under these orders. A `package.json` that is JSON but not an object depends on
the version: Electron 45 and later pass over it (`app_package.cc`, `is_dict`); earlier versions
load it with `require` and run a list, string or number, while `null` makes them run no app
(`packageJson == null`: "Unable to find a valid app"). When the version is not read and the rule
changes the pick, the pick stays open (`electron_app_pick_unverified`).

## Not read

Content Security Policy, what a navigation or window-open handler checks,
`will-redirect` and the removed `new-window` event, permission request handlers, `<webview>` attributes, whether an IPC handler validates its sender
([Security, 17][sec]), and `webPreferences` keys other than `preload`, `nodeIntegration`,
`contextIsolation`, `sandbox`, `webSecurity`, `allowRunningInsecureContent`, `webviewTag`,
`nodeIntegrationInSubFrames`, `nodeIntegrationInWorker` and `enableRemoteModule`.

A change to an options object made in another module is not seen: a window that takes
`SECURE` from `require("./prefs")` reads the values `prefs.js` writes there, and a module that
imports the same object and changes it (`SECURE.sandbox = false`, `Object.assign(SECURE, …)`)
is not looked at. Only changes in the window's own file make a value computed.

Bridge exposures that can be missed without a flag: a privileged declaration in a destructuring
pattern longer than 4,000 tokens or reached through more than 8 aliases is not recorded, and in
`let a, b;` only `a` counts as declared there, so a later write to `b` can be taken for a write
to an outer binding of that name.

Navigation handlers are read by method name: any object with a `setWindowOpenHandler` method
gives a row (with `targetKind: webContents` when the receiver is not a known window). When the
same window registers a handler twice, both rows are listed; at run time the later registration
replaces the earlier one, and which one runs last is not established.

[bc]: https://www.electronjs.org/docs/latest/breaking-changes
[wp]: https://www.electronjs.org/docs/latest/api/structures/web-preferences
[sb]: https://www.electronjs.org/docs/latest/tutorial/sandbox
[sec]: https://www.electronjs.org/docs/latest/tutorial/security
[wc]: https://www.electronjs.org/docs/latest/api/web-contents
[fuses]: https://www.electronjs.org/docs/latest/tutorial/fuses
