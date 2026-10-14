import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { parseHar } from "../src/formats/har.js";
import { parsePlist } from "../src/formats/plist.js";
import { inspectSqlite } from "../src/formats/sqlite.js";
import { Builder } from "./fixtures/builder.js";

/** node:sqlite exists from Node 22.13 and 24; on 22.12 hexvero must say so instead of failing. */
const hasSqlite = (() => {
  try {
    createRequire(import.meta.url)("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

describe("parsePlist", () => {
  it("decodes XML plists with entities, nesting and typed values", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.app &amp; co</string>
  <key>Count</key><integer>42</integer>
  <key>Ratio</key><real>0.5</real>
  <key>Flag</key><true/>
  <key>Items</key><array><string>a</string><!-- comment --><string><![CDATA[<b>]]></string></array>
  <key>When</key><date>2024-01-02T03:04:05Z</date>
  <key>Blob</key><data>AQID</data>
</dict></plist>`;
    expect(parsePlist(new TextEncoder().encode(xml))).toEqual({
      CFBundleIdentifier: "com.example.app & co",
      Count: 42,
      Ratio: 0.5,
      Flag: true,
      Items: ["a", "<b>"],
      When: { $date: "2024-01-02T03:04:05Z" },
      Blob: { $data: "AQID" },
    });
  });
  it("decodes binary plists", () => {
    // Objects: 0 dict{1:2, 3:4}, 1 "name", 2 "hexvero", 3 "nums", 4 array[5,6], 5 int 7, 6 true
    const b = new Builder(false).ascii("bplist00");
    const offsets: number[] = [];
    offsets.push(b.length);
    b.u8(0xd2).u8(1).u8(3).u8(2).u8(4);
    offsets.push(b.length);
    b.u8(0x54).ascii("name");
    offsets.push(b.length);
    b.u8(0x57).ascii("hexvero");
    offsets.push(b.length);
    b.u8(0x54).ascii("nums");
    offsets.push(b.length);
    b.u8(0xa2).u8(5).u8(6);
    offsets.push(b.length);
    b.u8(0x10).u8(7);
    offsets.push(b.length);
    b.u8(0x09);
    const table = b.length;
    for (const o of offsets) b.u8(o);
    b.pad(b.length + 6)
      .u8(1)
      .u8(1)
      .u64(offsets.length)
      .u64(0)
      .u64(table);
    expect(parsePlist(b.done())).toEqual({ name: "hexvero", nums: [7, true] });
  });
  it("decodes shared objects once instead of expanding a fan-out chain", () => {
    // obj0 = [obj1 ×40], obj1 = [obj2 ×40], …, obj5 = 7: naive DFS would realize 40^5 leaves.
    const levels = 6;
    const fanOut = 40;
    const b = new Builder(false).ascii("bplist00");
    const offsets: number[] = [];
    for (let i = 0; i < levels - 1; i++) {
      offsets.push(b.length);
      b.u8(0xaf).u8(0x10).u8(fanOut);
      for (let k = 0; k < fanOut; k++) b.u8(i + 1);
    }
    offsets.push(b.length);
    b.u8(0x10).u8(7);
    const table = b.length;
    for (const o of offsets) b.u16(o);
    b.pad(b.length + 6)
      .u8(2)
      .u8(1)
      .u64(offsets.length)
      .u64(0)
      .u64(table);
    const value = parsePlist(b.done()) as unknown[];
    expect(value).toHaveLength(fanOut);
    expect((value[0] as unknown[])[0]).toBe((value[1] as unknown[])[0]);
  });
  it("rejects malformed XML", () => {
    expect(() => parsePlist(new TextEncoder().encode("<plist><dict><key>a</key></plist>"))).toThrow(
      /unexpected|unclosed/,
    );
  });
});

describe("parseHar", () => {
  const har = {
    log: {
      creator: { name: "Chrome", version: "130" },
      pages: [{}],
      entries: [
        {
          startedDateTime: "2024-01-01T00:00:00Z",
          time: 12.4,
          request: {
            method: "GET",
            url: "https://api.example.com/users/123?token=abc",
            headers: [{ name: "Authorization", value: "Bearer x" }],
          },
          response: {
            status: 200,
            content: { mimeType: "application/json; charset=utf-8", size: 512 },
            headers: [{ name: "set-cookie", value: "s=1" }],
          },
        },
        {
          startedDateTime: "2024-01-01T00:00:01Z",
          time: 3,
          request: {
            method: "GET",
            url: "https://api.example.com/users/456",
            headers: [],
          },
          response: {
            status: 404,
            content: { mimeType: "application/json", size: 10 },
            headers: [],
          },
        },
        {
          startedDateTime: "2024-01-01T00:00:02Z",
          time: 50,
          request: {
            method: "POST",
            url: "http://cdn.example.net/upload",
            headers: [{ name: "Cookie", value: "a=b" }],
            bodySize: 2048,
          },
          response: {
            status: 201,
            content: { mimeType: "text/plain", size: 1 },
            headers: [],
          },
        },
        {
          startedDateTime: "2024-01-01T00:00:03Z",
          time: 1,
          request: {
            method: "GET",
            url: "wss://live.example.com/socket",
            headers: [],
          },
          response: {
            status: 101,
            content: { mimeType: "", size: 0 },
            headers: [],
          },
          _webSocketMessages: [],
        },
      ],
    },
  };
  it("summarizes hosts, endpoints and security-relevant facts", () => {
    const info = parseHar(new TextEncoder().encode(JSON.stringify(har)));
    expect(info.creator).toBe("Chrome 130");
    expect(info.entries).toHaveLength(4);
    expect(info.hosts[0]).toEqual({
      host: "api.example.com",
      count: 2,
      bytes: 522,
    });
    expect(info.methods).toEqual({ GET: 3, POST: 1 });
    expect(info.statuses).toEqual({ "2xx": 2, "4xx": 1, "1xx": 1 });
    expect(info.apiEndpoints.map((e) => `${e.method} ${e.path}×${e.count}`)).toEqual([
      "GET /users/{id}×2",
      "POST /upload×1",
    ]);
    expect(info.secretsInUrls).toEqual([{ index: 0, param: "token" }]);
    expect(info.websockets).toEqual(["wss://live.example.com/socket"]);
    expect(info.entries[0]).toMatchObject({
      hasAuth: true,
      setsCookie: true,
      mimeType: "application/json",
    });
    expect(info.findings.map((f) => f.kind)).toEqual([
      "har.auth",
      "har.secret-in-url",
      "har.websocket",
      "har.plaintext",
      "har.api",
    ]);
  });
  it("rejects non-HAR JSON", () => {
    expect(() => parseHar(new TextEncoder().encode("{}"))).toThrow(/log.entries/);
    expect(() => parseHar(new TextEncoder().encode("nope"))).toThrow(/valid JSON/);
  });
});

describe("inspectSqlite", () => {
  const dir = mkdtempSync(join(tmpdir(), "hexvero-sqlite-"));
  const path = join(dir, "app.db");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it.skipIf(!hasSqlite)("inventories schema, counts rows and samples data read-only", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, api_token TEXT, avatar BLOB, created DEFAULT CURRENT_TIMESTAMP);
      CREATE UNIQUE INDEX users_email ON users(email);
      CREATE VIEW emails AS SELECT email FROM users;
      CREATE TRIGGER trg AFTER INSERT ON users BEGIN UPDATE users SET email = lower(email) WHERE id = NEW.id; END;
      INSERT INTO users (email, api_token, avatar) VALUES ('A@X.IO', 'tok', X'DEADBEEF'), ('b@x.io', NULL, NULL);
      PRAGMA user_version = 7;`);
    db.close();
    const info = await inspectSqlite(path);
    expect(info.userVersion).toBe(7);
    expect(info.pageSize).toBeGreaterThan(0);
    expect(info.tables.map((t) => `${t.kind}:${t.name}`)).toEqual(["table:users", "view:emails"]);
    const users = info.tables[0]!;
    expect(users.columns.map((c) => c.name)).toEqual([
      "id",
      "email",
      "api_token",
      "avatar",
      "created",
    ]);
    expect(users.columns[0]).toMatchObject({
      primaryKey: true,
      type: "INTEGER",
    });
    expect(users.columns[1]).toMatchObject({ notNull: true });
    expect(users.rowCount).toBe(2);
    expect(users.sample[0]).toMatchObject({
      email: "a@x.io",
      avatar: { $blob: 4, preview: "deadbeef" },
    });
    expect(info.indexes).toEqual([
      {
        name: "users_email",
        table: "users",
        unique: true,
        sql: "CREATE UNIQUE INDEX users_email ON users(email)",
      },
    ]);
    expect(info.triggers[0]).toMatchObject({ name: "trg", table: "users" });
    expect(info.findings.map((f) => f.kind)).toEqual(["sqlite.secret-columns"]);
  });
  it.skipIf(hasSqlite)("says which Node versions have SQLite when this one does not", async () => {
    await expect(inspectSqlite("/nonexistent.db")).rejects.toThrow(
      /node:sqlite is unavailable; use Node.js 22.13\+ or 24\+/,
    );
  });

  it.skipIf(!hasSqlite)("leaves no sidecar files and still reads a pending WAL", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const walDir = mkdtempSync(join(tmpdir(), "hexvero-wal-"));
    const file = join(walDir, "app.db");
    const writer = new DatabaseSync(file);
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1);");
    writer.close();
    expect(readdirSync(walDir)).toEqual(["app.db"]);
    expect((await inspectSqlite(file)).tables[0]?.rowCount).toBe(1);
    expect(readdirSync(walDir)).toEqual(["app.db"]);
    const live = new DatabaseSync(file);
    live.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO t VALUES (2);");
    const before = readdirSync(walDir).toSorted();
    expect((await inspectSqlite(file)).tables[0]?.rowCount).toBe(2);
    expect(readdirSync(walDir).toSorted()).toEqual(before);
    live.close();
    rmSync(walDir, { recursive: true, force: true });
  });

  it.skipIf(!hasSqlite)("reports unreadable files", async () => {
    await expect(inspectSqlite(join(dir, "missing.db"))).rejects.toThrow(/Cannot open/);
  });
});
