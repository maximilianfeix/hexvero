import { Builder } from "./builder.js";

/** com/example/Hello extends java/lang/Object with a field, two methods (one native) and a string constant. */
export function buildClass(): Uint8Array {
  const b = new Builder(false);
  b.u32(0xcafebabe).u16(0).u16(61); // Java 17
  const pool: Array<(b: Builder) => void> = [];
  const utf8 = (s: string): number => {
    pool.push((x) => x.u8(1).u16(s.length).ascii(s));
    return pool.length;
  };
  const cls = (nameIndex: number): number => {
    pool.push((x) => x.u8(7).u16(nameIndex));
    return pool.length;
  };
  const thisName = utf8("com/example/Hello");
  const thisClass = cls(thisName);
  const superName = utf8("java/lang/Object");
  const superClass = cls(superName);
  const runnableName = utf8("java/lang/Runnable");
  const runnable = cls(runnableName);
  const greeting = utf8("hello world");
  pool.push((x) => x.u8(8).u16(greeting));
  const fieldName = utf8("count");
  const fieldDesc = utf8("I");
  const mainName = utf8("main");
  const mainDesc = utf8("([Ljava/lang/String;)V");
  const nativeName = utf8("crunch");
  const nativeDesc = utf8("()V");
  const runtimeName = utf8("java/lang/Runtime");
  const runtime = cls(runtimeName);
  const execName = utf8("exec");
  const execDesc = utf8("(Ljava/lang/String;)Ljava/lang/Process;");
  pool.push((x) => x.u8(12).u16(execName).u16(execDesc));
  const nat = pool.length;
  pool.push((x) => x.u8(10).u16(runtime).u16(nat));
  const sourceFile = utf8("SourceFile");
  const helloJava = utf8("Hello.java");
  b.u16(pool.length + 1);
  for (const write of pool) write(b);
  b.u16(0x21).u16(thisClass).u16(superClass).u16(1).u16(runnable);
  b.u16(1).u16(0x2).u16(fieldName).u16(fieldDesc).u16(0); // one private field
  b.u16(2);
  b.u16(0x9).u16(mainName).u16(mainDesc).u16(0); // public static main
  b.u16(0x102).u16(nativeName).u16(nativeDesc).u16(0); // native crunch
  b.u16(1).u16(sourceFile).u32(2).u16(helloJava);
  return b.done();
}
