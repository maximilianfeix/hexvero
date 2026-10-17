import type { KeyboardEvent, ReactElement } from "react";
import { useState } from "react";
import {
  api,
  formatBytes,
  formatCount,
  type AnalysisResponse,
  type TargetRecord,
} from "../lib/api.js";
import { navigate, navigateCompare } from "../lib/route.js";
import { visible } from "../lib/text.js";
import { useAsync } from "../lib/useAsync.js";
import { CollectionView } from "./CollectionView.js";
import { GraphView } from "./GraphView.js";
import { HexView } from "./HexView.js";
import { InterfaceMapView } from "./InterfaceMapView.js";
import { Overview } from "./Overview.js";
import { SourceView } from "./SourceView.js";
import { StringsView } from "./StringsView.js";

const FIXED_FIRST = ["overview", "findings"];
const HIDDEN = new Set(["findings", "limitations"]);

/** The views this target offers, in tab order; `tab` adds the source view while it is open. */
export function tabsFor(
  target: TargetRecord,
  tab: string,
  analysis: AnalysisResponse | null,
): string[] {
  const collections = analysis?.collections ?? {};
  const app = analysis?.data["kind"] === "javascript-app";
  return [
    ...FIXED_FIRST,
    ...Object.entries(collections)
      .filter(([name, count]) => !HIDDEN.has(name) && count > 0)
      .map(([name]) => name),
    ...(target.info.format === "directory" ? [] : ["strings", "hex"]),
    ...(app && (collections["interfaces"] ?? 0) > 0 ? ["interface-map"] : []),
    ...(app ? ["graph"] : []),
    ...(tab === "source" ? ["source"] : []),
  ];
}

export function Workspace({
  target,
  tab,
  query,
}: {
  target: TargetRecord;
  tab: string;
  query: URLSearchParams;
}): ReactElement {
  const [attempt, setAttempt] = useState(0);
  const [scanning, setScanning] = useState<"continue" | "all" | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const scanMore = (mode: "continue" | "all"): void => {
    setScanning(mode);
    setScanError(null);
    api
      .scanMore(target.id, mode)
      .then(
        () => setAttempt((n) => n + 1),
        (error: unknown) =>
          setScanError(
            `${error instanceof Error ? error.message : String(error)} What was read before is kept.`,
          ),
      )
      .finally(() => setScanning(null));
  };
  const analysis = useAsync(`analysis:${target.id}:${attempt}`, () => api.analysis(target.id));
  const standalone = new Set(["strings", "hex"]);
  const onTabKey = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const names = tabs.filter((name) => analysis.data || standalone.has(name));
    const index = names.indexOf(tab);
    const next =
      event.key === "ArrowRight"
        ? names[(index + 1) % names.length]
        : event.key === "ArrowLeft"
          ? names[(index - 1 + names.length) % names.length]
          : event.key === "Home"
            ? names[0]
            : event.key === "End"
              ? names[names.length - 1]
              : undefined;
    if (next) {
      event.preventDefault();
      navigate(target.id, next);
      (event.currentTarget.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus();
    }
  };
  const isDirectory = target.info.format === "directory";
  const collections = analysis.data?.collections ?? {};
  const dynamic = Object.entries(collections)
    .filter(([name, count]) => !HIDDEN.has(name) && count > 0)
    .map(([name]) => name);
  const tabs = tabsFor(target, tab, analysis.data);
  const offered = tabs.includes(tab);

  return (
    <>
      <div className="target-header">
        <div className="path-line">
          <span className="path">{visible(target.info.path)}</span>
          <span>{target.info.format}</span>
          {!isDirectory && <span>{formatBytes(target.info.size)}</span>}
          {target.info.sha256 && (
            <span title={target.info.sha256}>sha256 {target.info.sha256.slice(0, 16)}…</span>
          )}
          {analysis.data && <span>{analysis.data.durationMs} ms</span>}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setExportError(null);
              api
                .exportJson(target.id)
                .catch((error: unknown) =>
                  setExportError(error instanceof Error ? error.message : String(error)),
                );
            }}
          >
            Export JSON
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => navigateCompare(target.id, undefined)}
          >
            Compare with another build
          </button>
          {exportError && (
            <span role="alert" style={{ color: "var(--alert)" }}>
              Export failed: {exportError}
            </span>
          )}
        </div>
        {analysis.loading && (
          <p className="verdict" role="status" style={{ color: "var(--ink-2)" }}>
            Reading {visible(target.info.path.split(/[\\/]/).pop() ?? "")}…
          </p>
        )}
        {analysis.error && (
          <p className="verdict" role="alert" style={{ color: "var(--alert)" }}>
            {analysis.error.message}{" "}
            <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          </p>
        )}
        {analysis.data && <h1 className="verdict">{analysis.data.summary}</h1>}
        {analysis.data?.coverage && !analysis.data.coverage.complete && (
          <div className="partial" role="status">
            {analysis.data.coverage.remaining > 0 ? (
              <p>
                <strong>Partial analysis.</strong> {analysis.data.coverage.scanned.toLocaleString()}{" "}
                of {analysis.data.coverage.total.toLocaleString()} JavaScript files have been read;{" "}
                {analysis.data.coverage.remaining.toLocaleString()} are unread. Findings, tables and
                the graph cover the scanned part only.
              </p>
            ) : (
              <p>
                <strong>Incomplete analysis.</strong>{" "}
                {analysis.data.coverage.skipped.toLocaleString()} of{" "}
                {analysis.data.coverage.total.toLocaleString()} JavaScript files could not be read,
                or the folder holds more files than were listed. Findings, tables and the graph
                cover the rest only; the limitations below say why.
              </p>
            )}
            {analysis.data.coverage.remaining > 0 && (
              <div className="partial-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={scanning !== null}
                  onClick={() => scanMore("continue")}
                >
                  {scanning === "continue" ? "Reading…" : "Read next batch"}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={scanning !== null}
                  onClick={() => scanMore("all")}
                >
                  {scanning === "all" ? "Reading…" : "Read all remaining files"}
                </button>
                {scanError && (
                  <span role="alert" style={{ color: "var(--alert)" }}>
                    {scanError}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <nav className="tabs" aria-label="Views" onKeyDown={onTabKey}>
        {tabs.map((name) => (
          <button
            key={name}
            type="button"
            data-tab={name}
            className="tab"
            aria-current={tab === name ? "page" : undefined}
            onClick={() => navigate(target.id, name)}
            disabled={!analysis.data && !standalone.has(name)}
          >
            {label(name)}
            {collections[name] !== undefined && (
              <span className="count">{formatCount(collections[name]!)}</span>
            )}
          </button>
        ))}
      </nav>
      <section className="panel" aria-label={label(tab)}>
        {analysis.data && tab === "overview" && <Overview analysis={analysis.data} />}
        {analysis.data && tab === "findings" && <Overview analysis={analysis.data} findingsOnly />}
        {analysis.data && dynamic.includes(tab) && (
          <CollectionView targetId={target.id} name={tab} query={query} />
        )}
        {offered && tab === "strings" && <StringsView targetId={target.id} query={query} />}
        {offered && tab === "hex" && (
          <HexView targetId={target.id} size={target.info.size} query={query} />
        )}
        {analysis.data && offered && tab === "interface-map" && (
          <InterfaceMapView targetId={target.id} query={query} />
        )}
        {analysis.data && offered && tab === "graph" && <GraphView targetId={target.id} />}
        {analysis.data && !offered && (
          <p className="empty">
            This target has no {label(tab).toLowerCase()} view.{" "}
            <button
              type="button"
              className="btn"
              onClick={() => navigate(target.id, "overview", undefined, true)}
            >
              Show the overview
            </button>
          </p>
        )}
        {tab === "source" && <SourceView targetId={target.id} query={query} />}
      </section>
    </>
  );
}

const LABELS: Record<string, string> = {
  overview: "Overview",
  findings: "Findings",
  strings: "Strings",
  hex: "Hex",
  graph: "Module graph",
  "interface-map": "Interface map",
  goDependencies: "Go dependencies",
  ipcChannels: "IPC channels",
  userStrings: "User strings",
  assemblyRefs: "Assembly refs",
  sourceMaps: "Source maps",
};
const label = (name: string): string =>
  LABELS[name] ??
  name.charAt(0).toUpperCase() +
    name
      .slice(1)
      .replace(/([A-Z])/g, " $1")
      .toLowerCase();
