// Messages the main process pushes to windows.
// Compiled from events.ts (a string enum); the shape below is what tsc emits.
export var Push;
(function (Push) {
  Push["MenuNewEntry"] = "menu:new-entry";
  Push["UpdateReady"] = "update:ready";
})(Push || (Push = {}));
