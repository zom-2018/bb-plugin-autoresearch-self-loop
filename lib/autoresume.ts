/**
 * When an idle owner thread should be resumed for the next iteration, and when
 * it should stop. Ported from pi-autoresearch (MIT, see README.md).
 */
import { AUTORESUME_TURN_LIMIT, CONSECUTIVE_FAILURE_LIMIT } from "./constants";
import type { ReconstructedRun } from "./jsonl";

/** Trailing discards and crashes in the current segment. */
export function consecutiveDiscardOrCrash(runs: Array<Pick<ReconstructedRun, "status">>): number {
  let count = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    const status = runs[i].status;
    if (status !== "discard" && status !== "crash") break;
    count++;
  }
  return count;
}

/** Why auto-resume should stop, or null to keep going. */
export function autoResumeStopReason(turns: number, runs: Array<Pick<ReconstructedRun, "status">>): string | null {
  if (turns >= AUTORESUME_TURN_LIMIT) return `Autoresearch auto-resume limit reached (${AUTORESUME_TURN_LIMIT} turns)`;
  const failures = consecutiveDiscardOrCrash(runs);
  if (failures > CONSECUTIVE_FAILURE_LIMIT) {
    return `Autoresearch auto-resume stopped — ${failures} consecutive discards/crashes`;
  }
  return null;
}
