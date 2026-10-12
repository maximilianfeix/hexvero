import type { ReactElement } from "react";
import {
  useCallback,
  useEffect,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import { api, formatBytes, type TargetRecord } from "./lib/api.js";
import { navigate, useRoute } from "./lib/route.js";
import { Workspace } from "./views/Workspace.js";

const THEME_KEY = "hexvero.theme";

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => {
    try {
      return (
        localStorage.getItem(THEME_KEY) ??
        (window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark")
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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();

  const refresh = useCallback(async () => {
    try {
      setTargets((await api.targets()).targets);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const openRecord = (record: TargetRecord): void => {
    setTargets((list) =>
      list.some((t) => t.id === record.id) ? list : [...list, record],
    );
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
    const input = event.currentTarget.elements.namedItem(
      "path",
    ) as HTMLInputElement;
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
    if (event.dataTransfer.files.length)
      void openFiles(event.dataTransfer.files);
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
          document.querySelector<HTMLInputElement>(
            ".toolbar input[type=search]",
          ) ?? document.querySelector<HTMLInputElement>(".topbar input")
        )?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const current = targets.find((t) => t.id === route.targetId) ?? null;

  return (
    <div
      className={`app${dragging ? " dragging" : ""}${
        sidebarOpen ? " sidebar-open" : ""
      }`}
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
        <a
          className="wordmark"
          href="/"
          onClick={(e) => (e.preventDefault(), navigate(null))}
        >
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
        <label className="btn primary">
          Open file
          <input
            id="file-input"
            type="file"
            multiple
            hidden
            onChange={(e) => e.target.files && void openFiles(e.target.files)}
          />
        </label>
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
                onClick={() => (
                  navigate(t.id, "overview"), setSidebarOpen(false)
                )}
              >
                <span className="name">{t.info.path.split(/[\\/]/).pop()}</span>
                <span className="meta">
                  {t.info.format} · {formatBytes(t.info.size)}
                </span>
              </button>

              <button
                className="close"
                aria-label={`Close ${t.info.path}`}
                onClick={() => void close(t.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className={`dropzone${dragging ? " active" : ""}`}>
          {busy ?? (
            <>
              Drop files here or press <strong>⌘O</strong>
            </>
          )}
        </div>
      </aside>

      <main className="workspace">
        {error && (
          <div
            className="empty"
            style={{ padding: "12px 24px", color: "var(--alert)" }}
          >
            {error}
          </div>
        )}
        {current ? (
          <Workspace
            key={current.id}
            target={current}
            tab={route.tab}
            query={route.query}
          />
        ) : (
          <section className="welcome">
            <h1>
              See what a file is before you trust it, run it or rebuild it.
            </h1>
            <p>
              hexvero reads executables, app bundles, databases and captures on
              this machine without executing them, and tells you what it found,
              how sure it is, and what it could not establish.
            </p>
            <ul className="formats">
              {[
                "ELF",
                "PE",
                "Mach-O",
                "Go",
                ".NET",
                "WebAssembly",
                "EVM bytecode",
                "SQLite",
                "plist",
                "Android APK",
                "Electron ASAR",
                "JavaScript",
                "source maps",
                "HAR",
              ].map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <p style={{ marginTop: 24 }}>
              Drop a file anywhere, open a path above, or run{" "}
              <code>hexvero analyze &lt;path&gt;</code> in your terminal.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
