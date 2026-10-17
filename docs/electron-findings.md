# Electron findings: conditions and sources

What hexvero says about an Electron application's windows, under which condition it says it, and
which page of Electron's documentation the statement rests on. The documentation was read on
2026-10-13 (the security guide's sections 13, 14 and 20 again on 2026-10-17); where Electron changes a rule, this file and `windowEffects()` in
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
  `x = this.retrieve(…)`). In a plain `function`, a method of an object literal or another class,
  `this` is something else, and the call does not count. A method belongs to the class whose body
  is directly around it; a method of an object literal inside a class method is not one.
- `x.name(…)` on an instance of the class (`x = new Name(…)` once) or on the object literal of
  helpers (declared once at the top of the file, also in a minifier's `var a = …, c = { … }`).
- `name(…)` for a function declared once (`function name`, `const name = …`) and never assigned
  again; `exports.name = function …` is a property, not a binding, and a plain `name(…)` is no
  call of it.
- A parameter, local, `catch (name)` or block declaration of the name around a call binds the
  name there, and that call does not count.

A class is the one written as `class Name`, `var Name = class` or `exports.Name = class`. Two
classes of one name in one file are not told apart by an instance `x.name(…)`.

A key is read when it is a literal, a constant, a template or `+` of those, or a member of a
compiled TypeScript string enum of the file, `GlobalSetting.theme` or `c.GlobalSetting.theme` as
webpack writes an import (`(function (e) { e.theme = "theme" })(u || (t.GlobalSetting = u = {}))`).
In front of the enum's name only a name the file binds to a module object counts
(`c = n(33271)`, `x = require("./x")`, `i = __toESM(require_x())`); which module that is, is not
looked at: the enum's name and member decide. `other.GlobalSetting.theme` on any other object is
not read as a storage key (IPC channels, read as before, take the enum's name and member whatever
the object in front is). The enum's name must mean the enum everywhere in the file: tsc's export chain
`t.A = t.GlobalSetting = t.B = void 0` announces it; any other binding of the name, and any write
to a member outside the definition (`GlobalSetting.theme = "other"`), makes it ambiguous, and
nothing is read through it. A member the enum does not have is not read.

A call whose key cannot be read keeps the row of the storage call inside the wrapper with
`value: null` and the parameter as `expression`, so an unread key is never hidden. Not read:
calls of a wrapper from another module (`local.get(KEY)` with `local` imported), a wrapper called
from a wrapper of another file, a key the wrapper takes from `this` (`this.prefix + key`), and
constants a minifier declares in a list (`var a = 1, K = "key"`) where the resolver does not read
them. At most 64 wrapper questions per file and 64 call sites per wrapper are read, each within the
resolver's work budget. In a file with more than 50,000 functions (`function` and `=>`) wrappers
are not followed per call at all (limitation `storage_wrappers_skipped`), and the resolver reads
at most 60,000 functions of a file. False keys are worse than unread ones: where a rule above is
not met, the key stays unread.

In a comparison, an unread key hides only items of its own kind in its file: an unread
`sessionStorage` key does not make a new `localStorage` key unknown.

## Not read

Electron fuses, Content Security Policy, what a navigation or window-open handler checks,
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
