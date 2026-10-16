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

/** The comparison of two open targets: /compare?a=…&b=… */
export function navigateCompare(a?: string, b?: string, replace = false): void {
  const q = new URLSearchParams();
  if (a) q.set("a", a);
  if (b) q.set("b", b);
  const url = `/compare${q.size ? `?${q}` : ""}${window.location.hash}`;
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
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
  const url = `${path}${q.size ? `?${q}` : ""}${window.location.hash}`;
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  window.dispatchEvent(new Event("hexvero:navigate"));
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
