import { describe, expect, it } from "vitest";
import { parseDex } from "../src/formats/dex.js";
import { detectFormat } from "../src/formats/detect.js";
import { parseJar, parseJavaClass } from "../src/formats/java.js";
import { buildClass } from "./fixtures/java.js";
import { buildDex } from "./fixtures/dex.js";
import { buildZip } from "./fixtures/zip.js";

describe("parseJavaClass", () => {
  it("reads the constant pool, members and references", () => {
    const c = parseJavaClass(buildClass());
    expect(c.name).toBe("com.example.Hello");
    expect(c.superClass).toBe("java.lang.Object");
    expect(c.interfaces).toEqual(["java.lang.Runnable"]);
    expect(c.version).toEqual({ major: 61, minor: 0, java: "17" });
    expect(c.flags).toEqual(["public", "super"]);
    expect(c.sourceFile).toBe("Hello.java");
    expect(c.fields).toEqual([
      { name: "count", descriptor: "I", flags: ["private"] },
    ]);
    expect(
      c.methods.map((m) => `${m.name}${m.descriptor}:${m.flags.join("|")}`),
    ).toEqual([
      "main([Ljava/lang/String;)V:public|static",
      "crunch()V:private|native",
    ]);
    expect(c.strings).toEqual(["hello world"]);
    expect(c.referencedMethods).toEqual([
      "java.lang.Runtime.exec(Ljava/lang/String;)Ljava/lang/Process;",
    ]);
    expect(c.referencedClasses).toEqual([
      "java.lang.Object",
      "java.lang.Runnable",
      "java.lang.Runtime",
    ]);
    expect(c.findings.map((f) => f.kind)).toEqual(["java.native", "java.exec"]);
    expect(detectFormat(buildClass(), "Hello.class")).toBe("java-class");
  });
  it("rejects non-class input", () => {
    expect(() => parseJavaClass(new Uint8Array(30))).toThrow(
      /not a Java class/,
    );
  });
});

describe("parseJar", () => {
  const jar = buildZip({
    "META-INF/MANIFEST.MF":
      "Manifest-Version: 1.0\r\nMain-Class: com.example.Hello\r\nCreated-By: 17.0.2\r\n Continued\r\n",
    "com/example/Hello.class": buildClass(),
    "com/example/util/Other.class": buildClass(),
    "lib/dep.jar": "zip",
    "META-INF/CERT.SF": "sig",
    "config.properties": "a=b",
  });
  it("inventories manifest, packages and classes", () => {
    expect(detectFormat(jar, "app.zip")).toBe("jar");
    const info = parseJar(jar);
    expect(info.manifest).toEqual({
      "Manifest-Version": "1.0",
      "Main-Class": "com.example.Hello",
      "Created-By": "17.0.2Continued",
    });
    expect(info.mainClass).toBe("com.example.Hello");
    expect(info.classCount).toBe(2);
    expect(info.packages).toEqual([
      { name: "com.example", classes: 1 },
      { name: "com.example.util", classes: 1 },
    ]);
    expect(info.classes[0]).toMatchObject({
      name: "com.example.Hello",
      java: "17",
      methods: 2,
    });
    expect(info.signed).toBe(true);
    expect(info.nestedJars).toEqual(["lib/dep.jar"]);
    expect(info.resources).toBe(4);
    expect(info.findings.map((f) => f.kind)).toEqual([
      "java.native",
      "java.exec",
      "jar.main",
      "jar.nested",
      "jar.version",
    ]);
  });
});

describe("parseDex", () => {
  it("reads header counts, classes and packages", () => {
    const dex = buildDex();
    expect(detectFormat(dex, "classes.dex")).toBe("dex");
    const info = parseDex(dex);
    expect(info.version).toBe("035");
    expect(info.counts).toMatchObject({
      strings: 5,
      types: 3,
      methods: 7,
      classes: 2,
    });
    expect(info.classes).toEqual([
      {
        name: "com.example.App",
        superClass: "java.lang.Object",
        flags: ["public"],
        sourceFile: "App.java",
      },
      {
        name: "a.b",
        superClass: "java.lang.Object",
        flags: ["final"],
        sourceFile: null,
      },
    ]);
    expect(info.packages).toEqual([
      { name: "com.example", classes: 1 },
      { name: "a", classes: 1 },
    ]);
    expect(info.strings[4]).toBe("https://api.example.com/v1");
    expect(info.findings.map((f) => f.kind)).toEqual(["dex.urls"]);
  });
  it("rejects other input", () => {
    expect(() => parseDex(new Uint8Array(200))).toThrow(/not a DEX/);
  });
});
