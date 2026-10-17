import type { ReactElement } from "react";
import { api } from "../lib/api.js";
import { navigate } from "../lib/route.js";
import { useAsync } from "../lib/useAsync.js";
import { statusLine, Table, Toolbar } from "./CollectionView.js";

const PAGE = 500;
const TAGS = ["url", "path", "email", "ip", "format", "secret-ish", "base64-ish"];

export function StringsView({
  targetId,
  query,
}: {
  targetId: string;
  query: URLSearchParams;
}): ReactElement {
  const text = query.get("q") ?? "";
  const tag = query.get("tag") ?? "";
  const utf16 = query.get("utf16") === "1";
  const offset = Number(query.get("offset") ?? 0);
  const page = useAsync(`${targetId}:strings:${offset}:${text}:${tag}:${utf16}`, () =>
    api.strings(targetId, { offset, limit: PAGE, text, tag, utf16 }),
  );
  const set = (patch: Record<string, string | undefined>): void =>
    navigate(
      targetId,
      "strings",
      {
        q: text || undefined,
        tag: tag || undefined,
        utf16: utf16 ? "1" : undefined,
        offset: offset ? String(offset) : undefined,
        ...patch,
      },
      true,
    );
  const rows = (page.data?.items ?? []).map((s) => ({
    offset: `0x${s.offset.toString(16).padStart(8, "0")}`,
    value: s.value,
    tags: s.tags,
    encoding: s.encoding,
  }));
  return (
    <>
      <Toolbar
        text={text}
        onText={(q) => set({ q: q || undefined, offset: undefined })}
        status={
          page.data
            ? statusLine(page.data, text || tag)
            : page.error
              ? page.error.message
              : "Extracting…"
        }
      >
        <select
          className="input"
          style={{ maxWidth: 160 }}
          value={tag}
          onChange={(e) => set({ tag: e.target.value || undefined, offset: undefined })}
          aria-label="Filter by tag"
        >
          <option value="">All tags</option>
          {TAGS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <label className="btn quiet">
          <input
            type="checkbox"
            checked={utf16}
            onChange={(e) =>
              set({
                utf16: e.target.checked ? "1" : undefined,
                offset: undefined,
              })
            }
          />{" "}
          UTF-16
        </label>
      </Toolbar>
      <Table
        rows={rows}
        loading={page.loading}
        error={page.error}
        onRetry={page.retry}
        label="strings"
      />
      {page.data && (page.data.truncated || offset > 0) && (
        <div className="pager">
          <button
            className="btn"
            disabled={offset === 0}
            onClick={() => set({ offset: String(Math.max(0, offset - PAGE)) || undefined })}
          >
            Previous
          </button>
          <button
            className="btn"
            disabled={!page.data.truncated}
            onClick={() => set({ offset: String(offset + PAGE) })}
          >
            Next {PAGE}
          </button>
        </div>
      )}
    </>
  );
}
