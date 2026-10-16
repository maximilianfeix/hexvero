import { useEffect, useState } from "react";

/** Minimal history-based router: /targets/:id/:tab?query */
export interface Route {
  targetId: string | null;
  tab: string;
  query: URLSearchParams;
}

export function parseRoute(): Route {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const query = new URLSearchParams(window.location.search);
  if (parts[0] === "targets" && parts[1])
    return { targetId: parts[1], tab: parts[2] ?? "overview", query };
  if (parts[0] === "compare") return { targetId: null, tab: "compare", query };
  return { targetId: null, tab: "overview", query };
}

/*
 * URLs written here never carry the location hash: the session token arrives there once and is
 * removed on load (lib/api.ts), and no link may copy it along.
 */

/** The comparison of two open targets: /compare?a=…&b=… (filters in the query, see lib/compare). */
export function navigateCompare(
  a?: string,
  b?: string,
  replace = false,
  rest?: Record<string, string | undefined>,
): void {
  const q = new URLSearchParams();
  if (a) q.set("a", a);
  if (b) q.set("b", b);
  for (const [k, v] of Object.entries(rest ?? {})) if (v) q.set(k, v);
  go(`/compare${q.size ? `?${q}` : ""}`, replace);
}

/**
 * Changes some query keys of the current page and keeps the rest; `undefined` or `""` removes a
 * key. A pushed entry makes Back restore the previous state; `state` marks the entry.
 */
export function updateQuery(
  patch: Record<string, string | undefined>,
  options: { replace?: boolean; state?: Record<string, unknown> } = {},
): void {
  const q = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v) q.set(k, v);
    else q.delete(k);
  }
  go(
    `${window.location.pathname}${q.size ? `?${q}` : ""}`,
    options.replace ?? false,
    options.state,
  );
}

function go(url: string, replace: boolean, state: Record<string, unknown> | null = null): void {
  if (replace) window.history.replaceState(state, "", url);
  else window.history.pushState(state, "", url);
  window.dispatchEvent(new Event("hexvero:navigate"));
}

export function navigate(
  targetId: string | null,
  tab = "overview",
  query?: Record<string, string | undefined>,
  replace = false,
): void {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v) q.set(k, v);
  const path = targetId ? `/targets/${targetId}/${tab}` : "/";
  go(`${path}${q.size ? `?${q}` : ""}`, replace);
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseRoute);
  useEffect(() => {
    const update = (): void => setRoute(parseRoute());
    window.addEventListener("popstate", update);
    window.addEventListener("hexvero:navigate", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hexvero:navigate", update);
    };
  }, []);
  return route;
}
