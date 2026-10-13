import { describe, expect, it } from "vitest";
import { analyzeBinary } from "../src/analyzers/binary.js";
import { parseMacho } from "../src/formats/macho.js";
import { parseObjcMetadata } from "../src/formats/machoObjc.js";
import { demangleSwift, demangleSwiftClassName } from "../src/formats/swiftDemangle.js";
import { targetFromBytes } from "../src/target.js";
import { buildObjcMacho } from "./fixtures/machoObjc.js";

const expectGreeter = (bytes: Uint8Array, pointerFormat: string): void => {
  const macho = parseMacho(bytes);
  const objc = parseObjcMetadata(bytes, macho);
  expect(objc.pointerFormat).toBe(pointerFormat);
  expect(objc.limitations).toEqual([]);
  expect(objc.classes).toHaveLength(1);
  const greeter = objc.classes[0]!;
  expect(greeter).toMatchObject({
    name: "Greeter",
    superClass: "NSObject",
    isSwift: false,
    isMeta: false,
    protocols: ["Greeting"],
  });
  expect(
    greeter.methods.map(
      (m) => `${m.kind === "class" ? "+" : "-"}${m.name}:${m.types}@${m.implementation}`,
    ),
  ).toEqual([
    "-greet:@16@0:8@0x100004000",
    "-greet::v16@0:8@0x100004010",
    "+shared:@16@0:8@0x100004020",
  ]);
  expect(greeter.ivars).toEqual([{ name: "name", type: '@"NSString"', offset: 8 }]);
  expect(greeter.properties).toEqual([{ name: "name", attributes: 'T@"NSString",&,N,V_name' }]);
  expect(objc.protocols.map((p) => `${p.name}:${p.methods.map((m) => m.name).join(",")}`)).toEqual([
    "Greeting:greet",
  ]);
  expect(objc.categories).toEqual([
    {
      name: "Extras",
      className: "Greeter",
      methods: [
        { name: "wave", types: "v16@0:8", kind: "instance", implementation: "0x100004030" },
      ],
      protocols: [],
    },
  ]);
  expect(objc.selectorCount).toBe(2);
  expect(objc.findings.map((f) => f.kind)).toEqual(["objc.classes"]);
};

describe("parseObjcMetadata", () => {
  it("decodes classes, methods, ivars, properties, protocols and categories with absolute pointers", () => {
    expectGreeter(buildObjcMacho(), "absolute (dyld_info)");
  });
  it("decodes the same image through dyld chained fixups (rebase + bind)", () => {
    expectGreeter(buildObjcMacho({ chained: true }), "DYLD_CHAINED_PTR_64_OFFSET");
  });
  it("is attached to Mach-O analyses with collections-friendly data", () => {
    const result = analyzeBinary(targetFromBytes(buildObjcMacho({ chained: true }), "Greeter"));
    expect(result.data.kind).toBe("macho");
    if (result.data.kind === "macho") expect(result.data.objc?.classes[0]?.name).toBe("Greeter");
    expect(result.findings.map((f) => f.kind)).toContain("objc.classes");
  });
});

describe("Swift name recovery", () => {
  it("reads Objective-C visible Swift class names", () => {
    expect(demangleSwiftClassName("_TtC7it2core9APIClient")).toBe("it2core.APIClient");
    expect(
      demangleSwiftClassName(
        "_TtCV5Maccy22MouseMovedViewModifierP33_91A000BA8386CF59E70CA8865D68EE4211Coordinator",
      ),
    ).toBe("Maccy.MouseMovedViewModifier.(private).Coordinator");
    expect(demangleSwiftClassName("NSObject")).toBeNull();
  });
  it("recovers identifier paths and kinds from mangled symbols", () => {
    expect(demangleSwift("_$s8MyModule5HelloC5greetyyF")).toMatchObject({
      readable: "MyModule.Hello.greet(…)",
      kind: "function",
      module: "MyModule",
      approximate: true,
    });
    expect(demangleSwift("_$s8MyModule5HelloCMa")).toMatchObject({
      readable: "MyModule.Hello",
      kind: "metadata",
    });
    expect(demangleSwift("_$s8MyModule6ConfigV4nameSSvg")).toMatchObject({
      readable: "MyModule.Config.name",
      kind: "getter",
    });
    expect(
      demangleSwift(
        "_$s7it2core10CookieAuthO9appTarget33_F1DF1887B4D34C9C1F41E00112233445566LLSSvp",
      ),
    ).toMatchObject({ readable: "it2core.CookieAuth.appTarget" });
    expect(demangleSwift("_$s4Test3foo3barySi_tF")).toMatchObject({
      readable: "Test.foo(bar:)",
      labels: ["bar"],
      module: "Test",
    });
    expect(demangleSwiftClassName("_TtC4Test999No")).toBeNull();
    expect(demangleSwift("_main")).toBeNull();
  });
});
