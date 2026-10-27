/**
 * Metric parsing, number formatting, and the confidence score.
 * Ported from pi-autoresearch (MIT, see README.md): extensions/pi-autoresearch/index.ts.
 */
import type { ReconstructedRun } from "./jsonl";
import type { Shell } from "./shell";

export type Direction = "lower" | "higher";

const METRIC_LINE = /^METRIC\s+([\w.µ]+)=(\S+)\s*$/gm;

/** Names that could pollute an object when used as a key. */
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Parse `METRIC name=value` lines from command output. Last occurrence wins, so a
 * script can refine a value. Non-finite values are dropped.
 */
export function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  for (const match of output.matchAll(METRIC_LINE)) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) metrics.set(name, value);
  }
  return metrics;
}

/** 15586 → "15,586" */
function commas(n: number): string {
  const s = String(Math.round(n));
  const parts: string[] = [];
  for (let i = s.length; i > 0; i -= 3) parts.unshift(s.slice(Math.max(0, i - 3), i));
  return parts.join(",");
}

function fmtNum(n: number, decimals = 0): string {
  if (decimals <= 0 || !Number.isFinite(n) || Math.abs(n) >= 1e21) return commas(n);
  // Rounded as one number, so a fraction that rounds up to 1 carries into the integer part.
  const fixed = Math.abs(n).toFixed(decimals);
  const [int, frac] = fixed.split(".");
  const sign = n < 0 && Number(fixed) !== 0 ? "-" : "";
  return sign + commas(Number(int)) + "." + frac;
}

/** Integers print without decimals, fractions with two. null prints as an em dash. */
export function formatNum(value: number | null, unit: string): string {
  if (value === null) return "—";
  if (value === Math.round(value)) return fmtNum(value) + unit;
  return fmtNum(value, 2) + unit;
}

/** "1m 05s" or "42s" */
export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Unit inferred from a metric name suffix, for display only. */
export function inferMetricUnit(name: string): string {
  if (name.endsWith("µs")) return "µs";
  if (name.endsWith("_ms")) return "ms";
  if (name.endsWith("_s") || name.endsWith("_sec")) return "s";
  if (name.endsWith("_kb")) return "kb";
  if (name.endsWith("_mb")) return "mb";
  return "";
}

export function isBetter(current: number, best: number, direction: Direction): boolean {
  return direction === "lower" ? current < best : current > best;
}

function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

type RunLike = Pick<ReconstructedRun, "metric" | "status" | "segment">;

/** Runs in the given segment, in log order. */
export function segmentRuns<T extends RunLike>(results: T[], segment: number): T[] {
  return results.filter((r) => r.segment === segment);
}

/** Baseline = the first run in the segment. */
export function findBaselineMetric<T extends RunLike>(results: T[], segment: number): number | null {
  const cur = segmentRuns(results, segment);
  return cur.length > 0 ? cur[0].metric : null;
}

/** Best kept metric in the segment (min for lower, max for higher), with the run number that produced it. */
export function findBestMetric<T extends RunLike & { run?: number }>(
  results: T[],
  segment: number,
  direction: Direction,
): { value: number; run: number | null } | null {
  let best: { value: number; run: number | null } | null = null;
  for (const r of segmentRuns(results, segment)) {
    if (r.status !== "keep") continue;
    if (best === null || isBetter(r.metric, best.value, direction)) best = { value: r.metric, run: r.run ?? null };
  }
  return best;
}

/**
 * Confidence = |best kept − baseline| / MAD over the segment's positive metrics.
 * Null with fewer than three points, when MAD is zero, or when nothing beats baseline.
 */
export function computeConfidence<T extends RunLike>(
  results: T[],
  segment: number,
  direction: Direction,
): number | null {
  const cur = segmentRuns(results, segment).filter((r) => r.metric > 0);
  if (cur.length < 3) return null;

  const values = cur.map((r) => r.metric);
  const median = sortedMedian(values);
  const mad = sortedMedian(values.map((v) => Math.abs(v - median)));
  if (mad === 0) return null;

  const baseline = findBaselineMetric(results, segment);
  if (baseline === null) return null;

  let bestKept: number | null = null;
  for (const r of cur) {
    if (r.status === "keep" && r.metric > 0) {
      if (bestKept === null || isBetter(r.metric, bestKept, direction)) bestKept = r.metric;
    }
  }
  if (bestKept === null || bestKept === baseline) return null;
  return Math.abs(bestKept - baseline) / mad;
}

/** Secondary baselines: the first run's metrics, filled in from the first run that reports each known metric. */
export function findBaselineSecondary(
  results: Array<Pick<ReconstructedRun, "metrics" | "segment">>,
  segment: number,
  knownNames: string[],
): Record<string, number> {
  const cur = results.filter((r) => r.segment === segment);
  const base: Record<string, number> = cur.length > 0 ? { ...(cur[0].metrics ?? {}) } : {};
  for (const name of knownNames) {
    if (base[name] !== undefined) continue;
    for (const r of cur) {
      const value = (r.metrics ?? {})[name];
      if (value !== undefined) {
        base[name] = value;
        break;
      }
    }
  }
  return base;
}

/** A PowerShell run of the measure script: `./.auto/measure.ps1`, optionally with `&` and plain arguments. */
const POWERSHELL_MEASURE =
  /^(?:&[ \t]+)?(?:\/|\.{1,2}\/|[\w.-]+\/)*(?:autoresearch\.ps1|\.auto\/measure\.ps1)(?:[ \t]+(?:2>&1|[\w./=:@%+,-]+))*$/;

/**
 * The benchmark script is the first real command: env assignments and harmless wrappers are stripped first.
 * On a Windows checkout the script is the `.ps1`, and `\` separators count as `/`.
 */
export function isMeasureCommand(command: string, shell: Shell): boolean {
  if (shell === "powershell") return POWERSHELL_MEASURE.test(command.trim().replace(/\\/g, "/"));
  // Separators are spaces and tabs only: a newline ends a shell command, so it must not count as a separator here.
  let cmd = command.trim();
  cmd = cmd.replace(/^(?:\w+=\S*[ \t]+)+/, "");
  let prev: string;
  do {
    prev = cmd;
    cmd = cmd.replace(/^(?:env|time|nice|nohup)(?:[ \t]+-\S+(?:[ \t]+\d+)?)*[ \t]+/, "");
  } while (cmd !== prev);
  // Only plain arguments, or `2>&1`, may follow the script: `&&`, `;`, `|` or a quote could run something else too.
  return /^(?:(?:bash|sh|source)[ \t]+(?:-\w+[ \t]+)*)?(?:\/|\.{1,2}\/|[\w.-]+\/)*(?:autoresearch\.sh|\.auto\/measure\.sh)(?:[ \t]+(?:2>&1|[\w./=:@%+,-]+))*$/.test(
    cmd,
  );
}
