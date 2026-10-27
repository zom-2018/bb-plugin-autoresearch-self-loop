/**
 * Text for the owner thread's instructions and resume messages: where the loop
 * stands and where the detail lives. It points at the files and never inlines them.
 */
import { BENCHMARK_GUARDRAIL, INSTRUCTIONS_BUDGET } from "./constants";
import { formatNum } from "./metrics";
import type { SessionView } from "./session";

const RECENT_RUNS = 10;
const FIELD_CHARS = 120;

function clip(text: string, max = FIELD_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function asiText(asi: Record<string, unknown> | undefined, key: string): string {
  const value = asi?.[key];
  if (value === undefined || value === null) return "";
  return clip(typeof value === "string" ? value : JSON.stringify(value));
}

function deltaText(metric: number, view: SessionView): string {
  const base = view.baseline?.value;
  if (base === undefined || base === 0) return "";
  const pct = ((metric - base) / base) * 100;
  return ` (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`;
}

/** One-line state for a resume message. */
export function stateLine(view: SessionView): string {
  const best = view.best ? `best ${formatNum(view.best.value, view.metricUnit)} (run #${view.best.run ?? "?"})` : "no kept run yet";
  return `Current state: ${view.runs.length} runs in this segment, ${best}.`;
}

export interface SummaryInput {
  view: SessionView;
  goal: string | null;
  maxIterations: number | null;
  paused: string | null;
  /** The session files as the layout in use names them: `.auto/...`, or the legacy `autoresearch.*`. */
  files: { prompt: string; ideas: string; log: string };
}

/** Compact loop summary for the owner thread's instructions, kept under the budget. */
export function loopSummary(input: SummaryInput): string {
  const { view } = input;
  const unit = view.metricUnit || "unitless";
  const header = [
    `## Autoresearch loop (ACTIVE)${input.paused ? ` — paused: ${input.paused}` : ""}`,
    input.goal ? `Goal: ${clip(input.goal, 400)}` : null,
    `Metric: ${view.metricName} (${unit}), ${view.direction} is better.`,
    `Runs: ${view.runs.length}${input.maxIterations !== null ? ` / ${input.maxIterations}` : ""} in segment ${view.segment}.`,
    view.baseline ? `Baseline: ${formatNum(view.baseline.value, view.metricUnit)} (run #${view.baseline.run}).` : null,
    view.best ? `Best kept: ${formatNum(view.best.value, view.metricUnit)} (run #${view.best.run ?? "?"}).` : null,
    view.confidence !== null ? `Confidence: ${view.confidence.toFixed(1)}× noise floor.` : null,
    `Files: ${input.files.prompt} (session brief), ${input.files.ideas} (idea backlog), ${input.files.log} (full history).`,
    BENCHMARK_GUARDRAIL,
  ].filter((line): line is string => line !== null);

  const recent = view.runs.slice(-RECENT_RUNS).map((run) => {
    const metric = `${formatNum(run.metric, view.metricUnit)}${deltaText(run.metric, view)}`;
    const parts = [
      `- #${run.run} ${run.status} ${metric} | ${clip(run.description)}`,
      asiText(run.asi, "hypothesis") && `hyp: ${asiText(run.asi, "hypothesis")}`,
      asiText(run.asi, "next_action_hint") && `next: ${asiText(run.asi, "next_action_hint")}`,
      asiText(run.asi, "rollback_reason") && `rollback: ${asiText(run.asi, "rollback_reason")}`,
    ].filter(Boolean);
    return parts.join(" | ");
  });

  const lines = [...header, "", "Recent runs:", ...(recent.length > 0 ? recent : ["- none yet"])];
  let text = lines.join("\n");
  // Drop the oldest recent runs first when the block would overflow.
  while (text.length > INSTRUCTIONS_BUDGET && recent.length > 1) {
    recent.shift();
    text = [...header, "", "Recent runs:", ...recent].join("\n");
  }
  return text.length > INSTRUCTIONS_BUDGET ? `${text.slice(0, INSTRUCTIONS_BUDGET - 1)}…` : text;
}
