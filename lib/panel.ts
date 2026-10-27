/**
 * What the Autoresearch panel shows for one thread: the loop, the session's
 * numbers, and the most recent runs. Built from the log on every call, so the
 * panel and the agent read the same state.
 */
import { readMaxIterations } from "./paths";
import type { LoopRecord, LoopRuntime, PendingChecks, RunningExperiment } from "./runtime";
import { type RunStatus, RUN_STATUSES, readSession } from "./session";
import type { Checkout } from "./workspace";

/** Runs the panel lists, newest last. The log keeps all of them. */
export const PANEL_RUNS = 50;

export interface PanelRun {
  run: number;
  status: RunStatus;
  metric: number;
  /** Percent change against the baseline, or null when there is no usable baseline. */
  deltaPct: number | null;
  description: string;
  commit: string;
  metrics: Record<string, number>;
  confidence: number | null;
  timestamp: number;
}

export interface PanelLoop {
  active: boolean;
  /** True when this thread owns the loop, so its Stop and Finalize act on the thread the agent is in. */
  ownedByThread: boolean;
  goal: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  /** Why the loop is paused or stopped. */
  stopReason: string | null;
  autoResumeTurns: number;
  running: RunningExperiment | null;
  /** The last run's checks, while that run is still waiting to be logged. */
  pendingChecks: PendingChecks | null;
}

export interface PanelState {
  threadId: string;
  /** Set when there is no checkout to read (no environment, missing path, host unreachable). */
  unavailable: string | null;
  /** Set when config.json cannot be read. The rest of the panel still works; the commands that read the config are refused. */
  configError: string | null;
  hasConfig: boolean;
  name: string | null;
  metricName: string;
  metricUnit: string;
  direction: "lower" | "higher";
  segment: number;
  /** Runs logged in the current segment. */
  runCount: number;
  maxIterations: number | null;
  counts: Record<RunStatus, number>;
  baseline: { value: number; run: number } | null;
  best: { value: number; run: number | null } | null;
  confidence: number | null;
  runs: PanelRun[];
  loop: PanelLoop | null;
}

/** The loop as the panel shows it, for one thread's view of its record. */
export function panelLoopOf(record: LoopRecord, threadId: string, running: RunningExperiment | null): PanelLoop {
  return {
    active: record.active,
    ownedByThread: record.ownerThreadId === threadId,
    goal: record.goal,
    startedAt: record.startedAt,
    stoppedAt: record.stoppedAt,
    stopReason: record.stopReason,
    autoResumeTurns: record.autoResumeTurns,
    running,
    pendingChecks: record.lastRun?.checks ?? null,
  };
}

/** The panel state when the checkout cannot be read. `loop` is the thread's own loop, if it has one, so its Stop still shows. */
export function unavailableState(threadId: string, reason: string, loop: PanelLoop | null = null): PanelState {
  return {
    threadId,
    unavailable: reason,
    configError: null,
    hasConfig: false,
    name: null,
    metricName: "metric",
    metricUnit: "",
    direction: "lower",
    segment: 0,
    runCount: 0,
    maxIterations: null,
    counts: Object.fromEntries(RUN_STATUSES.map((s) => [s, 0])) as Record<RunStatus, number>,
    baseline: null,
    best: null,
    confidence: null,
    runs: [],
    loop,
  };
}

export async function buildPanelState(rt: LoopRuntime, threadId: string, co: Checkout): Promise<PanelState> {
  const view = await readSession(co);
  const record = rt.get(co);
  const baseline = view.baseline;
  const counts = Object.fromEntries(RUN_STATUSES.map((s) => [s, 0])) as Record<RunStatus, number>;
  for (const run of view.runs) counts[run.status] += 1;

  const runs: PanelRun[] = view.runs.slice(-PANEL_RUNS).map((run) => ({
    run: run.run,
    status: run.status,
    metric: run.metric,
    deltaPct: baseline && baseline.value !== 0 ? ((run.metric - baseline.value) / baseline.value) * 100 : null,
    description: run.description,
    commit: run.commit,
    metrics: run.metrics,
    confidence: run.confidence,
    timestamp: run.timestamp,
  }));

  // A broken config.json shows here as configError; the rest of the panel still reads from the log.
  let maxIterations: number | null = null;
  let configError: string | null = null;
  try {
    maxIterations = await readMaxIterations(co);
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
  }

  return {
    threadId,
    unavailable: null,
    configError,
    hasConfig: view.hasConfig,
    name: view.name,
    metricName: view.metricName,
    metricUnit: view.metricUnit,
    direction: view.direction,
    segment: view.segment,
    runCount: view.runs.length,
    maxIterations,
    counts,
    baseline,
    best: view.best,
    confidence: view.confidence,
    runs,
    loop: record ? panelLoopOf(record, threadId, rt.runningFor(co)) : null,
  };
}
