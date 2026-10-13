import { ByteReader, utf8String } from "../binary/reader.js";
import { AnalysisError } from "../model.js";

export type PlistValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | { $date: string }
  | { $data: string }
  | { $uid: number }
  | PlistValue[]
  | { [key: string]: PlistValue };

/** Decodes XML (`<plist>`) or binary (`bplist00`) property lists. */
export function parsePlist(bytes: Uint8Array): PlistValue {
  const head = utf8String(bytes.subarray(0, 8));
  if (head.startsWith("bplist")) return parseBinaryPlist(bytes);
  return parseXmlPlist(utf8String(bytes));
}

// ---------- binary ----------

function parseBinaryPlist(bytes: Uint8Array): PlistValue {
  if (bytes.length < 40)
    throw new AnalysisError("malformed", "binary plist shorter than its trailer");
  const trailer = new ByteReader(bytes, bytes.length - 32, false);
  trailer.skip(6);
  const offsetSize = trailer.u8();
  const refSize = trailer.u8();
  const objectCount = trailer.u64n();
  const topObject = trailer.u64n();
  const tableOffset = trailer.u64n();
  if (objectCount > 1_000_000 || tableOffset + objectCount * offsetSize > bytes.length) {
    throw new AnalysisError("malformed", "binary plist offset table out of range");
  }
  const readSized = (at: number, size: number): number => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + bytes[at + i]!;
    return v;
  };
  const offsets: number[] = [];
  for (let i = 0; i < objectCount; i++)
    offsets.push(readSized(tableOffset + i * offsetSize, offsetSize));

  const r = new ByteReader(bytes, 0, false);
  const readInt = (size: number): bigint => {
    let v = 0n;
    for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(r.u8());
    return v;
  };
  const count = (lower: number): number => {
    if (lower !== 0xf) return lower;
    const marker = r.u8();
    return Number(readInt(1 << (marker & 0xf)));
  };
  const seen = new Set<number>();
  // Realized containers, strings and data are memoized by object index: a DAG that references one
  // object many times is decoded once, so a crafted fan-out chain cannot expand exponentially.
  // The cap counts container realizations only; scalars are cheap.
  const memo = new Map<number, PlistValue>();
  let realized = 0;
  const MAX_REALIZED = 2_000_000;
  const object = (index: number, depth = 0): PlistValue => {
    if (depth > 64) throw new AnalysisError("malformed", "binary plist nests too deeply");
    const offset = offsets[index];
    if (offset === undefined || offset >= bytes.length)
      throw new AnalysisError("malformed", `object ${index} out of range`);
    if (seen.has(index)) return null; // cycle guard
    const known = memo.get(index);
    if (known !== undefined) return known;
    r.seek(offset);
    const marker = r.u8();
    const type = marker >> 4;
    const lower = marker & 0xf;
    switch (type) {
      case 0x0:
        return lower === 8 ? false : lower === 9 ? true : null;
      case 0x1: {
        const size = 1 << lower;
        const v = readInt(size);
        const signed = size === 8 ? BigInt.asIntN(64, v) : v;
        return signed <= BigInt(Number.MAX_SAFE_INTEGER) &&
          signed >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(signed)
          : signed;
      }
      case 0x2:
        return lower === 2
          ? r.view.getFloat32(r.offset, false)
          : r.view.getFloat64(r.offset, false);
      case 0x3: {
        const seconds = r.view.getFloat64(r.offset, false);
        return { $date: new Date((seconds + 978307200) * 1000).toISOString() };
      }
      case 0x4: {
        const data = { $data: Buffer.from(r.bytesAt(count(lower))).toString("base64") };
        memo.set(index, data);
        return data;
      }
      case 0x5: {
        const text = utf8String(r.bytesAt(count(lower)));
        memo.set(index, text);
        return text;
      }
      case 0x6: {
        const n = count(lower);
        let s = "";
        for (let i = 0; i < n; i++) s += String.fromCharCode(r.u16());
        memo.set(index, s);
        return s;
      }
      case 0x8:
        return { $uid: Number(readInt(lower + 1)) };
      case 0xa:
      case 0xc: {
        if (++realized > MAX_REALIZED)
          throw new AnalysisError("too_large", "binary plist holds more than 2000000 containers");
        const n = count(lower);
        const refs = Array.from({ length: n }, () => Number(readInt(refSize)));
        seen.add(index);
        const out = refs.map((ref) => object(ref, depth + 1));
        seen.delete(index);
        memo.set(index, out);
        return out;
      }
      case 0xd: {
        if (++realized > MAX_REALIZED)
          throw new AnalysisError("too_large", "binary plist holds more than 2000000 containers");
        const n = count(lower);
        const keys = Array.from({ length: n }, () => Number(readInt(refSize)));
        const values = Array.from({ length: n }, () => Number(readInt(refSize)));
        seen.add(index);
        const out: { [key: string]: PlistValue } = {};
        for (let i = 0; i < n; i++)
          out[String(object(keys[i]!, depth + 1))] = object(values[i]!, depth + 1);
        seen.delete(index);
        memo.set(index, out);
        return out;
      }
      default:
        throw new AnalysisError(
          "malformed",
          `unknown binary plist marker 0x${marker.toString(16)}`,
        );
    }
  };
  return object(topObject);
}

// ---------- xml ----------

interface XmlNode {
  tag: string;
  text: string;
  children: XmlNode[];
}

const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
};
const unescape = (s: string): string =>
  s.replace(/&(lt|gt|amp|quot|apos);|&#x([0-9a-fA-F]+);|&#(\d+);/g, (m, named, hexCode, dec) =>
    named ? ENTITIES[m]! : String.fromCodePoint(parseInt(hexCode ?? dec, hexCode ? 16 : 10)),
  );

/** Minimal XML reader for the plist subset: elements, text, CDATA, comments, self-closing tags. */
function parseXml(text: string): XmlNode {
  const root: XmlNode = { tag: "#root", text: "", children: [] };
  const stack: XmlNode[] = [root];
  const re =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)([^>]*?)(\/?)>|([^<]+)/g;
  for (const m of text.matchAll(re)) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (top.tag !== m[2]) throw new AnalysisError("malformed", `unexpected </${m[2]}>`);
      stack.pop();
    } else if (m[3]) {
      const node: XmlNode = { tag: m[3], text: "", children: [] };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += unescape(m[6]);
  }
  if (stack.length !== 1)
    throw new AnalysisError("malformed", `unclosed <${stack[stack.length - 1]!.tag}>`);
  return root;
}

function parseXmlPlist(text: string): PlistValue {
  const doc = parseXml(text);
  const plist = doc.children.find((c) => c.tag === "plist") ?? doc;
  const first = plist.children[0];
  if (!first) throw new AnalysisError("malformed", "plist has no root object");
  const convert = (node: XmlNode): PlistValue => {
    switch (node.tag) {
      case "dict": {
        const out: { [key: string]: PlistValue } = {};
        for (let i = 0; i + 1 < node.children.length; i += 2) {
          const key = node.children[i]!;
          if (key.tag !== "key")
            throw new AnalysisError("malformed", `expected <key>, found <${key.tag}>`);
          out[key.text] = convert(node.children[i + 1]!);
        }
        return out;
      }
      case "array":
        return node.children.map(convert);
      case "string":
        return node.text;
      case "integer": {
        const v = BigInt(node.text.trim());
        return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(v)
          : v;
      }
      case "real":
        return Number(node.text.trim());
      case "true":
        return true;
      case "false":
        return false;
      case "date":
        return { $date: node.text.trim() };
      case "data":
        return { $data: node.text.replace(/\s+/g, "") };
      default:
        throw new AnalysisError("malformed", `unknown plist element <${node.tag}>`);
    }
  };
  return convert(first);
}
