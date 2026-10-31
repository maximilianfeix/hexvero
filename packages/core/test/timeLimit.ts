import { availableParallelism, loadavg } from "node:os";

/**
 * The wall-clock limits in these tests guard against blow-ups (a scan that turns quadratic on
 * hostile input), not against a slow machine. Hosted macOS runners and a busy laptop run the same
 * work two to three times slower, which failed releases and PRs without a regression. The limit is
 * scaled by HEXVERO_TEST_TIME_SCALE when set, otherwise by the load per core (at least 1) and by 2
 * on CI macOS runners, at most 4. A blow-up still exceeds the scaled limit by far.
 */
export function timeScale(): number {
  const set = Number(process.env.HEXVERO_TEST_TIME_SCALE);
  if (Number.isFinite(set) && set > 0) return set;
  const load = Math.max(1, loadavg()[0] / availableParallelism());
  const runner = process.env.CI && process.platform === "darwin" ? 2 : 1;
  return Math.min(4, load * runner);
}

/** `ms`, scaled for the machine the test runs on (see `timeScale`). */
export const timeLimit = (ms: number): number => Math.round(ms * timeScale());
