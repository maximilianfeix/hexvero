import { AnalysisError, page, type Page } from "./model.js";

/**
 * Unknowns ledger: material questions an investigation could not answer yet,
 * kept per session and exported with the analysis so a report never silently
 * drops them. Entries carry the evidence that was checked, not conclusions.
 */
export interface Unknown {
  id: string;
  targetId: string | null;
  question: string;
  /** What was already examined (collections, offsets, tools). */
  checked: string[];
  status: "open" | "resolved";
  resolution: string | null;
  /** Later resolutions never overwrite the first; they are appended here. */
  amendments: Array<{ at: string; resolution: string }>;
  createdAt: string;
  resolvedAt: string | null;
}

const LIMITS = {
  entries: 5000,
  question: 2000,
  checkedItems: 50,
  checkedItem: 500,
  resolution: 4000,
} as const;

const clean = (value: string, max: number, field: string): string => {
  const text = value.trim();
  if (!text) throw new AnalysisError("invalid_input", `${field} must not be empty`);
  if (text.length > max)
    throw new AnalysisError("too_large", `${field} exceeds ${max} characters`, { max });
  return text;
};

export class UnknownsLedger {
  private readonly items = new Map<string, Unknown>();
  private counter = 0;

  record(input: { targetId?: string | null; question: string; checked?: string[] }): Unknown {
    const question = clean(input.question, LIMITS.question, "question");
    const checked = (input.checked ?? [])
      .slice(0, LIMITS.checkedItems)
      .map((c) => c.trim().slice(0, LIMITS.checkedItem))
      .filter(Boolean);
    if (this.items.size >= LIMITS.entries) {
      const oldestResolved = [...this.items.values()].find((u) => u.status === "resolved");
      if (!oldestResolved) {
        throw new AnalysisError(
          "too_large",
          `The ledger holds ${LIMITS.entries} open unknowns; resolve or remove some first`,
          { max: LIMITS.entries },
        );
      }
      this.items.delete(oldestResolved.id);
    }
    const id = `u_${(++this.counter).toString(36).padStart(3, "0")}`;
    const entry: Unknown = {
      id,
      targetId: input.targetId ?? null,
      question,
      checked,
      status: "open",
      resolution: null,
      amendments: [],
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.items.set(id, entry);
    return entry;
  }

  resolve(id: string, resolution: string): Unknown {
    const entry = this.items.get(id);
    if (!entry) throw new AnalysisError("not_found", `no unknown ${id}`, { id });
    const text = clean(resolution, LIMITS.resolution, "resolution");
    if (entry.status === "resolved") {
      if (entry.amendments.length >= 20)
        throw new AnalysisError("too_large", `${id} already has 20 amendments`);
      entry.amendments.push({ at: new Date().toISOString(), resolution: text });
      return entry;
    }
    entry.status = "resolved";
    entry.resolution = text;
    entry.resolvedAt = new Date().toISOString();
    return entry;
  }

  remove(id: string): boolean {
    return this.items.delete(id);
  }

  list(
    filter: {
      targetId?: string | null;
      status?: Unknown["status"];
      offset?: number;
      limit?: number;
    } = {},
  ): Page<Unknown> {
    const all = [...this.items.values()].filter(
      (u) =>
        (filter.targetId === undefined || u.targetId === filter.targetId) &&
        (filter.status === undefined || u.status === filter.status),
    );
    return page(all, filter.offset ?? 0, Math.min(filter.limit ?? 100, 1000));
  }
}
