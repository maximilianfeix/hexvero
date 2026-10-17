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
  `get 1()`) may be any key. The limitation
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
replacement budget of the application"). Calls of a wrapper whose methods all count as replaced
are not read. A write to another object of the same method name (`srv.handle = f`, lodash's
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
  `import_electron.net.request(…)`).

The name must mean that binding at the call: a parameter of the name in a function between the
call and the binding (also in the parameter list the call stands in, `function f(https, a =
https.get(…))`), a `catch` binding, or another declaration of the name visible at the call
(`const|let|var|function|class NAME`, a destructuring pattern, `const { get } = o`, `[get] = o`,
a `for (const https of …)` head; a named function expression binds its name inside itself only)
is another object. A declaration of the name in another function or block shadows only there,
and a class field (`class A { https = 1 }`) or an object key binds nothing. An assignment whose
name means the binding (`h = mock`) makes it no proven client. The declarations of a name are
read once per file into ranges, so the check is linear.

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
`require` (`axios`, `got`, `ky`, `superagent`, `needle`) count the same way. The method is `GET`
for `get`, `POST` etc. for the verb methods, and for `request` the `method` option when the call
writes one.

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
versions), a client passed around as a value (`const l = net.request; l(url)`), wrappers called
from another module, and `fetch(new Request(url))`.

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
