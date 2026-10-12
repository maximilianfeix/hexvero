import { Builder } from "./builder.js";

export function buildAsar(files: Record<string, string>): Uint8Array {
  const tree: { files: Record<string, unknown> } = { files: {} };
  const blobs: Uint8Array[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const data = new TextEncoder().encode(content);
    let node = tree;
    const parts = path.split("/");
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} };
      node = node.files[part] as typeof tree;
    }
    node.files[parts[parts.length - 1]!] = {
      size: data.length,
      offset: String(offset),
    };
    blobs.push(data);
    offset += data.length;
  }
  const json = new TextEncoder().encode(JSON.stringify(tree));
  const padded = Math.ceil(json.length / 4) * 4;
  const b = new Builder();
  b.u32(4)
    .u32(padded + 8)
    .u32(padded + 4)
    .u32(json.length)
    .bytes(json)
    .pad(16 + padded);
  for (const blob of blobs) b.bytes(blob);
  return b.done();
}
