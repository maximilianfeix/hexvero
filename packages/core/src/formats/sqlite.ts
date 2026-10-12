import type { Finding, Limitation } from "../model.js";
import { AnalysisError } from "../model.js";

export interface SqliteColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
}

export interface SqliteTable {
  name: string;
  kind: "table" | "view" | "virtual";
  sql: string;
  columns: SqliteColumn[];
  rowCount: number | null;
  sample: Array<Record<string, unknown>>;
}

export interface SqliteInfo {
  pageSize: number;
  encoding: string;
  userVersion: number;
  applicationId: number;
  journalMode: string;
  tables: SqliteTable[];
  indexes: Array<{ name: string; table: string; unique: boolean; sql: string }>;
  triggers: Array<{ name: string; table: string; sql: string }>;
  findings: Finding[];
  limitations: Limitation[];
}

interface DatabaseLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

async function openReadOnly(path: string): Promise<DatabaseLike> {
  let mod: {
    DatabaseSync: new (
      p: string,
      o: { readOnly: boolean; enableForeignKeyConstraints?: boolean },
    ) => DatabaseLike;
  };
  try {
    mod = (await import("node:sqlite")) as unknown as typeof mod;
  } catch {
    throw new AnalysisError(
      "provider_unavailable",
      "node:sqlite is unavailable; use Node.js 22.13+ or 24+",
      {},
    );
  }
  try {
    return new mod.DatabaseSync(path, { readOnly: true });
  } catch (error) {
    throw new AnalysisError(
      "malformed",
      `Cannot open SQLite database: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const safeIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Read-only schema inventory with row counts and a few sample rows per ordinary table. */
export async function inspectSqlite(
  path: string,
  options: { sampleRows?: number; countRows?: boolean } = {},
): Promise<SqliteInfo> {
  const db = await openReadOnly(path);
  const sampleRows = options.sampleRows ?? 3;
  const limitations: Limitation[] = [];
  const findings: Finding[] = [];
  try {
    const pragma = (name: string): unknown => {
      const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
      return row ? Object.values(row)[0] : null;
    };
    const master = db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Array<{
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }>;
    const tables: SqliteTable[] = [];
    for (const row of master.filter((m) => m.type === "table" || m.type === "view")) {
      const virtual = /^CREATE VIRTUAL TABLE/i.test(row.sql ?? "");
      const columns = (
        db.prepare(`PRAGMA table_info(${safeIdent(row.name)})`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
          pk: number;
          dflt_value: unknown;
        }>
      ).map((c) => ({
        name: c.name,
        type: c.type,
        notNull: c.notnull === 1,
        primaryKey: c.pk > 0,
        defaultValue:
          c.dflt_value === null || c.dflt_value === undefined ? null : String(c.dflt_value),
      }));
      let rowCount: number | null = null;
      let sample: Array<Record<string, unknown>> = [];
      if (row.type === "table" && !virtual) {
        try {
          if (options.countRows !== false)
            rowCount = Number(
              (
                db.prepare(`SELECT count(*) AS n FROM ${safeIdent(row.name)}`).get() as {
                  n: number;
                }
              ).n,
            );
          if (sampleRows > 0) {
            sample = (
              db
                .prepare(`SELECT * FROM ${safeIdent(row.name)} LIMIT ${Math.min(sampleRows, 50)}`)
                .all() as Array<Record<string, unknown>>
            ).map(normalizeRow);
          }
        } catch (error) {
          limitations.push({
            code: "sqlite_table_unreadable",
            message: `${row.name}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      tables.push({
        name: row.name,
        kind: virtual ? "virtual" : row.type === "view" ? "view" : "table",
        sql: row.sql ?? "",
        columns,
        rowCount,
        sample,
      });
    }
    const indexes = master
      .filter((m) => m.type === "index")
      .map((m) => ({
        name: m.name,
        table: m.tbl_name,
        unique: /CREATE UNIQUE/i.test(m.sql ?? ""),
        sql: m.sql ?? "",
      }));
    const triggers = master
      .filter((m) => m.type === "trigger")
      .map((m) => ({ name: m.name, table: m.tbl_name, sql: m.sql ?? "" }));

    const secretColumns = tables.flatMap((t) =>
      t.columns
        .filter((c) => /password|secret|token|api_?key|credential/i.test(c.name))
        .map((c) => `${t.name}.${c.name}`),
    );
    if (secretColumns.length)
      findings.push({
        kind: "sqlite.secret-columns",
        title: `${secretColumns.length} columns look like credentials`,
        detail: secretColumns.slice(0, 10).join(", "),
        confidence: "inferred",
      });
    const fts = tables.filter((t) => /fts[345]/i.test(t.sql)).length;
    if (fts)
      findings.push({
        kind: "sqlite.fts",
        title: `${fts} full-text search tables`,
        confidence: "confirmed",
      });
    const appId = Number(pragma("application_id") ?? 0);
    const known: Record<number, string> = {
      0x47504b47: "GeoPackage",
      0x53514c52: "SQLAR",
    };
    if (known[appId])
      findings.push({
        kind: "sqlite.application",
        title: `application_id marks a ${known[appId]} file`,
        confidence: "confirmed",
      });

    return {
      pageSize: Number(pragma("page_size") ?? 0),
      encoding: String(pragma("encoding") ?? ""),
      userVersion: Number(pragma("user_version") ?? 0),
      applicationId: appId,
      journalMode: String(pragma("journal_mode") ?? ""),
      tables,
      indexes,
      triggers,
      findings,
      limitations,
    };
  } finally {
    db.close();
  }
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Uint8Array)
      out[k] = {
        $blob: v.length,
        preview: Buffer.from(v.subarray(0, 16)).toString("hex"),
      };
    else if (typeof v === "bigint") out[k] = v.toString();
    else if (typeof v === "string" && v.length > 200) out[k] = `${v.slice(0, 200)}…`;
    else out[k] = v;
  }
  return out;
}
