import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { select } from "./InterfaceMapView.js";

/** A history of URLs with state, as the browser keeps it (enough for select()). */
function fakeBrowser(start: string) {
  const entries: Array<{ url: string; state: unknown }> = [{ url: start, state: null }];
  let at = 0;
  const location = {
    get pathname() {
      return new URL(entries[at]!.url, "http://h").pathname;
    },
    get search() {
      return new URL(entries[at]!.url, "http://h").search;
    },
  };
  const history = {
    get state() {
      return entries[at]!.state;
    },
    pushState(state: unknown, _: string, url: string) {
      entries.splice(at + 1, Infinity, { url, state });
      at++;
    },
    replaceState(state: unknown, _: string, url: string) {
      entries[at] = { url, state };
    },
    back() {
      if (at > 0) at--;
    },
  };
  return {
    location,
    history,
    entries,
    current: () => entries[at]!.url,
    length: () => entries.length,
  };
}

describe("interface map selection and Back", () => {
  const saved = { window: globalThis.window, history: globalThis.history };
  let b: ReturnType<typeof fakeBrowser>;
  beforeEach(() => {
    b = fakeBrowser("/targets/t_1/interface-map");
    Object.assign(globalThis, {
      window: { location: b.location, history: b.history, dispatchEvent: () => true },
      history: b.history,
    });
  });
  afterEach(() => Object.assign(globalThis, saved));

  it("opening a selection is one entry; moving replaces it; closing goes back to the map", () => {
    select("m:api.save");
    expect(b.length()).toBe(2);
    select("c:save");
    expect(b.length()).toBe(2);
    expect(b.current()).toBe("/targets/t_1/interface-map?sel=c%3Asave");
    select(null);
    expect(b.current()).toBe("/targets/t_1/interface-map");
  });

  it("a selection that came with the link is closed in place", () => {
    b = fakeBrowser("/targets/t_1/interface-map?sel=m%3Aapi.save");
    Object.assign(globalThis, {
      window: { location: b.location, history: b.history, dispatchEvent: () => true },
      history: b.history,
    });
    select(null);
    expect(b.length()).toBe(1);
    expect(b.current()).toBe("/targets/t_1/interface-map");
  });
});
