/**
 * The five user questions, as units of work that are the same for both tools.
 *
 *   Q1  Which IPC channels exist and where?                 one unit per Electron input
 *   Q2  Which relevant Electron settings are set?           one unit per Electron input
 *   Q3  Which endpoints and storage keys can be evidenced?  one unit per Electron input
 *   Q4  What changed between two builds?                    one unit per pair of builds
 *   Q5  Which known native call path can be demonstrated?   one unit per native binary (and engine)
 *
 * The expectation files are read for three things only: which inputs exist, which lists a pair is
 * compared on, and which from/to pairs Q5 asks about. No expected answer is read.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { corpusDir } from "./common.mjs";

export const QUESTIONS = {
  Q1: {
    text: "Which IPC channels exist and where?",
    collections: ["ipcChannels", "contextBridge"],
    classes: ["IPC channels", "IPC senders and receivers", "bridge members", "bridge member channel"],
  },
  Q2: {
    text: "Which relevant Electron settings are set?",
    collections: ["webPreferences"],
    classes: ["window settings"],
  },
  Q3: {
    text: "Which endpoints and storage keys can be evidenced?",
    collections: ["endpoints", "storage"],
    classes: [
      "endpoints",
      "endpoint method",
      "requests with an unknown URL shown",
      "storage keys",
      "storage read/write/delete",
    ],
  },
  Q4: { text: "What changed between two builds?", classes: null /* every "changes in …" */ },
  Q5: { text: "Which known native call path can be demonstrated?", classes: ["call paths"] },
};

export async function loadPlan(sets) {
  const { loadCases } = await import(pathToFileURL(join(corpusDir, "cases.mjs")).href);
  const plan = { electron: [], pairs: [], native: [] };
  for (const c of loadCases(sets)) {
    if (c.kind === "electron") for (const input of c.inputs) plan.electron.push({ set: c.set, input });
    else if (c.kind === "compare")
      plan.pairs.push({ set: c.set, a: c.a, b: c.b, collections: Object.keys(c.expect.compare), electron: c.a.endsWith(".asar") });
    else if (c.kind === "native")
      for (const input of c.inputs)
        plan.native.push({ set: c.set, input, paths: (c.expect.paths ?? []).map((q) => ({ from: q.from, to: q.to })) });
  }
  return plan;
}

export const emptyElectron = () => ({
  complete: null,
  ipcChannels: [],
  webPreferences: [],
  contextBridge: [],
  endpoints: [],
  endpointsUnreadable: 0,
  storage: [],
});
