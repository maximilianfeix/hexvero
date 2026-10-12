#!/usr/bin/env node
import { main } from "../dist/index.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(70);
  },
);
