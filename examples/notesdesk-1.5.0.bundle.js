/******/ (() => { // webpackBootstrap
/******/ var __webpack_modules__ = ({

/***/ "./src/api.js":
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {
__webpack_require__.r(__webpack_exports__);
__webpack_require__.d(__webpack_exports__, { sync: () => sync, telemetry: () => telemetry });
const BASE = "https://api.notesdesk.example/v1";
async function sync(notes) {
  const token = localStorage.getItem("notesdesk.token");
  const res = await fetch(BASE + "/notes/sync", { method: "POST", headers: { Authorization: "Bearer " + token }, body: JSON.stringify(notes) });
  return res.json();
}
async function telemetry(event) {
  if (localStorage.getItem("notesdesk.telemetry") !== "on") return;
  await fetch("https://telemetry.notesdesk.example/collect", { method: "POST", body: JSON.stringify({ event, ts: Date.now() }) });
}
/***/ }),

/***/ "./src/editor.js":
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {
__webpack_require__.r(__webpack_exports__);
__webpack_require__.d(__webpack_exports__, { Editor: () => Editor });
class Editor {
  constructor(root) { this.root = root; this.root.innerHTML = '<textarea id="note"></textarea><button id="save">Save</button>'; }
  value() { return this.root.querySelector("#note").value; }
  onSave(fn) { this.root.querySelector("#save").addEventListener("click", fn); }
}
/***/ }),

/***/ "./src/index.js":
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {
__webpack_require__.r(__webpack_exports__);
var _editor_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__("./src/editor.js");
var _api_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__("./src/api.js");
var _util_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__("./src/util.js");
const editor = new _editor_js__WEBPACK_IMPORTED_MODULE_0__.Editor(document.getElementById("app"));
editor.onSave(async () => {
  const note = { id: (0,_util_js__WEBPACK_IMPORTED_MODULE_2__.uid)(), text: editor.value(), at: Date.now() };
  await window.notesdesk.saveNote(note);
  const notes = await window.notesdesk.listNotes();
  if (await window.notesdesk.getSetting("sync")) await (0,_api_js__WEBPACK_IMPORTED_MODULE_1__.sync)(notes);
  (0,_api_js__WEBPACK_IMPORTED_MODULE_1__.telemetry)("note.saved");
});
window.notesdesk.checkUpdate().catch(() => {});
/***/ }),

/***/ "./src/util.js":
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {
__webpack_require__.r(__webpack_exports__);
__webpack_require__.d(__webpack_exports__, { uid: () => uid });
const uid = () => Math.random().toString(36).slice(2, 10);
/***/ })

/******/ });
/******/ var __webpack_module_cache__ = {};
/******/ function __webpack_require__(moduleId) {
/******/ var cachedModule = __webpack_module_cache__[moduleId];
/******/ if (cachedModule !== undefined) { return cachedModule.exports; }
/******/ var module = __webpack_module_cache__[moduleId] = { exports: {} };
/******/ __webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ return module.exports;
/******/ }
/******/ __webpack_require__.d = (exports, definition) => { for (var key in definition) { if (!Object.prototype.hasOwnProperty.call(exports, key)) Object.defineProperty(exports, key, { enumerable: true, get: definition[key] }); } };
/******/ __webpack_require__.r = (exports) => { Object.defineProperty(exports, "__esModule", { value: true }); };
/******/ __webpack_require__("./src/index.js");
/******/ })();
