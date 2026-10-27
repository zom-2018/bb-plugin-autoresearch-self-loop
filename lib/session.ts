/**
 * A read-only view of one checkout's session, rebuilt from `.auto/log.jsonl` on
 * every call. The log is the source of truth; nothing here is cached.
 */
import {
  hasAutoresearchConfigHeader,
  reconstructJsonlState,
  type ReconstructedMetricDef,
  type ReconstructedRun,
} from "./jsonl";
import { type Direction, computeConfidence, findBaselineMetric, findBestMetric, segmentRuns } from "./metrics";
import { sessionPaths } from "./paths";
import type { Checkout } from "./workspace";

export const RUN_STATUSES = ["keep", "discard", "crash", "checks_failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface SessionView {
  logPath: string;
  hasConfig: boolean;
  name: string | null;
  metricName: string;
  metricUnit: string;
  direction: Direction;
  segment: number;
  /** Every run across all segments, in log order. */
  allRuns: ReconstructedRun[];
  /** Runs in the current segment, in log order. */
  runs: ReconstructedRun[];
  secondaryMetrics: ReconstructedMetricDef[];
  baseline: { value: number; run: number } | null;
  best: { value: number; run: number | null } | null;
  confidence: number | null;
  counts: Record<RunStatus, number>;
}

export async function readSession(co: Checkout): Promise<SessionView> {
  const logPath = (await sessionPaths(co)).file.log;
  const content = (await co.ws.readText(logPath)) ?? "";
  const state = reconstructJsonlState(content);
  const segment = state.currentSegment;
  const runs = segmentRuns(state.results, segment);

  const counts: Record<RunStatus, number> = { keep: 0, discard: 0, crash: 0, checks_failed: 0 };
  for (const run of runs) counts[run.status]++;

  const baselineValue = findBaselineMetric(state.results, segment);
  return {
    logPath,
    hasConfig: hasAutoresearchConfigHeader(content),
    name: state.name,
    metricName: state.metricName,
    metricUnit: state.metricUnit,
    direction: state.bestDirection,
    segment,
    allRuns: state.results,
    runs,
    secondaryMetrics: state.secondaryMetrics,
    baseline: baselineValue === null || runs.length === 0 ? null : { value: baselineValue, run: runs[0].run },
    best: findBestMetric(state.results, segment, state.bestDirection),
    confidence: computeConfidence(state.results, segment, state.bestDirection),
    counts,
  };
}

/** Compact session facts sent to hook scripts. */
export interface SessionSnapshot {
  metric_name: string;
  metric_unit: string;
  direction: Direction;
  baseline_metric: number | null;
  best_metric: number | null;
  run_count: number;
  goal: string;
}

export function sessionSnapshot(view: SessionView, goal: string | null): SessionSnapshot {
  return {
    metric_name: view.metricName,
    metric_unit: view.metricUnit,
    direction: view.direction,
    baseline_metric: view.baseline?.value ?? null,
    best_metric: view.best?.value ?? null,
    run_count: view.runs.length,
    goal: goal ?? view.name ?? "",
  };
}
