import type { ReactElement } from "react";
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { api, formatBytes, type TargetRecord } from "./lib/api.js";
import { navigate, navigateCompare, useRoute } from "./lib/route.js";
import { visible } from "./lib/text.js";
import { CompareView } from "./views/CompareView.js";
import { Workspace } from "./views/Workspace.js";

const THEME_KEY = "hexvero.theme";
const MOD =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
/** What the parsers read, kept in step with the README's format table. */
const FORMATS = [
  "ELF",
  "PE",
  "Mach-O",
  "Go",
  ".NET",
  "WebAssembly",
  "EVM bytecode",
  "SQLite",
  "plist",
  "Android APK / DEX",
  "Java class / JAR",
  "ZIP",
  "Electron ASAR",
  "Apple .app bundles",
  "Flutter",
  "JavaScript bundles",
  "source maps",
  "HAR",
];

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => {
    try {
      return (
        localStorage.getItem(THEME_KEY) ??
        (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      );
    } catch {
      return "dark";
    }
  });
  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

export function App(): ReactElement {
  const route = useRoute();
  const [targets, setTargets] = useState<TargetRecord[]>([]);
  const [targetsLoaded, setTargetsLoaded] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const mainRef = useRef<HTMLElement>(null);
  const firstRoute = useRef(true);
  // A link or Back/Forward that replaces the view removes the focused element with it; focus would
  // fall to the page start. Put it on the workspace instead, so the next Tab continues there.
  const viewKey = `${route.targetId ?? ""}/${route.tab}`;
  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    const id = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body) mainRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [viewKey]);

  const refresh = useCallback(async () => {
    try {
      setTargets((await api.targets()).targets);
      setError(null);
      setTargetsLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const openRecord = (record: TargetRecord): void => {
    setTargets((list) => (list.some((t) => t.id === record.id) ? list : [...list, record]));
    navigate(record.id, "overview");
    setSidebarOpen(false);
  };

  const openFiles = async (files: FileList | File[]): Promise<void> => {
    for (const file of Array.from(files)) {
      setBusy(`Reading ${file.name}…`);
      try {
        openRecord(await api.upload(file));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    setBusy(null);
  };

  const openPath = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("path") as HTMLInputElement;
    const path = input.value.trim();
    if (!path) return;
    setBusy(`Opening ${path}…`);
    try {
      openRecord(await api.openPath(path));
      input.value = "";
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };

  const close = async (id: string): Promise<void> => {
    await api.close(id);
    setTargets((list) => list.filter((t) => t.id !== id));
    if (route.targetId === id) navigate(null);
  };

  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void openFiles(event.dataTransfer.files);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === "o") {
        e.preventDefault();
        document.getElementById("file-input")?.click();
      }
      if (e.key === "Escape") setSidebarOpen(false);
      const editing = (e.target as HTMLElement | null)?.closest(
        "input, textarea, select, [contenteditable]",
      );
      if (e.key === "/" && !editing) {
        e.preventDefault();
        (
          document.querySelector<HTMLInputElement>(".toolbar input[type=search]") ??
          document.querySelector<HTMLInputElement>(".topbar input")
        )?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [demoBusy, setDemoBusy] = useState(false);
  const openDemo = async (): Promise<void> => {
    setDemoBusy(true);
    setBusy("Opening the example builds…");
    try {
      const { a, b } = await api.demo();
      setTargets((list) => [...list, ...[a, b].filter((t) => !list.some((x) => x.id === t.id))]);
      setError(null);
      navigateCompare(a.id, b.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
    setDemoBusy(false);
  };

  const current = targets.find((t) => t.id === route.targetId) ?? null;

  return (
    <div
      className={`app${dragging ? " dragging" : ""}${sidebarOpen ? " sidebar-open" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="topbar">
        <button
          className="btn quiet"
          aria-label="Toggle targets"
          onClick={() => setSidebarOpen((o) => !o)}
          style={{ display: "none" }}
          id="sidebar-toggle"
        >
          ☰
        </button>
        <a className="wordmark" href="/" onClick={(e) => (e.preventDefault(), navigate(null))}>
          <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="var(--panel-2)" />
            <path
              d="M9 8v16M23 8v16M9 16h14"
              stroke="var(--amber)"
              strokeWidth="3.2"
              strokeLinecap="round"
            />
          </svg>
          hexvero
        </a>
        <form onSubmit={openPath}>
          <input
            className="input mono"
            name="path"
            placeholder="Open a path on this machine, e.g. /usr/bin/ssh or ./app.asar"
            autoComplete="off"
            spellCheck={false}
          />
          <button className="btn" type="submit" disabled={busy !== null}>
            Open path
          </button>
        </form>
        <button
          type="button"
          className="btn primary"
          onClick={() => fileInput.current?.click()}
          disabled={busy !== null}
        >
          Open file
        </button>
        <input
          id="file-input"
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => e.target.files && void openFiles(e.target.files)}
        />
        <button
          type="button"
          className="btn"
          aria-current={route.tab === "compare" && !route.targetId ? "page" : undefined}
          onClick={() => {
            const [a, b] = targets.slice(-2).map((t) => t.id);
            navigateCompare(a, b);
          }}
        >
          Compare
        </button>
        <span className="status" aria-live="polite">
          {visible(busy ?? "")}
        </span>
        <span className="spacer" />
        <button
          className="btn quiet"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          {theme === "dark" ? "Light" : "Dark"}
        </button>
        <span className="local-badge">local only</span>
      </header>

      <aside className="sidebar">
        <h2>Targets</h2>
        <ul className="target-list">
          {targets.map((t) => (
            <li key={t.id} className="target-row">
              <button
                className="target-item"
                aria-current={t.id === route.targetId}
                onClick={() => (navigate(t.id, "overview"), setSidebarOpen(false))}
              >
                <span className="name" title={visible(t.info.path)}>
                  {visible(t.info.path.split(/[\\/]/).pop() ?? "")}
                </span>
                <span className="meta">
                  {t.info.format} · {formatBytes(t.info.size)}
                </span>
              </button>

              <button
                className="close"
                aria-label={`Close ${visible(t.info.path)}`}
                onClick={() => void close(t.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className={`dropzone${dragging ? " active" : ""}`}>
          {busy !== null ? (
            visible(busy)
          ) : (
            <>
              Drop files here or press <strong>{MOD}O</strong>
            </>
          )}
        </div>
      </aside>

      <main className="workspace" ref={mainRef} tabIndex={-1}>
        {error && (
          <div
            className="empty"
            role="alert"
            style={{
              padding: "12px 24px",
              color: "var(--alert)",
              display: "flex",
              gap: 12,
              alignItems: "center",
            }}
          >
            <span style={{ flex: 1 }}>{visible(error)}</span>
            <button type="button" className="btn quiet" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}
        {route.tab === "compare" && !route.targetId ? (
          targetsLoaded ? (
            <CompareView
              targets={targets}
              query={route.query}
              onDemo={() => void openDemo()}
              demoBusy={demoBusy}
            />
          ) : (
            <TargetsLoading error={error} onRetry={() => void refresh()} />
          )
        ) : current ? (
          <Workspace key={current.id} target={current} tab={route.tab} query={route.query} />
        ) : route.targetId && !targetsLoaded ? (
          <TargetsLoading error={error} onRetry={() => void refresh()} />
        ) : route.targetId ? (
          <section className="welcome">
            <h1>This target is no longer open.</h1>
            <p>
              The server was restarted or the target was closed. Open the file again to continue.
            </p>
            <p>
              <button
                type="button"
                className="btn primary"
                onClick={() => fileInput.current?.click()}
              >
                Open file
              </button>{" "}
              <button type="button" className="btn" onClick={() => navigate(null)}>
                Back to start
              </button>
            </p>
          </section>
        ) : (
          <Welcome
            onDemo={() => void openDemo()}
            demoBusy={demoBusy}
            onOpenFile={() => fileInput.current?.click()}
            fileBusy={busy !== null}
          />
        )}
      </main>
    </div>
  );
}

/** The start screen: one job (review an Electron release), the example first, your build second. */
export function Welcome({
  onDemo,
  demoBusy,
  onOpenFile,
  fileBusy,
}: {
  onDemo: () => void;
  demoBusy: boolean;
  onOpenFile: () => void;
  fileBusy: boolean;
}): ReactElement {
  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <h1 id="welcome-title">Review an Electron release.</h1>
      <p>
        See which IPC channels, preload members, window settings and network hosts changed between
        two builds, each traced to the file and line it was read from. Everything is read on this
        machine; nothing is run.
      </p>
      <div className="welcome-actions">
        <button type="button" className="btn primary" onClick={onDemo} disabled={demoBusy}>
          {demoBusy ? "Opening…" : "Compare example releases"}
        </button>
        <button type="button" className="btn" onClick={onOpenFile} disabled={fileBusy}>
          Open your build
        </button>
      </div>
      <p className="welcome-inputs">
        Reads an <code>app.asar</code>, a <code>.app</code> bundle, an install directory or a
        release ZIP. Drop it anywhere or open its path above.
      </p>
      <ol className="steps">
        <li>
          <span>
            <strong>Inspect.</strong> Open a build: IPC channels, preload members, window settings,
            endpoints. A filled dot is read from the file, a hollow one inferred from a pattern.
          </span>
        </li>
        <li>
          <span>
            <strong>Compare.</strong> Open the next build and press Compare: what was added, removed
            or changed, list by list.
          </span>
        </li>
        <li>
          <span>
            <strong>Verify.</strong> Every change links to the line it was read from. What could not
            be established is listed, not hidden.
          </span>
        </li>
      </ol>
      <details className="formats-more">
        <summary>Other formats</summary>
        <ul className="formats">
          {FORMATS.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </details>
      <p className="welcome-cli">
        In a terminal: <code>npx hexvero demo</code>
      </p>
    </section>
  );
}

/** Before the list of open targets arrives; a failed request says so instead of waiting on. */
function TargetsLoading({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}): ReactElement {
  if (!error)
    return (
      <section className="welcome" aria-busy="true">
        <p>Loading targets…</p>
      </section>
    );
  return (
    <section className="welcome">
      <h1>The open targets could not be loaded.</h1>
      <p>The error is shown above.</p>
      <p>
        <button type="button" className="btn primary" onClick={onRetry}>
          Retry
        </button>
      </p>
    </section>
  );
}
