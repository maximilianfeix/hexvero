import { describe, expect, it } from "vitest";
import { parseDotnet } from "../src/formats/dotnet.js";
import { parseGoBuildInfo } from "../src/formats/go.js";
import { parsePe } from "../src/formats/pe.js";
import { analyzeBinary } from "../src/analyzers/binary.js";
import { targetFromBytes } from "../src/target.js";
import { buildDotnetMetadata } from "./fixtures/dotnet.js";
import { buildGoInline, buildGoPointer } from "./fixtures/go.js";
import { buildPe } from "./fixtures/pe.js";

describe("parseGoBuildInfo", () => {
  it("decodes inline buildinfo with modules, replacements and settings", () => {
    const info = parseGoBuildInfo(buildGoInline(), () => null)!;
    expect(info.source).toBe("buildinfo");
    expect(info.goVersion).toBe("go1.22.3");
    expect(info.mainPath).toBe("github.com/acme/tool");
    expect(info.mainModule).toEqual({
      path: "github.com/acme/tool",
      version: "(devel)",
    });
    expect(info.dependencies).toEqual([
      {
        path: "golang.org/x/sys",
        version: "v0.20.0",
        sum: "h1:abc=",
        replacement: { path: "./forks/sys", version: "v0.0.0" },
      },
    ]);
    expect(info.settings).toMatchObject({
      "-ldflags": "-s -w",
      CGO_ENABLED: "1",
      "vcs.revision": "0123456789abcdef",
    });
    expect(info.findings.map((f) => f.kind)).toEqual(["go.stripped", "go.cgo", "go.vcs"]);
    expect(info.limitations).toEqual([]);
  });
  it("follows pointers through the VA resolver", () => {
    const info = parseGoBuildInfo(buildGoPointer(), (va) => Number(va))!;
    expect(info.goVersion).toBe("go1.17.2");
    expect(info.dependencies).toEqual([]);
  });
  it("falls back to a string scan", () => {
    const info = parseGoBuildInfo(new TextEncoder().encode("xx go1.21.0 yy"), () => null)!;
    expect(info.source).toBe("string-scan");
    expect(info.limitations[0]?.code).toBe("go_no_buildinfo");
    expect(parseGoBuildInfo(new Uint8Array(32), () => null)).toBeNull();
  });
});

describe("parseDotnet", () => {
  const bytes = buildPe({ clr: buildDotnetMetadata() });
  it("reads assembly, types, methods, P/Invokes and user strings", () => {
    const info = parseDotnet(bytes, parsePe(bytes));
    expect(info.runtimeVersion).toBe("v4.0.30319");
    expect(info.assembly).toEqual({
      name: "MyAsm",
      version: "1.2.3.4",
      culture: "",
      publicKey: false,
    });
    expect(info.assemblyRefs).toEqual([{ name: "mscorlib", version: "4.0.0.0" }]);
    expect(info.moduleRefs).toEqual(["kernel32.dll"]);
    expect(info.types.map((t) => `${t.namespace}.${t.name}`)).toEqual([".<Module>", "Bar.Foo"]);
    expect(info.types[1]).toMatchObject({
      visibility: "public",
      kind: "class",
      extends: "System.Object",
      methods: ["Main", "Run"],
    });
    expect(info.pinvokes).toEqual([{ dll: "kernel32.dll", entryPoint: "Beep", method: "Run" }]);
    expect(info.userStrings).toEqual(["Hello"]);
    expect(info.entryPointToken).toBe("0x06000001");
    expect(info.flags.ilOnly).toBe(true);
    expect(info.tableRows).toMatchObject({ TypeDef: 2, MethodDef: 2 });
  });
  it("is wired into analyzeBinary for PE targets", () => {
    const result = analyzeBinary(targetFromBytes(bytes, "MyAsm.dll"));
    expect(result.data.kind).toBe("pe");
    if (result.data.kind === "pe") expect(result.data.dotnet?.assembly?.name).toBe("MyAsm");
    expect(result.summary).toContain(".NET");
  });
});
