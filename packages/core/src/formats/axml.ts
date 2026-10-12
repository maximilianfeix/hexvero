import { ByteReader, utf8String } from "../binary/reader.js";
import { AnalysisError } from "../model.js";

export interface AxmlElement {
  tag: string;
  attributes: Record<string, string>;
  children: AxmlElement[];
}

const CHUNK_STRING_POOL = 0x0001;
const CHUNK_XML = 0x0003;
const CHUNK_START_NAMESPACE = 0x0100;
const CHUNK_START_ELEMENT = 0x0102;
const CHUNK_END_ELEMENT = 0x0103;
const CHUNK_RESOURCE_MAP = 0x0180;

/** Known attribute resource ids so names survive even when the string pool omits them. */
const RESOURCE_NAMES: Record<number, string> = {
  0x01010000: "theme",
  0x01010001: "label",
  0x01010002: "icon",
  0x01010003: "name",
  0x01010006: "permission",
  0x01010010: "exported",
  0x0101000f: "debuggable",
  0x0101021b: "versionCode",
  0x0101021c: "versionName",
  0x0101020c: "minSdkVersion",
  0x01010270: "targetSdkVersion",
  0x01010280: "allowBackup",
  0x0101001e: "enabled",
  0x01010018: "authorities",
  0x01010048: "host",
  0x01010027: "scheme",
  0x0101002a: "pathPrefix",
  0x01010573: "usesCleartextTraffic",
  0x0101026c: "maxSdkVersion",
  0x01010572: "networkSecurityConfig",
  0x0101057d: "extractNativeLibs",
  0x01010024: "grantUriPermissions",
  0x01010023: "readPermission",
  0x01010025: "writePermission",
  0x01010227: "value",
  0x01010275: "resource",
  0x0101000d: "protectionLevel",
};

function decodeTypedValue(type: number, data: number, strings: string[]): string {
  switch (type) {
    case 0x03:
      return strings[data] ?? "";
    case 0x01:
      return `@0x${data.toString(16).padStart(8, "0")}`;
    case 0x02:
      return `?0x${data.toString(16).padStart(8, "0")}`;
    case 0x10:
      return String(data | 0);
    case 0x11:
      return `0x${(data >>> 0).toString(16)}`;
    case 0x12:
      return data !== 0 ? "true" : "false";
    case 0x04:
      return String(new DataView(new Uint32Array([data]).buffer).getFloat32(0, true));
    case 0x05:
      return `${data >> 8}${["px", "dip", "sp", "pt", "in", "mm"][data & 0xf] ?? ""}`;
    case 0x1c:
    case 0x1d:
    case 0x1e:
    case 0x1f:
      return `#${(data >>> 0).toString(16).padStart(8, "0")}`;
    default:
      return `0x${(data >>> 0).toString(16)}`;
  }
}

function readStringPool(r: ByteReader, chunkStart: number, chunkSize: number): string[] {
  const count = r.u32();
  r.u32(); // style count
  const flags = r.u32();
  const stringsStart = r.u32();
  r.u32(); // styles start
  const utf8 = (flags & 0x100) !== 0;
  const offsets = Array.from({ length: Math.min(count, 1_000_000) }, () => r.u32());
  const base = chunkStart + stringsStart;
  const end = chunkStart + chunkSize;
  const strings: string[] = [];
  for (const off of offsets) {
    const at = base + off;
    if (at >= end) {
      strings.push("");
      continue;
    }
    r.seek(at);
    if (utf8) {
      let charLen = r.u8();
      if (charLen & 0x80) charLen = ((charLen & 0x7f) << 8) | r.u8();
      let byteLen = r.u8();
      if (byteLen & 0x80) byteLen = ((byteLen & 0x7f) << 8) | r.u8();
      strings.push(utf8String(r.bytesAt(Math.min(byteLen, end - r.offset))));
    } else {
      let len = r.u16();
      if (len & 0x8000) len = ((len & 0x7fff) << 16) | r.u16();
      let s = "";
      for (let i = 0; i < len && r.remaining >= 2; i++) s += String.fromCharCode(r.u16());
      strings.push(s);
    }
  }
  return strings;
}

/** Decodes Android binary XML (AndroidManifest.xml inside an APK) into a plain element tree. */
export function parseAxml(bytes: Uint8Array): AxmlElement {
  const r = new ByteReader(bytes, 0, true);
  if (bytes.length < 8 || r.u16() !== CHUNK_XML)
    throw new AnalysisError("malformed", "not an Android binary XML document");
  r.u16();
  const fileSize = Math.min(r.u32(), bytes.length);
  let strings: string[] = [];
  let resourceIds: number[] = [];
  const namespaces = new Map<string, string>();
  const root: AxmlElement = { tag: "#document", attributes: {}, children: [] };
  const stack: AxmlElement[] = [root];

  while (r.offset + 8 <= fileSize) {
    const chunkStart = r.offset;
    const type = r.u16();
    const headerSize = r.u16();
    const chunkSize = r.u32();
    if (chunkSize < 8 || chunkStart + chunkSize > fileSize)
      throw new AnalysisError(
        "malformed",
        `chunk 0x${type.toString(16)} at ${chunkStart} has invalid size`,
      );
    switch (type) {
      case CHUNK_STRING_POOL:
        strings = readStringPool(r, chunkStart, chunkSize);
        break;
      case CHUNK_RESOURCE_MAP:
        resourceIds = Array.from({ length: (chunkSize - headerSize) / 4 }, () => r.u32());
        break;
      case CHUNK_START_NAMESPACE: {
        r.skip(8);
        const prefix = strings[r.u32()] ?? "";
        const uri = strings[r.u32()] ?? "";
        namespaces.set(uri, prefix);
        break;
      }
      case CHUNK_START_ELEMENT: {
        r.seek(chunkStart + headerSize);
        r.u32(); // ns
        const tag = strings[r.u32()] ?? "";
        const attributeStart = r.u16();
        const attributeSize = r.u16();
        const attributeCount = r.u16();
        const element: AxmlElement = { tag, attributes: {}, children: [] };
        const attrBase = chunkStart + headerSize + attributeStart;
        for (let i = 0; i < attributeCount; i++) {
          r.seek(attrBase + i * attributeSize);
          const nsIndex = r.u32();
          const nameIndex = r.u32();
          const rawValue = r.u32();
          r.u16();
          r.u8();
          const dataType = r.u8();
          const data = r.u32();
          let name = strings[nameIndex] ?? "";
          const resId = resourceIds[nameIndex];
          if (!name && resId !== undefined)
            name = RESOURCE_NAMES[resId] ?? `@0x${resId.toString(16)}`;
          const ns = nsIndex !== 0xffffffff ? namespaces.get(strings[nsIndex] ?? "") : undefined;
          const key = ns ? `${ns}:${name}` : name;
          element.attributes[key] =
            rawValue !== 0xffffffff
              ? (strings[rawValue] ?? "")
              : decodeTypedValue(dataType, data, strings);
        }
        stack[stack.length - 1]!.children.push(element);
        stack.push(element);
        break;
      }
      case CHUNK_END_ELEMENT:
        if (stack.length > 1) stack.pop();
        break;
      default:
        break;
    }
    r.seek(chunkStart + chunkSize);
  }
  return root.children[0] ?? root;
}
