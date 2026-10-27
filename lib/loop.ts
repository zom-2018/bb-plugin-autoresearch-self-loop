/**
 * The experiment loop: init, run, log, and the start/stop transitions. Each
 * function returns the text the agent reads. Expected refusals throw `Refusal`.
 * Every function works on a checkout, local or on another host, through its
 * workspace. Ported from pi-autoresearch (MIT, see README.md): extensions/pi-autoresearch/index.ts.
 *
 * Init and log calls for one checkout run one at a time: a log call reads the run
 * count and then appends, so two at once would share a run number. `serialized`
 * keeps them in order inside this process. Across processes that order is not kept.
 */

import { autoResumeStopReason } from "./autoresume";
import {
  AUTORESUME_MESSAGE,
  BENCHMARK_GUARDRAIL,
  CHECKS_QUOTE_CHARS,
  CHECKS_TAIL_LINES,
  DEFAULT_CHECKS_TIMEOUT_SECONDS,
  DEFAULT_RUN_TIMEOUT_SECONDS,
  EXPERIMENT_MAX_BYTES,
  EXPERIMENT_MAX_LINES,
  SETTLE_MS,
} from "./constants";
import { commitKeep, dirtyPaths, hasHeadCommit, isGitRepo, resolveCommit, revertWork } from "./git";
import { appendHookLogEntryIfConfigured, hookNoteFor, runHook } from "./hooks";
import type { ReconstructedRun } from "./jsonl";
import {
  type Direction,
  computeConfidence,
  findBaselineMetric,
  findBaselineSecondary,
  formatNum,
  inferMetricUnit,
  isMeasureCommand,
  parseMetricLines,
} from "./metrics";
import { readMaxIterations, readablePath, resolveRunDir, sessionPaths } from "./paths";
import { Refusal } from "./refusal";
import { checkoutKey, type LoopRecord, type LoopRuntime } from "./runtime";
import { commandArgv, pathsFor, scriptArgv } from "./shell";
import { type SessionView, readSession, sessionSnapshot } from "./session";
import { loopSummary, stateLine } from "./summary";
import { type Checkout, type CheckoutRef, type ExecResult, appendJsonLine, checkoutLabel } from "./workspace";

export interface InitParams {
  name: string;
  metricName: string;
  metricUnit: string;
  direction: Direction;
}

export interface RunParams {
  command: string;
  timeoutSeconds?: number;
  checksTimeoutSeconds?: number;
}

export interface LogParams {
  commit: string;
  metric: number;
  status: ReconstructedRun["status"];
  description: string;
  metrics?: Record<string, number>;
  force?: boolean;
  asi?: Record<string, unknown>;
}

type SendToThread = (threadId: string, text: string) => Promise<void>;

/** What the timers and events need to reach a loop: its checkout, the checkout its thread works in now, a way to message its owner, and a logger. */
export interface ResumeDeps {
  open: (ref: CheckoutRef) => Checkout;
  /** The checkout the thread works in now, read without any existence check. */
  current: (threadId: string) => Promise<CheckoutRef>;
  /** The thread's status now, such as idle or active. */
  status: (threadId: string) => Promise<string>;
  send: SendToThread;
  log: (message: string) => void;
}

const NOT_INITIALIZED = "No experiment is initialized in this checkout.";
const NOT_INITIALIZED_HINT = "Call init_experiment first.";
const NOT_REPO_HINT =
  "Autoresearch keeps and reverts experiments with git. Run `git init`, then commit the benchmark and its setup.";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The last `maxLines` lines, cut again to `maxBytes`. */
function tailText(text: string, maxLines: number, maxBytes: number) {
  const trimmed = text.replace(/\n+$/, "");
  const lines = trimmed.split("\n");
  let kept = lines.slice(-maxLines);
  let content = kept.join("\n");
  let truncatedBy: "lines" | "bytes" | null = lines.length > maxLines ? "lines" : null;
  while (Buffer.byteLength(content) > maxBytes && kept.length > 1) {
    kept = kept.slice(1);
    content = kept.join("\n");
    truncatedBy = "bytes";
  }
  if (Buffer.byteLength(content) > maxBytes) {
    content = Buffer.from(content).subarray(-maxBytes).toString("utf-8");
    truncatedBy = "bytes";
  }
  return { content, truncatedBy, outputLines: kept.length, totalLines: lines.length };
}

function lastLines(text: string, count: number): string {
  return text.split("\n").slice(-count).join("\n");
}

/** Per-checkout queue: a recording task starts only after the checkout's earlier ones have settled. */
const queues = new Map<string, Promise<void>>();

/** Checkouts with a log call in progress. A benchmark must not start while the log's git steps run. */
const logging = new Set<string>();

function serialized<T>(ref: CheckoutRef, task: () => Promise<T>): Promise<T> {
  const key = checkoutKey(ref);
  const result = (queues.get(key) ?? Promise.resolve()).then(task);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return result;
}

async function requireRepo(co: Checkout): Promise<void> {
  if (!(await isGitRepo(co))) throw new Refusal(`${co.workDir} is not a git repository.`, NOT_REPO_HINT);
  if (!(await hasHeadCommit(co))) {
    throw new Refusal("The repository has no commits yet.", "Commit the current state first so discards have a base.");
  }
}

async function requireCleanTree(co: Checkout): Promise<void> {
  const dirty = await dirtyPaths(co);
  if (dirty.length === 0) return;
  const shown = dirty.slice(0, 10).join(", ");
  const more = dirty.length > 10 ? ` (+${dirty.length - 10} more)` : "";
  throw new Refusal(
    `Uncommitted changes outside the session files: ${shown}${more}`,
    "Commit or stash them first. A discard reverts every uncommitted change outside the session files (.auto/ and autoresearch.* at the checkout root).",
  );
}

/** Refuses when a segment with `runCount` runs has used up its `maxIterations`. */
async function requireBelowMax(co: Checkout, runCount: number): Promise<void> {
  const maxIterations = await readMaxIterations(co);
  if (maxIterations !== null && runCount >= maxIterations) {
    throw new Refusal(
      `Maximum experiments reached for this segment (${maxIterations}). The experiment loop is done.`,
      "Call init_experiment to start a new segment.",
    );
  }
}

/**
 * Refuses while a benchmark runs in this process. Callers check and then act with no
 * await in between, so the check holds. A CLI call in another process cannot see it.
 */
function requireNotRunning(rt: LoopRuntime, co: Checkout): void {
  if (rt.runningFor(co)) {
    throw new Refusal("A benchmark is running in this checkout.", "Wait for it to finish, then try again.");
  }
}

/**
 * The hook call for one stage; its note comes back in the tool result. A hook that
 * cannot run is reported as a note, never as an error: the run it follows is done.
 */
async function runStageHook(
  stage: "before" | "after",
  co: Checkout,
  goal: string | null,
  extra: { nextRun: number; lastRun: ReconstructedRun | null } | { runEntry: ReconstructedRun },
): Promise<string | null> {
  try {
    const session = sessionSnapshot(await readSession(co), goal);
    const payload =
      "runEntry" in extra
        ? { event: "after" as const, cwd: co.runDir, run_entry: { ...extra.runEntry }, session }
        : {
            event: "before" as const,
            cwd: co.runDir,
            next_run: extra.nextRun,
            last_run: extra.lastRun ? { ...extra.lastRun } : null,
            session,
          };
    const result = await runHook(co, payload);
    await appendHookLogEntryIfConfigured(co, stage, result);
    return hookNoteFor(stage, result);
  } catch (err) {
    return `[${stage} hook could not run: ${errorText(err)}]`;
  }
}

/** The session files as the layout in use names them, for the owner's instructions. */
async function sessionFiles(co: Checkout): Promise<{ prompt: string; ideas: string; log: string }> {
  const { file } = await sessionPaths(co);
  return {
    prompt: readablePath(co.workDir, file.prompt),
    ideas: readablePath(co.workDir, file.ideas),
    log: readablePath(co.workDir, file.log),
  };
}

/**
 * Rebuild the owner-thread note from the log. ownerInstructions reads the note
 * synchronously, so every change to the loop refreshes it.
 */
export async function refreshNote(rt: LoopRuntime, co: Checkout): Promise<void> {
  const record = rt.get(co);
  if (!record?.active) {
    rt.setNote(co, null);
    return;
  }
  try {
    const view = await readSession(co);
    const note = view.hasConfig
      ? loopSummary({
          view,
          goal: record.goal,
          // A broken config.json is reported by the commands that read it; the summary still shows.
          maxIterations: await readMaxIterations(co).catch(() => null),
          paused: record.stopReason,
          files: await sessionFiles(co),
        })
      : [
          "## Autoresearch loop (ACTIVE)",
          record.goal ? `Goal: ${record.goal}` : null,
          "No experiment is initialized yet. Follow the autoresearch-create skill, then call init_experiment.",
        ]
          .filter(Boolean)
          .join("\n");
    rt.setNote(co, note);
  } catch (err) {
    rt.setNote(co, `## Autoresearch loop (ACTIVE)\nThe session could not be read: ${errorText(err)}`);
  }
}

export function initExperiment(
  rt: LoopRuntime,
  co: Checkout,
  params: InitParams,
  ownerThreadId: string | null,
): Promise<string> {
  return serialized(co, () => initSegment(rt, co, params, ownerThreadId));
}

/** Start a segment: write its config header and make the loop active. */
async function initSegment(
  rt: LoopRuntime,
  co: Checkout,
  params: InitParams,
  ownerThreadId: string | null,
): Promise<string> {
  requireNotRunning(rt, co);
  await requireRepo(co);
  await requireCleanTree(co);

  const view = await readSession(co);
  // Read before anything is written, so a broken config refuses without touching the log.
  const maxIterations = await readMaxIterations(co);
  const at = await resolveRunDir(co);
  const isReinit = view.allRuns.length > 0;
  const logFile = (await sessionPaths(co)).file.log;
  const config = {
    type: "config",
    name: params.name,
    metricName: params.metricName,
    metricUnit: params.metricUnit,
    bestDirection: params.direction,
  };
  await appendJsonLine(co, logFile, config);

  const existing = rt.get(co);
  const wasActive = existing?.active === true;
  rt.resetExperiments(co);
  rt.update(co, {
    active: true,
    ownerThreadId,
    goal: existing?.goal ?? params.name,
    startedAt: existing?.startedAt ?? new Date().toISOString(),
    stoppedAt: null,
    stopReason: null,
    autoResumeTurns: 0,
    lastRun: null,
  });

  const note = wasActive
    ? null
    : await runStageHook("before", at, rt.get(co)?.goal ?? null, {
        nextRun: view.allRuns.length + 1,
        lastRun: view.allRuns.at(-1) ?? null,
      });

  const reinitNote = isReinit ? " (re-initialized — previous results archived, new baseline needed)" : "";
  const limitNote = maxIterations !== null ? `\nMax iterations: ${maxIterations} (from the session config)` : "";
  const unit = params.metricUnit || "unitless";
  const text =
    `✅ Experiment initialized: "${params.name}"${reinitNote}\n` +
    `Metric: ${params.metricName} (${unit}, ${params.direction} is better)${limitNote}\n` +
    `Config written to ${readablePath(co.workDir, logFile)}. Now run the baseline with run_experiment.`;
  await refreshNote(rt, co);
  return note ? `${text}\n\n${note}` : text;
}

export async function runExperiment(
  rt: LoopRuntime,
  co: Checkout,
  params: RunParams,
  signal?: AbortSignal,
): Promise<string> {
  if (!rt.get(co)?.active) {
    throw new Refusal(
      "Autoresearch is not running for this checkout.",
      "Start the loop from the Autoresearch panel or with `bb autoresearch start`.",
    );
  }
  const view = await readSession(co);
  if (!view.hasConfig) throw new Refusal(NOT_INITIALIZED, NOT_INITIALIZED_HINT);
  await requireBelowMax(co, view.runs.length);
  // Only the benchmark, its checks and the hooks run in the run directory, so only they need workingDir read.
  const at = await resolveRunDir(co);

  const paths = await sessionPaths(co);
  const measurePath = paths.file.measure;
  if ((await co.ws.exists(measurePath)) && !isMeasureCommand(params.command, co.shell)) {
    // Relative to the run directory, where the command runs. A PowerShell checkout shows `/` in the hint.
    const rel = pathsFor(at.runDir).relative(at.runDir, measurePath);
    const hint =
      co.shell === "powershell"
        ? `Use: run_experiment({ command: "./${rel.replace(/\\/g, "/")}" })`
        : `Use: run_experiment({ command: "bash ${rel}" }) or run_experiment({ command: "./${rel}" })`;
    throw new Refusal(
      `${rel} exists — you must run it instead of a custom command.\n\n` +
        `Found: ${measurePath}\nYour command: ${params.command}`,
      hint,
    );
  }

  // Checked and set with no await between them, so two runs cannot both start, and no log can start.
  requireNotRunning(rt, co);
  if (logging.has(checkoutKey(co))) {
    throw new Refusal("A log is being written in this checkout.", "Wait a moment, then run the benchmark again.");
  }
  const timeoutMs = (params.timeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS) * 1000;
  const logFile = paths.runLog;
  rt.setRunning(co, { startedAt: Date.now(), command: params.command });
  // A run with no result yet must not gate a keep on an earlier one, so the old result goes now.
  rt.update(co, { lastRun: null });
  const run: ExecResult = await co.ws
    .exec({ argv: commandArgv(co.shell, params.command), cwd: at.runDir, timeoutMs, signal, logPath: logFile })
    .finally(() => rt.setRunning(co, null));
  if (run.aborted) throw new Refusal("The experiment was cancelled before it finished.");

  const benchmarkPassed = run.exitCode === 0 && !run.timedOut && run.spawnError === null;

  const checksPath = paths.file.checks;
  let checks: { pass: boolean; timedOut: boolean; output: string; durationSeconds: number } | null = null;
  if (benchmarkPassed && (await co.ws.exists(checksPath))) {
    const checksRun = await co.ws.exec({
      argv: scriptArgv(co.shell, checksPath),
      cwd: at.runDir,
      timeoutMs: (params.checksTimeoutSeconds ?? DEFAULT_CHECKS_TIMEOUT_SECONDS) * 1000,
      signal,
    });
    if (checksRun.aborted) throw new Refusal("The experiment was cancelled before its checks finished.");
    checks = {
      pass: checksRun.exitCode === 0 && !checksRun.timedOut && checksRun.spawnError === null,
      timedOut: checksRun.timedOut,
      output: (checksRun.spawnError ?? checksRun.output).trim(),
      durationSeconds: checksRun.durationMs / 1000,
    };
  }
  // The keep gate in log_experiment reads this: how the benchmark and its checks ended.
  rt.update(co, {
    lastRun: {
      benchmarkPassed,
      checks: checks
        ? { pass: checks.pass, output: checks.output.slice(-CHECKS_QUOTE_CHARS), durationSeconds: checks.durationSeconds }
        : null,
    },
  });

  const seconds = (ms: number) => (ms / 1000).toFixed(1);
  const checksRel = readablePath(co.workDir, checksPath);
  const durationSeconds = run.durationMs / 1000;
  let text = "";
  if (run.timedOut) {
    text += `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s\n`;
  } else if (!benchmarkPassed) {
    text += `💥 FAILED (exit code ${run.exitCode}) in ${durationSeconds.toFixed(1)}s\n`;
  } else if (checks?.timedOut) {
    text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
    text += `⏰ CHECKS TIMEOUT (${checksRel}) after ${seconds(checks.durationSeconds * 1000)}s\n`;
    text += `Log this as 'checks_failed' — the benchmark metric is valid but checks timed out.\n`;
  } else if (checks && !checks.pass) {
    text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
    text += `💥 CHECKS FAILED (${checksRel}) in ${seconds(checks.durationSeconds * 1000)}s\n`;
    text += `Log this as 'checks_failed' — the benchmark metric is valid but correctness checks did not pass.\n`;
  } else {
    text += `✅ PASSED in ${durationSeconds.toFixed(1)}s\n`;
    if (checks) text += `✅ Checks passed in ${seconds(checks.durationSeconds * 1000)}s\n`;
  }

  const current = view.best ?? view.baseline;
  if (current) text += `📊 Current best ${view.metricName}: ${formatNum(current.value, view.metricUnit)}\n`;

  const metrics = parseMetricLines(run.output);
  if (metrics.size > 0) {
    const parsedPrimary = metrics.get(view.metricName) ?? null;
    const secondary = [...metrics].filter(([name]) => name !== view.metricName);
    text += `\n📐 Parsed metrics:`;
    if (parsedPrimary !== null) text += ` ★ ${view.metricName}=${formatNum(parsedPrimary, view.metricUnit)}`;
    for (const [name, value] of secondary) {
      const unit = view.secondaryMetrics.find((m) => m.name === name)?.unit ?? "";
      text += ` ${name}=${formatNum(value, unit)}`;
    }
    const secondaryJson = secondary.map(([k, v]) => `"${k}": ${v}`).join(", ");
    text += `\nUse these values directly in log_experiment (metric: ${parsedPrimary ?? "?"}, metrics: {${secondaryJson}})\n`;
  }

  const tail = tailText(run.output, EXPERIMENT_MAX_LINES, EXPERIMENT_MAX_BYTES);
  text += `\n${tail.content}`;
  if (tail.truncatedBy !== null) {
    const runRel = readablePath(co.workDir, logFile);
    text +=
      tail.truncatedBy === "lines"
        ? `\n\n[Showing last ${tail.outputLines} of ${tail.totalLines} lines.`
        : `\n\n[Showing last ${tail.outputLines} lines (4KB limit).`;
    text += ` Full output: ${runRel}]`;
  }

  if (checks && !checks.pass) {
    text += `\n\n── Checks output (last ${CHECKS_TAIL_LINES} lines) ──\n${lastLines(checks.output, CHECKS_TAIL_LINES)}`;
  }
  return text;
}

export function logExperiment(rt: LoopRuntime, co: Checkout, params: LogParams): Promise<string> {
  return serialized(co, async () => {
    requireNotRunning(rt, co);
    const key = checkoutKey(co);
    logging.add(key);
    try {
      return await recordRun(rt, co, params);
    } finally {
      logging.delete(key);
    }
  });
}

/** Record one run: judge it, keep or revert it, append it to the log, and fire the hooks. */
async function recordRun(rt: LoopRuntime, co: Checkout, params: LogParams): Promise<string> {
  const before = await readSession(co);
  if (!before.hasConfig) throw new Refusal(NOT_INITIALIZED, NOT_INITIALIZED_HINT);
  await requireBelowMax(co, before.runs.length);
  const maxIterations = await readMaxIterations(co);
  // Resolved before any git step, so a broken workingDir refuses with nothing written.
  const at = await resolveRunDir(co);
  const record = rt.get(co);
  const goal = record?.goal ?? null;

  const lastRun = record?.lastRun ?? null;
  if (params.status === "keep" && lastRun && !lastRun.benchmarkPassed) {
    throw new Refusal(
      "Cannot keep — the benchmark did not pass.",
      "Log this run as 'crash' instead. Only a run whose benchmark passed can be kept.",
    );
  }
  if (params.status === "keep" && lastRun?.checks && !lastRun.checks.pass) {
    const checksRel = readablePath(co.workDir, (await sessionPaths(co)).file.checks);
    throw new Refusal(
      `Cannot keep — ${checksRel} failed.\n\n${lastRun.checks.output}`,
      "Log as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.",
    );
  }

  const secondary = params.metrics ?? {};
  const provided = Object.keys(secondary);
  const providedSet = new Set(provided);
  const known = before.secondaryMetrics.map((m) => m.name);
  const knownSet = new Set(known);
  if (known.length > 0) {
    const missing = known.filter((name) => !providedSet.has(name));
    if (missing.length > 0) {
      throw new Refusal(
        `Missing secondary metrics: ${missing.join(", ")}\n\n` +
          `You must provide all previously tracked metrics. Expected: ${known.join(", ")}\n` +
          `Got: ${provided.join(", ") || "(none)"}`,
        `Fix: include ${missing.map((m) => `"${m}": <value>`).join(", ")} in the metrics parameter.`,
      );
    }
    const newMetrics = provided.filter((name) => !knownSet.has(name));
    if (newMetrics.length > 0 && !params.force) {
      throw new Refusal(
        `New secondary metric${newMetrics.length > 1 ? "s" : ""} not previously tracked: ${newMetrics.join(", ")}\n\n` +
          `Existing metrics: ${known.join(", ")}`,
        `If this metric has proven very valuable to watch, call log_experiment again with force: true to add it. ` +
          `Otherwise, remove it from the metrics parameter.`,
      );
    }
  }

  // The commit the run is based on. An unknown revision is refused before anything is written.
  const baseRevision = params.commit.trim() || "HEAD";
  const baseCommit = await resolveCommit(co, baseRevision);
  if (baseCommit === null) {
    throw new Refusal(`"${baseRevision}" is not a commit in this checkout.`, "Pass the commit the run is based on, or leave commit out to use HEAD.");
  }

  const asi = params.asi && Object.keys(params.asi).length > 0 ? params.asi : undefined;
  const run = before.allRuns.length + 1;
  const segmentCount = before.runs.length + 1;
  const isBaseline = before.runs.length === 0;
  const entry: ReconstructedRun = {
    run,
    commit: baseCommit,
    metric: params.metric,
    metrics: secondary,
    status: params.status,
    description: params.description,
    timestamp: Date.now(),
    segment: before.segment,
    confidence: null,
    ...(asi ? { asi } : {}),
  };
  const results = [...before.allRuns, entry];
  entry.confidence = computeConfidence(results, before.segment, before.direction);

  const unit = before.metricUnit;
  const baseline = findBaselineMetric(results, before.segment);
  let text = `Logged #${run}: ${params.status} — ${params.description}`;
  if (baseline !== null) {
    text += `\nBaseline ${before.metricName}: ${formatNum(baseline, unit)}`;
    if (segmentCount > 1 && params.status === "keep" && params.metric > 0 && baseline !== 0) {
      const delta = params.metric - baseline;
      const pct = ((delta / baseline) * 100).toFixed(1);
      text += ` | this: ${formatNum(params.metric, unit)} (${delta > 0 ? "+" : ""}${pct}%)`;
    }
  }

  const defs = [...before.secondaryMetrics];
  for (const name of provided) {
    if (!defs.some((m) => m.name === name)) defs.push({ name, unit: inferMetricUnit(name) });
  }
  if (provided.length > 0) {
    const baselines = findBaselineSecondary(results, before.segment, defs.map((m) => m.name));
    const parts = provided.map((name) => {
      const value = secondary[name];
      let part = `${name}: ${formatNum(value, defs.find((m) => m.name === name)?.unit ?? "")}`;
      const bv = baselines[name];
      if (bv !== undefined && results.length > 1 && bv !== 0) {
        const d = value - bv;
        part += ` (${d > 0 ? "+" : ""}${((d / bv) * 100).toFixed(1)}%)`;
      }
      return part;
    });
    text += `\nSecondary: ${parts.join("  ")}`;
  }

  if (asi) {
    const parts = Object.entries(asi).map(([key, value]) => {
      const s = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}: ${s.length > 80 ? `${s.slice(0, 77)}…` : s}`;
    });
    if (parts.length > 0) text += `\n📋 ASI: ${parts.join(" | ")}`;
  }

  if (entry.confidence !== null) {
    const c = entry.confidence.toFixed(1);
    if (entry.confidence >= 2) {
      text += `\n📊 Confidence: ${c}× noise floor — improvement is likely real`;
    } else if (entry.confidence >= 1) {
      text += `\n📊 Confidence: ${c}× noise floor — improvement is above noise but marginal`;
    } else {
      text += `\n⚠️ Confidence: ${c}× noise floor — improvement is within noise. Consider re-running to confirm before keeping.`;
    }
  }

  text += `\n(${segmentCount} experiments${maxIterations !== null ? ` / ${maxIterations} max` : ""})`;

  if (params.status === "keep") {
    const trailer: Record<string, unknown> = {
      status: params.status,
      [before.metricName || "metric"]: params.metric,
      ...secondary,
    };
    const outcome = await commitKeep(co, params.description, trailer, { sessionOnlyOk: isBaseline });
    if (outcome.kind === "failed") {
      throw new Refusal(outcome.message, "Nothing was logged. Fix the git problem, then log the run again; the changes are still in the working tree.");
    }
    // Only the baseline may keep an unchanged tree; every later keep needs a change to keep.
    if ((outcome.kind === "nothing" || outcome.kind === "session-only") && !isBaseline) {
      throw new Refusal(
        "Nothing to keep: no change outside the session files.",
        "Nothing was logged. Log this run as discard, or make the change first.",
      );
    }
    text += `\n${outcome.message}`;
    if (outcome.kind === "committed") {
      // The commit is already made, so the run is logged even when its SHA cannot be read. Refusing here would leave the
      // git step done with no log line, and the next keep would find nothing to commit.
      entry.commit = outcome.sha ?? "";
      if (outcome.sha === null) {
        text += "\n⚠️ The commit's SHA could not be read, so this log line has no commit. Add it by hand: git rev-parse --short HEAD.";
      }
    }
  } else {
    try {
      await revertWork(co);
      text += `\n📝 Git: reverted changes (${params.status}) — autoresearch files preserved`;
    } catch (err) {
      // A discard that did not revert leaves the tree dirty, so the next run would be measured on it.
      throw new Refusal(`Git could not revert the changes: ${errorText(err)}`, "Nothing was logged. Fix the git problem, then log the run again.");
    }
  }

  const logFile = (await sessionPaths(co)).file.log;
  try {
    await appendJsonLine(co, logFile, entry);
  } catch (err) {
    // The git step is done, so the change is committed (keep) or already reverted (discard). Only the log line is missing.
    const state = params.status === "keep" ? `Its change is committed as ${entry.commit}` : "The changes were reverted";
    text += `\n⚠️ The run is not in ${readablePath(co.workDir, logFile)}: ${errorText(err)}. ${state}; add the log line by hand.`;
  }
  rt.countExperiment(co);
  rt.update(co, { lastRun: null });

  const afterNote = await runStageHook("after", at, goal, { runEntry: entry });
  if (afterNote) text += `\n\n${afterNote}`;

  if (maxIterations !== null && segmentCount >= maxIterations) {
    text += `\n\n🛑 Maximum experiments reached for this segment (${maxIterations}). STOP the experiment loop now.`;
    await stopLoop(rt, co, `Maximum experiments reached for this segment (${maxIterations})`);
  } else if (rt.get(co)?.active) {
    text +=
      "\n\nBefore choosing the next experiment, consider whether this result or discovery invalidates a previous discard's rollback reason. " +
      "If so, name what changed and weigh a targeted retry against other candidates. Otherwise, move on. " +
      "Don't revive a discarded idea without a changed assumption. Verification reruns to resolve measurement noise are separate.";
    const beforeNote = await runStageHook("before", at, goal, { nextRun: run + 1, lastRun: entry });
    if (beforeNote) text += `\n\n${beforeNote}`;
  }
  await refreshNote(rt, co);
  return text;
}

/**
 * Start the loop for a checkout. The caller sends the kickoff message to the owner thread.
 * Queued behind any log call in flight, since the clean-tree check reads the git state a keep is changing.
 */
export function startLoop(
  rt: LoopRuntime,
  co: Checkout,
  ownerThreadId: string | null,
  goal: string | null,
): Promise<LoopRecord> {
  return serialized(co, async () => {
    requireNotRunning(rt, co);
    await requireRepo(co);
    // A discard reverts every change outside the session files, so the tree must hold none of the user's own work.
    await requireCleanTree(co);
    await requireBelowMax(co, (await readSession(co)).runs.length);
    const existing = rt.get(co);
    rt.resetExperiments(co);
    const record = rt.update(co, {
      active: true,
      ownerThreadId,
      goal: goal ?? existing?.goal ?? null,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      stopReason: null,
      autoResumeTurns: 0,
    });
    await refreshNote(rt, co);
    return record;
  });
}

/**
 * Stops a loop by its reference: cancels its pending resume and records why. It reads
 * no checkout, so it works when the folder is gone.
 */
export function stopLoopRef(rt: LoopRuntime, ref: CheckoutRef, reason: string | null): LoopRecord {
  rt.cancelAutoResume(ref);
  const record = rt.update(ref, { active: false, stoppedAt: new Date().toISOString(), stopReason: reason });
  rt.setNote(ref, null);
  return record;
}

export async function stopLoop(rt: LoopRuntime, co: Checkout, reason: string | null): Promise<LoopRecord> {
  const record = stopLoopRef(rt, co, reason);
  await refreshNote(rt, co);
  return record;
}

/** Finalize only makes sense once something has been logged. */
export async function requireLoggedExperiments(co: Checkout): Promise<SessionView> {
  const view = await readSession(co);
  if (!view.hasConfig) throw new Refusal(NOT_INITIALIZED, NOT_INITIALIZED_HINT);
  if (view.allRuns.length === 0) {
    throw new Refusal("No experiments logged yet, so there is nothing to finalize.", "Log at least one run first.");
  }
  return view;
}

/**
 * Delete the session log and forget the loop. Queued behind any log call in flight,
 * so none of them writes into a log that was just cleared. The caller has already checked `--yes`.
 */
export function clearSession(rt: LoopRuntime, co: Checkout): Promise<string> {
  return serialized(co, async () => {
    requireNotRunning(rt, co);
    const logFile = (await sessionPaths(co)).file.log;
    await co.ws.remove(logFile);
    rt.remove(co);
    return `Deleted ${readablePath(co.workDir, logFile)} and turned autoresearch off.`;
  });
}

/** Owner-thread instructions for an active loop, from the note refreshNote keeps current. Null for every other thread. */
export function ownerInstructions(rt: LoopRuntime, threadId: string): string | null {
  const record = rt.ownedBy(threadId).find((candidate) => candidate.active);
  if (!record) return null;
  return rt.noteFor(record) ?? `## Autoresearch loop (ACTIVE)\n${record.goal ? `Goal: ${record.goal}\n` : ""}State is loading.`;
}

/** An idle owner thread gets the next iteration after a short settle, unless the loop has paused. */
export function onThreadIdle(rt: LoopRuntime, threadId: string, deps: ResumeDeps): void {
  for (const record of rt.ownedBy(threadId)) {
    if (!record.active || record.stopReason) continue;
    if (rt.experimentsThisSession(record) === 0) continue;
    armResume(rt, record, threadId, deps);
  }
}

function armResume(rt: LoopRuntime, record: LoopRecord, threadId: string, deps: ResumeDeps): void {
  // Counted now: if the thread becomes active before the resume sends, the count differs and nothing is sent.
  const seen = rt.activationsOf(threadId);
  rt.scheduleAutoResume(record, SETTLE_MS, () => {
    resumeLoop(rt, record, threadId, seen, deps).catch((err: unknown) => deps.log(`auto-resume failed: ${errorText(err)}`));
  });
}

/**
 * Re-arms the resumes a reload interrupted: each owner went idle, and its settle had not run out when the plugin
 * reloaded. That decision was made before the reload, so the in-memory experiment count does not apply. The thread
 * must still be idle now. Otherwise the stored resume is dropped, and the next idle decides as usual.
 */
export async function rearmPendingResumes(rt: LoopRuntime, deps: ResumeDeps): Promise<void> {
  for (const record of rt.activeRecords()) {
    const threadId = record.ownerThreadId;
    if (!record.pendingResumeAt || record.stopReason || !threadId) continue;
    // Counted before the lookup: an activation during it has already cancelled the stored resume.
    const seen = rt.activationsOf(threadId);
    let status: string;
    try {
      status = await deps.status(threadId);
    } catch (err) {
      // Unknown is not idle. Nothing is sent, and the next idle decides.
      rt.cancelAutoResume(record);
      deps.log(`auto-resume not re-armed for ${checkoutLabel(record)}: ${errorText(err)}`);
      continue;
    }
    if (rt.activationsOf(threadId) !== seen || !activeLoopFor(rt, record, threadId)) continue;
    if (status !== "idle") {
      rt.cancelAutoResume(record);
      continue;
    }
    armResume(rt, record, threadId, deps);
  }
}

/** A thread that goes active again is not idle; cancel what was pending. */
export function onThreadActive(rt: LoopRuntime, threadId: string): void {
  rt.noteThreadActive(threadId);
  for (const record of rt.ownedBy(threadId)) rt.cancelAutoResume(record);
}

/** The loop record when `threadId` still owns it and it is running, otherwise null. Callers check again after every await. */
function activeLoopFor(rt: LoopRuntime, ref: CheckoutRef, threadId: string): LoopRecord | null {
  const record = rt.get(ref);
  if (!record?.active || record.stopReason || record.ownerThreadId !== threadId) return null;
  return record;
}

/**
 * Sends the next iteration to the owner thread after it goes idle. The loop stops when it
 * cannot continue there: its folder is gone, its thread works in another checkout, or its
 * segment is full. An unreadable session pauses it. A lookup that does not finish changes
 * nothing, and the next idle retries.
 */
async function resumeLoop(rt: LoopRuntime, ref: CheckoutRef, threadId: string, seen: number, deps: ResumeDeps): Promise<void> {
  if (!activeLoopFor(rt, ref, threadId)) return;
  const co = deps.open(ref);
  let current: CheckoutRef;
  let present: boolean;
  try {
    current = await deps.current(threadId);
    present = await co.ws.isDirectory(co.workDir);
  } catch (err) {
    // A thread with no checkout cannot run this loop. Any other failure is a lookup that did not finish.
    if (err instanceof Refusal && activeLoopFor(rt, ref, threadId)) {
      stopLoopRef(rt, ref, err.message);
      return;
    }
    deps.log(`auto-resume skipped for ${checkoutLabel(ref)}: ${errorText(err)}`);
    return;
  }
  if (!activeLoopFor(rt, ref, threadId)) return;
  if (!present) {
    stopLoopRef(rt, ref, `The checkout folder is missing: ${checkoutLabel(ref)}`);
    return;
  }
  if (checkoutKey(current) !== checkoutKey(ref)) {
    stopLoopRef(rt, ref, `The thread moved to ${checkoutLabel(current)}.`);
    return;
  }
  let view: SessionView;
  let maxIterations: number | null;
  try {
    view = await readSession(co);
    // An unreadable config.json pauses the loop here too; run and log refuse it the same way.
    maxIterations = await readMaxIterations(co);
  } catch (err) {
    if (activeLoopFor(rt, ref, threadId)) {
      rt.update(co, { stopReason: `Auto-resume paused: the session could not be read (${errorText(err)})` });
      await refreshNote(rt, co);
    }
    return;
  }
  // The loop may have been stopped, removed or handed to another thread while the session was read.
  const record = activeLoopFor(rt, ref, threadId);
  if (!record) return;
  // maxIterations can be lowered while the loop runs. A full segment has nothing left to run.
  if (maxIterations !== null && view.runs.length >= maxIterations) {
    await stopLoop(rt, co, `Maximum experiments reached for this segment (${maxIterations})`);
    return;
  }
  const reason = autoResumeStopReason(record.autoResumeTurns, view.runs);
  if (reason) {
    rt.update(co, { stopReason: reason });
    await refreshNote(rt, co);
    return;
  }
  // No await from here to the send: a thread that became active during the reads above is already taking a turn.
  if (rt.activationsOf(threadId) !== seen) return;
  rt.update(co, { autoResumeTurns: record.autoResumeTurns + 1 });
  try {
    await deps.send(threadId, `${AUTORESUME_MESSAGE}\n${stateLine(view)}\n\n${BENCHMARK_GUARDRAIL}`);
  } catch (err) {
    deps.log(`auto-resume send failed: ${errorText(err)}`);
    if (activeLoopFor(rt, ref, threadId)) {
      rt.update(co, { stopReason: `Auto-resume failed: ${errorText(err)}` });
      await refreshNote(rt, co);
    }
  }
}
