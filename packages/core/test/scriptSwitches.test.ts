import { describe, expect, it } from "vitest";
import { analyzeJavaScriptTree, asarTree } from "../src/javascript/app.js";
import { scriptSwitchRows } from "../src/javascript/switches.js";
import { auditApp } from "../src/audit.js";
import { buildAsar } from "./fixtures/asar.js";

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
    const rows = scriptSwitchRows(PKG);
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
    expect(scriptSwitchRows("{ not json")).toEqual([]);
    expect(scriptSwitchRows(JSON.stringify({ scripts: ["electron . --no-sandbox"] }))).toEqual([]);
    expect(scriptSwitchRows(JSON.stringify({ scripts: { a: 1 } }))).toEqual([]);
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
});
