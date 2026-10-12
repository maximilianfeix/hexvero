import type { ReactElement } from "react";
import { api, formatBytes, formatCount, type TargetRecord } from "../lib/api.js";
import { navigate } from "../lib/route.js";
import { useAsync } from "../lib/useAsync.js";
import { CollectionView } from "./CollectionView.js";
import { GraphView } from "./GraphView.js";
import { HexView } from "./HexView.js";
import { Overview } from "./Overview.js";
import { StringsView } from "./StringsView.js";

const FIXED_FIRST = ["overview", "findings"];
const HIDDEN = new Set(["findings", "limitations"]);

export function Workspace({
  target,
  tab,
  query,
}: {
  target: TargetRecord;
  tab: string;
  query: URLSearchParams;
}): ReactElement {
  const analysis = useAsync(`analysis:${target.id}`, () => api.analysis(target.id));
  const isDirectory = target.info.format === "directory";
  const collections = analysis.data?.collections ?? {};
  const dynamic = Object.entries(collections)
    .filter(([name, count]) => !HIDDEN.has(name) && count > 0)
    .map(([name]) => name);
  const tabs = [
    ...FIXED_FIRST,
    ...dynamic,
    ...(isDirectory ? [] : ["strings", "hex"]),
    ...(analysis.data?.data["kind"] === "javascript-app" ? ["graph"] : []),
  ];

  return (
    <>
      <div className="target-header">
        <div className="path-line">
          <span className="path">{target.info.path}</span>
          <span>{target.info.format}</span>
          {!isDirectory && <span>{formatBytes(target.info.size)}</span>}
          {target.info.sha256 && (
            <span title={target.info.sha256}>sha256 {target.info.sha256.slice(0, 16)}…</span>
          )}
          {analysis.data && <span>{analysis.data.durationMs} ms</span>}
          <a href={api.exportUrl(target.id)} download>
            Export JSON
          </a>
        </div>
        {analysis.loading && (
          <p className="verdict" style={{ color: "var(--ink-2)" }}>
            Reading {target.info.path.split(/[\\/]/).pop()}…
          </p>
        )}
        {analysis.error && (
          <p className="verdict" style={{ color: "var(--alert)" }}>
            {analysis.error.message}
          </p>
        )}
        {analysis.data && <h1 className="verdict">{analysis.data.summary}</h1>}
      </div>
      <nav className="tabs" role="tablist" aria-label="Views">
        {tabs.map((name) => (
          <button
            key={name}
            role="tab"
            className="tab"
            aria-selected={tab === name}
            onClick={() => navigate(target.id, name)}
            disabled={!analysis.data}
          >
            {label(name)}
            {collections[name] !== undefined && (
              <span className="count">{formatCount(collections[name]!)}</span>
            )}
          </button>
        ))}
      </nav>
      <section className="panel" role="tabpanel">
        {analysis.data && tab === "overview" && <Overview analysis={analysis.data} />}
        {analysis.data && tab === "findings" && <Overview analysis={analysis.data} findingsOnly />}
        {analysis.data && dynamic.includes(tab) && (
          <CollectionView targetId={target.id} name={tab} query={query} />
        )}
        {tab === "strings" && <StringsView targetId={target.id} query={query} />}
        {tab === "hex" && <HexView targetId={target.id} size={target.info.size} query={query} />}
        {analysis.data && tab === "graph" && <GraphView targetId={target.id} />}
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
