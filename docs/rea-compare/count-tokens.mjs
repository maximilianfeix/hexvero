// usage: node count-tokens.mjs <file...>  -- o200k_base token count (gpt-tokenizer) of each file's exact text
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
const require = createRequire(new URL("../install/package.json", import.meta.url));
const { encode } = await import(
  pathToFileURL(require.resolve("gpt-tokenizer/encoding/o200k_base")).href
);
for (const f of process.argv.slice(2)) {
  const text = fs.readFileSync(f, "utf8");
  const j = JSON.parse(text);
  const noOut = JSON.stringify({ ...j, tools: j.tools.map(({ outputSchema, ...t }) => t) });
  console.log(
    JSON.stringify({
      file: f,
      bytes: Buffer.byteLength(text),
      tokens_o200k_base: encode(text).length,
      bytesWithoutOutputSchema: Buffer.byteLength(noOut),
      tokensWithoutOutputSchema_o200k_base: encode(noOut).length,
    }),
  );
}
