#!/usr/bin/env node
// node:sqlite still prints an ExperimentalWarning on some Node lines; keep stderr clean for agents.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name !== "ExperimentalWarning") console.error(warning.stack ?? warning.message);
});
const { main } = await import("../dist/index.js");

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(70);
  },
);
