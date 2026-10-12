import { ByteReader } from "../binary/reader.js";
import type { PeInfo } from "./pe.js";

export interface PeVersionInfo {
  fileVersion: string | null;
  productVersion: string | null;
  strings: Record<string, string>;
}

const RT_VERSION = 16;

/** Walks the resource directory to RT_VERSION and decodes the VS_VERSIONINFO StringFileInfo block. */
export function readVersionInfo(bytes: Uint8Array, pe: PeInfo): PeVersionInfo | null {
  const dir = pe.dataDirectories["resource"];
  if (!dir) return null;
  const base = pe.rvaToOffset(parseInt(dir.rva, 16));
  if (base === null) return null;
  const r = new ByteReader(bytes, 0, true);
  const entriesOf = (offset: number): Array<{ id: number; offset: number; isDir: boolean }> => {
    const at = base + offset;
    if (at + 16 > bytes.length) return [];
    r.seek(at + 12);
    const named = r.u16();
    const ids = r.u16();
    const out: Array<{ id: number; offset: number; isDir: boolean }> = [];
    for (let i = 0; i < named + ids && i < 512; i++) {
      if (r.offset + 8 > bytes.length) break;
      const id = r.u32();
      const value = r.u32();
      out.push({
        id: id & 0x7fffffff,
        offset: value & 0x7fffffff,
        isDir: (value & 0x80000000) !== 0,
      });
    }
    return out;
  };
  const typeEntry = entriesOf(0).find((e) => e.id === RT_VERSION && e.isDir);
  if (!typeEntry) return null;
  const nameEntry = entriesOf(typeEntry.offset).find((e) => e.isDir);
  if (!nameEntry) return null;
  const langEntry = entriesOf(nameEntry.offset)[0];
  if (!langEntry || langEntry.isDir) return null;
  const dataEntry = base + langEntry.offset;
  if (dataEntry + 16 > bytes.length) return null;
  r.seek(dataEntry);
  const dataRva = r.u32();
  const size = r.u32();
  const dataOff = pe.rvaToOffset(dataRva);
  if (dataOff === null || dataOff + size > bytes.length || size < 92) return null;
  const block = bytes.subarray(dataOff, dataOff + size);
  return decodeVersionBlock(block);
}

const utf16 = (b: Uint8Array, at: number, maxChars = 256): { text: string; end: number } => {
  let text = "";
  let i = at;
  for (let n = 0; i + 1 < b.length && n < maxChars; i += 2, n++) {
    const c = b[i]! | (b[i + 1]! << 8);
    if (c === 0) break;
    text += String.fromCharCode(c);
  }
  return { text, end: i + 2 };
};
const align4 = (n: number): number => (n + 3) & ~3;

function decodeVersionBlock(block: Uint8Array): PeVersionInfo {
  const r = new ByteReader(block, 0, true);
  const strings: Record<string, string> = {};
  let fileVersion: string | null = null;
  let productVersion: string | null = null;
  const totalLength = r.u16();
  const valueLength = r.u16();
  r.u16();
  const key = utf16(block, 6);
  if (key.text !== "VS_VERSION_INFO") return { fileVersion, productVersion, strings };
  let at = align4(key.end);
  if (valueLength >= 52 && at + 52 <= block.length) {
    const v = new ByteReader(block, at, true);
    if (v.u32() === 0xfeef04bd) {
      v.u32();
      const fvMs = v.u32();
      const fvLs = v.u32();
      const pvMs = v.u32();
      const pvLs = v.u32();
      fileVersion = `${fvMs >>> 16}.${fvMs & 0xffff}.${fvLs >>> 16}.${fvLs & 0xffff}`;
      productVersion = `${pvMs >>> 16}.${pvMs & 0xffff}.${pvLs >>> 16}.${pvLs & 0xffff}`;
    }
    at = align4(at + valueLength);
  }
  // Children: StringFileInfo / VarFileInfo blocks
  let guard = 0;
  while (at + 6 <= Math.min(block.length, totalLength) && guard++ < 64) {
    const cr = new ByteReader(block, at, true);
    const len = cr.u16();
    if (len === 0) break;
    cr.u16();
    cr.u16();
    const name = utf16(block, at + 6);
    if (name.text === "StringFileInfo") {
      let tableAt = align4(name.end);
      const end = at + len;
      while (tableAt + 6 <= end) {
        const tr = new ByteReader(block, tableAt, true);
        const tlen = tr.u16();
        if (tlen === 0) break;
        const tkey = utf16(block, tableAt + 6);
        let strAt = align4(tkey.end);
        const tend = tableAt + tlen;
        let inner = 0;
        while (strAt + 6 <= tend && inner++ < 64) {
          const sr = new ByteReader(block, strAt, true);
          const slen = sr.u16();
          const svalLen = sr.u16();
          if (slen === 0) break;
          const skey = utf16(block, strAt + 6);
          const valueAt = align4(skey.end);
          if (svalLen > 0 && valueAt < tend)
            strings[skey.text] = utf16(block, valueAt, Math.min(svalLen, 512)).text;
          strAt = align4(strAt + slen);
        }
        tableAt = align4(tableAt + tlen);
      }
    }
    at = align4(at + len);
  }
  return { fileVersion, productVersion, strings };
}
