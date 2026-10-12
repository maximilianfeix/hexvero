import type { Session } from "@hexvero/core";
import { paint, type Io } from "./format.js";

export async function startUi(
  _session: Session,
  options: { port: number; open: boolean },
  io: Io,
): Promise<number> {
  io.err(
    `${paint(io, "yellow", "!")} the web UI ships in the next milestone (planned port ${options.port})`,
  );
  return 1;
}
