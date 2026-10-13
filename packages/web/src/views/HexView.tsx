import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api, formatBytes } from "../lib/api.js";
import { navigate } from "../lib/route.js";

const CHUNK = 16 * 1024;

function useBytesPerRow(): number {
  const [n, setN] = useState(() => (window.innerWidth < 820 ? 8 : 16));
  useEffect(() => {
    const onResize = (): void => setN(window.innerWidth < 820 ? 8 : 16);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return n;
}

/** Windowed hex viewer: rows are virtualized over the file size; chunks load on demand and are cached. */
export function HexView({
  targetId,
  size,
  query,
}: {
  targetId: string;
  size: number;
  query: URLSearchParams;
}): ReactElement {
  const perRow = useBytesPerRow();
  const rows = Math.ceil(size / perRow);
  const parentRef = useRef<HTMLDivElement>(null);
  const [chunks, setChunks] = useState<Map<number, Uint8Array>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<number | null>(
    query.get("sel") ? Number(query.get("sel")) : null,
  );
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 22,
    overscan: 30,
  });
  const items = virtualizer.getVirtualItems();

  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? 0;
  useEffect(() => {
    const start = Math.floor((first * perRow) / CHUNK);
    const end = Math.floor((last * perRow) / CHUNK);
    for (let c = start; c <= end; c++) {
      if (chunks.has(c) || c * CHUNK >= size) continue;
      api.bytes(targetId, c * CHUNK, CHUNK).then(
        (w) => {
          const bytes = Uint8Array.from(w.hex.match(/../g) ?? [], (h) => parseInt(h, 16));
          setChunks((m) => (m.has(c) ? m : new Map(m).set(c, bytes)));
          setLoadError(null);
        },
        (e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)),
      );
    }
  }, [first, last, perRow, chunks, size, targetId, retry]);

  const byteAt = (offset: number): number | undefined =>
    chunks.get(Math.floor(offset / CHUNK))?.[offset % CHUNK];
  const jump = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const raw = (event.currentTarget.elements.namedItem("offset") as HTMLInputElement).value.trim();
    const off = raw.startsWith("0x") ? parseInt(raw, 16) : Number(raw);
    if (!Number.isFinite(off) || off < 0 || off >= size) return;
    setSelected(off);
    virtualizer.scrollToIndex(Math.floor(off / perRow), { align: "center" });
    navigate(targetId, "hex", { sel: String(off) }, true);
  };
  useEffect(() => {
    if (selected !== null)
      virtualizer.scrollToIndex(Math.floor(selected / perRow), {
        align: "center",
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
      if (selected === null || (e.target as HTMLElement | null)?.closest("input, select, textarea"))
        return;
      const delta =
        e.key === "ArrowLeft"
          ? -1
          : e.key === "ArrowRight"
            ? 1
            : e.key === "ArrowUp"
              ? -perRow
              : e.key === "ArrowDown"
                ? perRow
                : 0;
      if (!delta) return;
      e.preventDefault();
      const next = Math.min(size - 1, Math.max(0, selected + delta));
      setSelected(next);
      virtualizer.scrollToIndex(Math.floor(next / perRow));
      navigate(targetId, "hex", { sel: String(next) }, true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, perRow, size, targetId, virtualizer]);

  const decoded = useMemo(
    () => (selected === null ? null : decode(selected, byteAt, size)),
    [selected, chunks, size],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <form className="toolbar" onSubmit={jump}>
        <input
          className="input mono"
          name="offset"
          placeholder="Go to offset (0x1000 or 4096)"
          style={{ maxWidth: 260 }}
          aria-label="Go to offset"
        />
        <button className="btn" type="submit">
          Go
        </button>
        <span className="status">
          {formatBytes(size)} · {perRow} bytes per row · select a byte (click or arrow keys) to
          decode it
        </span>
      </form>
      {loadError && (
        <p className="empty" role="alert" style={{ color: "var(--alert)", padding: "8px 24px" }}>
          Could not read bytes: {loadError}{" "}
          <button
            type="button"
            className="btn"
            onClick={() => (setLoadError(null), setRetry((n) => n + 1))}
          >
            Retry
          </button>
        </p>
      )}
      <div className="hex">
        <div
          className="hex-scroll"
          ref={parentRef}
          tabIndex={0}
          role="region"
          aria-label="Hex dump; arrow keys move the selection"
          onFocus={() => {
            if (selected === null && size > 0) {
              setSelected(0);
              navigate(targetId, "hex", { sel: "0" }, true);
            }
          }}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {items.map((item) => {
              const base = item.index * perRow;
              const cells: ReactElement[] = [];
              let ascii: ReactElement[] = [];
              for (let i = 0; i < perRow && base + i < size; i++) {
                const off = base + i;
                const b = byteAt(off);
                const sel = off === selected;
                cells.push(
                  <span
                    key={i}
                    className={`byte${b === 0 ? " zero" : ""}${sel ? " sel" : ""}`}
                    onClick={() => (
                      setSelected(off),
                      navigate(targetId, "hex", { sel: String(off) }, true)
                    )}
                  >
                    {b === undefined ? "··" : b.toString(16).padStart(2, "0")}
                    {i === 7 && perRow === 16 ? "  " : " "}
                  </span>,
                );
                ascii.push(
                  <span key={i} className={sel ? "sel" : ""}>
                    {b === undefined ? " " : b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "."}
                  </span>,
                );
              }
              if (perRow === 8) ascii = [];
              return (
                <div
                  key={item.key}
                  className="hex-row"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <span className="off">{base.toString(16).padStart(8, "0")}</span>
                  <span>{cells}</span>
                  <span className="asc">{ascii}</span>
                </div>
              );
            })}
          </div>
        </div>
        <aside className="hex-side" aria-live="polite">
          <h3>
            {selected === null
              ? "Select a byte"
              : `Offset 0x${selected.toString(16)} (${selected})`}
          </h3>
          {decoded ? (
            <dl>
              {decoded.map(([k, v]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p style={{ color: "var(--ink-2)", margin: 0 }}>
              Integers and floats at the selected offset appear here, little- and big-endian.
            </p>
          )}
        </aside>
      </div>
    </>
  );
}

const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);

function decode(
  offset: number,
  byteAt: (o: number) => number | undefined,
  size: number,
): Array<[string, string]> | null {
  const take = (n: number): Uint8Array | null => {
    if (offset + n > size) return null;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const b = byteAt(offset + i);
      if (b === undefined) return null;
      out[i] = b;
    }
    return out;
  };
  const b8 = take(8);
  const b4 = take(4) ?? (b8 ? b8.subarray(0, 4) : null);
  const b2 = take(2) ?? (b4 ? b4.subarray(0, 2) : null);
  const b1 = take(1);
  if (!b1) return null;
  const out: Array<[string, string]> = [
    [
      "u8",
      `${b1[0]} (0x${b1[0]!.toString(16).padStart(2, "0")}, ${b1[0]!.toString(2).padStart(8, "0")})`,
    ],
  ];
  if (b2)
    out.push(["u16 LE / BE", `${view(b2).getUint16(0, true)} / ${view(b2).getUint16(0, false)}`]);
  if (b4) {
    out.push(["u32 LE / BE", `${view(b4).getUint32(0, true)} / ${view(b4).getUint32(0, false)}`]);
    out.push(["i32 LE / BE", `${view(b4).getInt32(0, true)} / ${view(b4).getInt32(0, false)}`]);
    out.push([
      "f32 LE / BE",
      `${view(b4).getFloat32(0, true).toPrecision(6)} / ${view(b4).getFloat32(0, false).toPrecision(6)}`,
    ]);
  }
  if (b8) {
    out.push([
      "u64 LE / BE",
      `${view(b8).getBigUint64(0, true).toString()} / ${view(b8).getBigUint64(0, false).toString()}`,
    ]);
    out.push(["u64 LE hex", `0x${view(b8).getBigUint64(0, true).toString(16)}`]);
    out.push([
      "f64 LE / BE",
      `${view(b8).getFloat64(0, true).toPrecision(8)} / ${view(b8).getFloat64(0, false).toPrecision(8)}`,
    ]);
  }
  const text = take(16);
  if (text)
    out.push([
      "ascii",
      Array.from(text, (b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join(""),
    ]);
  return out;
}
