import type { Page } from "./api.js";

/**
 * Where the next page starts. The server says so in `next`; a page can hold fewer rows than were
 * asked for (the byte budget ran out), so adding the page size would skip rows.
 */
export function nextOffset(page: Page<unknown>): number | null {
  if (page.next !== undefined) return page.next;
  // an older server without `next`: what the page actually holds
  const end = page.offset + page.items.length;
  return page.truncated && end < page.total ? end : null;
}

/** The row shown shortened, and the full size of the item it stands for; null when none is. */
export function reducedRow(page: Page<unknown>): { index: number; bytes: number } | null {
  return page.itemTruncated && page.items.length > 0
    ? { index: 0, bytes: page.itemBytes ?? 0 }
    : null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
