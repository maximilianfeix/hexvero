import { describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree } from "../src/javascript/app.js";
import { scriptSwitchRows } from "../src/javascript/switches.js";
import { auditApp } from "../src/audit.js";
import { buildAsar } from "./fixtures/asar.js";
import { timeLimit } from "./timeLimit.js";

const PKG = JSON.stringify(
  {
    name: "app",
    main: "main.js",
    scripts: {
      start: "cross-env ELECTRON_DISABLE_SECURITY_WARNINGS=true electron . --disable-web-security",
      debug: "electron ./dist --remote-debugging-port=9222 --inspect && echo done",
      build: "tsc -p . --watch",
      lint: "eslint --no-sandbox .",
    },
  },
  null,
  2,
);

describe("switches in package.json scripts", () => {
  it("reads switches after an electron command and the security-warnings variable", () => {
    const { rows, capped } = scriptSwitchRows(PKG);
    expect(capped).toBe(false);
    expect(rows.map((r) => [r.kind, r.name, r.value, r.dangerous, r.target])).toEqual([
      ["security-warnings", "ELECTRON_DISABLE_SECURITY_WARNINGS", "true", false, "scripts.start"],
      ["switch", "disable-web-security", null, true, "scripts.start"],
      ["switch", "remote-debugging-port", "9222", true, "scripts.debug"],
      ["switch", "inspect", null, false, "scripts.debug"],
    ]);
    // a switch of another command (tsc, eslint) is not Electron's
    expect(rows.some((r) => r.target === "scripts.build" || r.target === "scripts.lint")).toBe(
      false,
    );
    // the place is package.json at the script's line
    expect(rows[1]).toMatchObject({ file: "package.json", line: 5, targetKind: "process" });
  });

  it("reads nothing from invalid JSON or scripts that are not strings", () => {
    expect(scriptSwitchRows("{ not json").rows).toEqual([]);
    expect(scriptSwitchRows(JSON.stringify({ scripts: ["electron . --no-sandbox"] })).rows).toEqual(
      [],
    );
    expect(scriptSwitchRows(JSON.stringify({ scripts: { a: 1 } })).rows).toEqual([]);
  });

  it("makes a dangerous script switch an unsafe-switch audit finding of package.json", () => {
    const info = analyzeJavaScriptTree(
      asarTree(
        buildAsar({
          "package.json": PKG,
          "main.js": 'require("electron").app.whenReady();\n',
        }),
        "app.asar",
      ),
    );
    const switches = info.switches.filter((r) => r.file === "package.json");
    expect(switches.map((r) => r.name)).toContain("disable-web-security");
    const findings = auditApp(info).filter((f) => f.rule === "unsafe-switch");
    expect(findings.map((f) => f.key).toSorted()).toEqual([
      "switch disable-web-security",
      "switch remote-debugging-port",
    ]);
    expect(findings[0]!.where[0]).toMatchObject({ file: "package.json" });
  });

  it("stays bounded and says so on a hostile package.json", () => {
    // many scripts, each with many switches: rows stop at the cap, lines come from one index
    const scripts = Object.fromEntries(
      Array.from({ length: 5000 }, (_, i) => [`s${i}`, `electron . ${"--no-sandbox ".repeat(50)}`]),
    );
    const text = JSON.stringify({ scripts }, null, 2);
    const started = performance.now();
    const { rows, capped } = scriptSwitchRows(text);
    expect(performance.now() - started).toBeLessThan(timeLimit(2000));
    expect(capped).toBe(true);
    expect(rows.length).toBe(200);
    expect(rows[0]).toMatchObject({ target: "scripts.s0", line: 3 });
    // larger than any real package.json: not read
    expect(scriptSwitchRows(" ".repeat((4 << 20) + 1))).toEqual({ rows: [], capped: true });
  });
});
