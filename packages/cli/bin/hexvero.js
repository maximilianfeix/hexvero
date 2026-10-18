#!/usr/bin/env node
// node:sqlite still prints an ExperimentalWarning on some Node lines; keep stderr clean for agents.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name !== "ExperimentalWarning") console.error(warning.stack ?? warning.message);
});
// A reader that went away (`| head -c 20`) ends the output, not the process with a stack trace.
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const { main } = await import("../dist/index.js");

// Exit only after stdout has been written out: with a pipe, exiting at once cuts large JSON
// output at a buffer boundary.
const finish = (code) => {
  process.exitCode = code;
  if (process.stdout.writableLength === 0) process.exit(code);
  else process.stdout.once("drain", () => process.exit(code));
};
main(process.argv.slice(2)).then(
  (code) => finish(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(70);
  },
);
