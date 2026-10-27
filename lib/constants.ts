/** Limits and fixed wording shared by the tools, the loop, and the instructions. Values match pi-autoresearch. */

/** Experiment output the agent sees: last 10 lines, at most 4 KB. */
export const EXPERIMENT_MAX_LINES = 10;
export const EXPERIMENT_MAX_BYTES = 4 * 1024;

/** Checks output appended to a failed run. */
export const CHECKS_TAIL_LINES = 80;

/** Checks output quoted back when a keep is refused. */
export const CHECKS_QUOTE_CHARS = 500;

export const DEFAULT_RUN_TIMEOUT_SECONDS = 600;
export const DEFAULT_CHECKS_TIMEOUT_SECONDS = 300;

/** Auto-resume stops after this many turns, or after this many discards/crashes in a row. */
export const AUTORESUME_TURN_LIMIT = 200;
export const CONSECUTIVE_FAILURE_LIMIT = 20;

/** Idle time before an auto-resume fires; a thread that goes active again cancels it. */
export const SETTLE_MS = 800;

export const BENCHMARK_GUARDRAIL = "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.";

export const AUTORESUME_MESSAGE =
  "Run the next iteration now. Use the persisted autoresearch state as needed, pick the most promising hypothesis, then call run_experiment + log_experiment.";

/** Max characters the contributed instructions may use (BB truncates beyond 4096). */
export const INSTRUCTIONS_BUDGET = 3_800;
