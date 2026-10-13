// Reduces REA Evidence JSON to the facts the benchmark tasks ask for (what an agent would do with jq).
// usage: node rea-extract.mjs electron <analyze-javascript-application.json>
//        node rea-extract.mjs compare  <compare-application-versions.json>
import fs from "node:fs";
const [mode, file] = process.argv.slice(2);
const n = JSON.parse(fs.readFileSync(file, "utf8")).normalized_result;
const obs = (node) => node.observations ?? [];
if (mode === "electron") {
  const of = (k) => n.graph.nodes.filter((x) => x.kind === k);
  const out = {
    ipcChannels: [
      ...new Set(
        of("ipc-channel")
          .flatMap(obs)
          .map((o) => o.properties.channel),
      ),
    ].sort(),
    ipcOperations: of("ipc-channel")
      .flatMap(obs)
      .map(
        (o) =>
          `${o.properties.side}.${o.properties.operation} ${o.properties.channel} @${o.evidence.location.value?.source}:${o.evidence.location.value?.start.line}`,
      )
      .sort(),
    handlers: of("ipc-handler")
      .flatMap(obs)
      .map(
        (o) =>
          `${o.properties.operation} ${o.properties.channel} (${o.properties.handler_kind}) @${o.evidence.location.value?.source}:${o.evidence.location.value?.start.line}`,
      )
      .sort(),
    browserWindows: of("browser-window")
      .flatMap(obs)
      .map((o) => ({
        at: `${o.properties.source_path}:${o.evidence.location.value?.start.line}`,
        webPreferences: Object.fromEntries(
          o.properties.web_preferences.map((p) => [
            p.name,
            p.value.status === "literal" ? p.value.value : `<${p.value.status}>`,
          ]),
        ),
      })),
    contextBridge: of("context-bridge-api")
      .flatMap(obs)
      .map((o) => ({
        world: o.properties.world,
        key: o.properties.api_key,
        members: o.properties.members,
        unknownMembers: o.properties.unknown_members,
      })),
    preloads: of("electron-preload")
      .flatMap(obs)
      .map((o) => o.label),
    endpoints: of("endpoint")
      .flatMap(obs)
      .map((o) => `${o.properties.value} via ${o.properties.mechanism}`)
      .sort(),
    storage: of("storage")
      .flatMap(obs)
      .map((o) => `${o.properties.storage_kind}:${o.properties.name}`)
      .sort(),
    summary: n.summary,
    coverage: n.graph.coverage,
  };
  console.log(JSON.stringify(out, null, 1));
} else {
  const nodes = new Map();
  const collect = (o) => {
    if (Array.isArray(o)) o.forEach(collect);
    else if (o && typeof o === "object") {
      if (typeof o.node_id === "string" && o.kind && o.observations) nodes.set(o.node_id, o);
      Object.values(o).forEach(collect);
    }
  };
  collect(n.graph);
  const label = (id) => {
    const x = nodes.get(id);
    if (!x) return null;
    const o = obs(x)[0];
    return `${o?.label ?? ""}${o?.properties?.channel ? "" : ""}${x.identity?.key ? " {" + x.identity.key + "}" : ""}`;
  };
  const rows = n.items.map((i) => ({
    status: i.status,
    kind: i.node_kind,
    basis: i.match?.basis,
    confidence: i.match?.confidence,
    dims: (i.dimensions ?? []).join(","),
    left: label(i.left_node_id),
    right: label(i.right_node_id),
  }));
  console.log(
    JSON.stringify(
      {
        summary: n.summary,
        matching: n.matching,
        coverage: n.coverage,
        limitations: n.limitations,
      },
      null,
      1,
    ),
  );
  for (const r of rows
    .filter((r) => r.status !== "unchanged")
    .sort((a, b) => (a.kind + a.status).localeCompare(b.kind + b.status)))
    console.log(
      `${r.status.padEnd(8)} ${String(r.kind).padEnd(20)} basis=${r.basis} conf=${r.confidence} dims=[${r.dims}]  L=${r.left}  R=${r.right}`,
    );
}
