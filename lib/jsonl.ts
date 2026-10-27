// Ported from pi-autoresearch (MIT, see README.md): extensions/pi-autoresearch/jsonl.ts.
// Changed: an unknown run status is refused, not read as keep, and the refusal names its line.
import { Refusal } from "./refusal";

export type JsonlEntry = Record<string, unknown>;

export interface AutoresearchConfigEntry extends JsonlEntry {
  type: "config";
  name?: string;
  metricName?: string;
  metricUnit?: string;
  bestDirection?: "lower" | "higher";
}

export interface AutoresearchRunEntry extends JsonlEntry {
  run: number;
}

export interface ReconstructedMetricDef {
  name: string;
  unit: string;
}

export interface ReconstructedRun {
  run: number;
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  timestamp: number;
  segment: number;
  confidence: number | null;
  asi?: Record<string, unknown>;
}

export interface ReconstructedJsonlState {
  name: string | null;
  metricName: string;
  metricUnit: string;
  bestDirection: "lower" | "higher";
  currentSegment: number;
  results: ReconstructedRun[];
  secondaryMetrics: ReconstructedMetricDef[];
}

const DEFAULT_METRIC_NAME = "metric";
const DEFAULT_METRIC_UNIT = "";
const DEFAULT_DIRECTION = "lower" as const;

function isObjectRecord(value: unknown): value is JsonlEntry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter(Boolean);
}

function inferMetricUnit(name: string): string {
  if (name.endsWith("µs")) return "µs";
  if (name.endsWith("_ms")) return "ms";
  if (name.endsWith("_s") || name.endsWith("_sec")) return "s";
  if (name.endsWith("_kb")) return "kb";
  if (name.endsWith("_mb")) return "mb";
  return "";
}

function metricMapFrom(value: unknown): Record<string, number> {
  if (!isObjectRecord(value)) return {};

  const metrics: Record<string, number> = {};
  for (const [name, metric] of Object.entries(value)) {
    if (typeof metric === "number") metrics[name] = metric;
  }
  return metrics;
}

type RunStatus = ReconstructedRun["status"];
const RUN_STATUSES: readonly RunStatus[] = ["keep", "discard", "crash", "checks_failed"];

/** An unknown status is refused, not read as a keep: a hand-edited line must not count as a kept result. */
function statusFrom(value: unknown, line: number): RunStatus {
  const status = RUN_STATUSES.find((known) => known === value);
  if (status) return status;
  throw new Refusal(
    `Line ${line} of the session log has the status ${JSON.stringify(value)}. A run's status must be keep, discard, crash or checks_failed.`,
    "Fix that line of the session log, or remove it.",
  );
}

function directionFrom(value: unknown): ReconstructedJsonlState["bestDirection"] {
  return value === "higher" ? "higher" : DEFAULT_DIRECTION;
}

function asiFrom(value: unknown): Record<string, unknown> | undefined {
  return isObjectRecord(value) ? value : undefined;
}

function reconstructedState(): ReconstructedJsonlState {
  return {
    name: null,
    metricName: DEFAULT_METRIC_NAME,
    metricUnit: DEFAULT_METRIC_UNIT,
    bestDirection: DEFAULT_DIRECTION,
    currentSegment: 0,
    results: [],
    secondaryMetrics: [],
  };
}

function updateConfig(state: ReconstructedJsonlState, entry: AutoresearchConfigEntry): void {
  if (typeof entry.name === "string") state.name = entry.name;
  if (typeof entry.metricName === "string") state.metricName = entry.metricName;
  if (typeof entry.metricUnit === "string") state.metricUnit = entry.metricUnit;
  state.bestDirection = directionFrom(entry.bestDirection);
}

function nextSegment(state: ReconstructedJsonlState, segment: number): number {
  if (state.results.length === 0) return segment;
  state.secondaryMetrics = [];
  return segment + 1;
}

function runFrom(entry: AutoresearchRunEntry, segment: number, line: number): ReconstructedRun {
  return {
    run: typeof entry.run === "number" ? entry.run : 0,
    commit: typeof entry.commit === "string" ? entry.commit : "",
    metric: typeof entry.metric === "number" ? entry.metric : 0,
    metrics: metricMapFrom(entry.metrics),
    status: statusFrom(entry.status, line),
    description: typeof entry.description === "string" ? entry.description : "",
    timestamp: typeof entry.timestamp === "number" ? entry.timestamp : 0,
    segment,
    confidence: typeof entry.confidence === "number" ? entry.confidence : null,
    asi: asiFrom(entry.asi),
  };
}

function registerSecondaryMetrics(state: ReconstructedJsonlState, metrics: Record<string, number>): void {
  for (const name of Object.keys(metrics)) {
    if (state.secondaryMetrics.find((metric) => metric.name === name)) continue;
    state.secondaryMetrics.push({ name, unit: inferMetricUnit(name) });
  }
}

export function parseJsonlEntry(line: string): JsonlEntry | null {
  try {
    const parsed = JSON.parse(line);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isAutoresearchConfigEntry(entry: unknown): entry is AutoresearchConfigEntry {
  return isObjectRecord(entry) && entry.type === "config";
}

export function isAutoresearchRunEntry(entry: unknown): entry is AutoresearchRunEntry {
  return isObjectRecord(entry) && typeof entry.run === "number";
}

function firstConfigEntry(jsonlContent: string): AutoresearchConfigEntry | null {
  for (const line of nonEmptyLines(jsonlContent)) {
    const entry = parseJsonlEntry(line);
    if (isAutoresearchConfigEntry(entry)) return entry;
  }
  return null;
}

export function hasAutoresearchConfigHeader(jsonlContent: string): boolean {
  return firstConfigEntry(jsonlContent) !== null;
}

export function extractAutoresearchSessionName(jsonlContent: string): string {
  return firstConfigEntry(jsonlContent)?.name || "Autoresearch";
}

export function reconstructJsonlState(jsonlContent: string): ReconstructedJsonlState {
  const state = reconstructedState();
  let segment = 0;
  // Split before filtering, so each line keeps its number in the file and a refusal can name it.
  const lines = jsonlContent.split("\n");

  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]) continue;
    const entry = parseJsonlEntry(lines[index]);
    if (!entry) continue;

    if (isAutoresearchConfigEntry(entry)) {
      updateConfig(state, entry);
      segment = nextSegment(state, segment);
      state.currentSegment = segment;
      continue;
    }

    if (!isAutoresearchRunEntry(entry)) continue;

    const run = runFrom(entry, segment, index + 1);
    state.results.push(run);
    registerSecondaryMetrics(state, run.metrics);
  }

  return state;
}
