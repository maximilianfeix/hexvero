/**
 * What to look at next, derived from an analysis without guessing: each suggestion names a
 * question a person or an agent would ask about this kind of target, and the exact call that
 * answers it. Suggestions only point at data that exists in this analysis.
 */
import type { AnyAnalysis } from "./analyzers/dispatch.js";

export interface NextStep {
  question: string;
  /** The MCP tool and arguments, with the target id left to the caller. */
  tool: string;
  args: Record<string, unknown>;
  /** The same as a CLI command; `<path>` stands for the target. */
  cli: string;
}

const MAX_STEPS = 4;

const page = (question: string, collection: string, text?: string): NextStep => ({
  question,
  tool: "hexvero_collection",
  args: { collection, ...(text ? { text } : {}) },
  cli: `hexvero collection <path> ${collection}${text ? ` --text ${text}` : ""}`,
});

export function suggestNextSteps(
  analysis: AnyAnalysis,
  collections: Record<string, number>,
): NextStep[] {
  const has = (name: string): boolean => (collections[name] ?? 0) > 0;
  const steps: NextStep[] = [];
  const data = analysis.data;
  if (data.kind === "javascript-app") {
    const coverage = data.app.coverage;
    if (coverage.remaining > 0)
      steps.push({
        question: `Read the ${coverage.remaining} files that are still unread before concluding anything is absent`,
        tool: "hexvero_analyze",
        args: { scan: "all" },
        cli: "hexvero analyze <path> --all",
      });
    if (has("ipcChannels"))
      steps.push(page("Which IPC channels can a page reach, and who handles them?", "ipcChannels"));
    if (has("contextBridge"))
      steps.push(page("What does the preload script expose to web content?", "contextBridge"));
    if (has("webPreferences"))
      steps.push(page("Which window settings are written, and where?", "webPreferences"));
    if (has("endpoints")) steps.push(page("Which servers does the code talk to?", "endpoints"));
    if (has("storage")) steps.push(page("What does it keep in local storage?", "storage"));
    if (has("ipcChannels"))
      steps.push({
        question: "What changed in a newer build?",
        tool: "hexvero_compare",
        args: { collection: "ipcChannels" },
        cli: "hexvero compare <old> <new> ipcChannels",
      });
  } else if (data.kind === "binary") {
    if (has("imports")) steps.push(page("Which library functions does it call?", "imports"));
    steps.push({
      question: "Which strings look like URLs or hosts?",
      tool: "hexvero_strings",
      args: { tag: "url" },
      cli: "hexvero strings <path> --tag url",
    });
    if (has("libraries")) steps.push(page("Which libraries does it load?", "libraries"));
    steps.push({
      question: "Who calls what, starting at main? (needs radare2, rizin or Ghidra)",
      tool: "hexvero_call_graph",
      args: { root: "main", direction: "callees" },
      cli: "hexvero calls <path> radare2 main",
    });
  } else if (data.kind === "javascript") {
    if (has("bundleModules"))
      steps.push({
        question: "Read the bundle as separate module files",
        tool: "hexvero_recover",
        args: { outputDir: "<empty directory>" },
        cli: "hexvero recover <path> <empty directory>",
      });
    if (has("endpoints")) steps.push(page("Which servers does the code talk to?", "endpoints"));
    if (has("storage")) steps.push(page("What does it keep in local storage?", "storage"));
  } else if (data.kind === "apk") {
    if (has("permissions")) steps.push(page("Which permissions does it request?", "permissions"));
    if (has("components"))
      steps.push(page("Which components can other apps start?", "components", "exported"));
  } else if (data.kind === "har") {
    if (has("endpoints")) steps.push(page("Which API endpoints were called?", "endpoints"));
  }
  // Whatever the format: the list with the most items is where detail lives.
  if (steps.length < 2) {
    const biggest = Object.entries(collections)
      .filter(([name, n]) => n > 0 && name !== "findings" && name !== "limitations")
      .toSorted((a, b) => b[1] - a[1])[0];
    if (biggest) steps.push(page(`Page through ${biggest[0]} (${biggest[1]} items)`, biggest[0]));
  }
  return steps.slice(0, MAX_STEPS);
}
