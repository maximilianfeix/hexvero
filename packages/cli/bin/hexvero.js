#!/usr/bin/env node
// Before anything is imported: on an older Node.js the imports below fail with an error about
// syntax or a missing module that says nothing about the cause.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(
    `hexvero needs Node.js 22.12 or newer; this is Node.js ${process.versions.node}.\n` +
      "Install the current LTS from https://nodejs.org (or: nvm install --lts), then run it again.",
  );
  process.exit(1);
}
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

// Exit only after stdout has been written out: with a pipe, exiting at once cuts large JSON
// output at a buffer boundary.
const finish = (code) => {
  process.exitCode = code;
  if (process.stdout.writableLength === 0) process.exit(code);
  else process.stdout.once("drain", () => process.exit(code));
};
const argv = process.argv.slice(2);
// `hexvero` and `hexvero --version` are answered without loading the analyzers.
const { fastMain } = await import("../dist/usage.js");
const fast = fastMain(argv);
(fast !== undefined
  ? Promise.resolve(fast)
  : import("../dist/index.js").then((m) => m.main(argv))
).then(
  (code) => finish(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(70);
  },
);
