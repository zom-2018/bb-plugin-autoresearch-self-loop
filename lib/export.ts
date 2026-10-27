/**
 * Static HTML export of the current segment: a metric chart and the run table,
 * written to .auto/export.html. Pi serves a live page instead; a file needs no
 * server and can be opened or shared as is. Ported from pi-autoresearch (MIT, see README.md).
 */
import * as path from "node:path";

import { formatNum } from "./metrics";
import { AUTO_DIR } from "./paths";
import type { SessionView } from "./session";
import type { Checkout } from "./workspace";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

export function exportPath(workDir: string): string {
  return path.join(workDir, AUTO_DIR, "export.html");
}

function pct(value: number, base: number): string {
  const delta = ((value - base) / base) * 100;
  return `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

/** Metric per run as an inline SVG: kept runs green, the others grey, the baseline dashed. */
function chartSvg(view: SessionView): string {
  const runs = view.runs;
  if (runs.length === 0) return "<p class=\"muted\">No runs in this segment yet.</p>";

  const width = 720;
  const height = 240;
  const pad = 36;
  const values = runs.map((r) => r.metric);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (runs.length === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (runs.length - 1));
  const y = (v: number) => height - pad - ((v - min) / span) * (height - 2 * pad);

  const line = runs.map((r, i) => `${x(i).toFixed(1)},${y(r.metric).toFixed(1)}`).join(" ");
  const dots = runs
    .map((r, i) => {
      const fill = r.status === "keep" ? "#2e7d32" : "#9e9e9e";
      const title = `#${r.run} ${r.status} ${formatNum(r.metric, view.metricUnit)} — ${r.description}`;
      return `<circle cx="${x(i).toFixed(1)}" cy="${y(r.metric).toFixed(1)}" r="4" fill="${fill}"><title>${escapeHtml(title)}</title></circle>`;
    })
    .join("");
  const baseline = view.baseline
    ? `<line x1="${pad}" x2="${width - pad}" y1="${y(view.baseline.value).toFixed(1)}" y2="${y(view.baseline.value).toFixed(1)}" stroke="#777" stroke-dasharray="4 4"><title>baseline ${escapeHtml(formatNum(view.baseline.value, view.metricUnit))}</title></line>`
    : "";

  return (
    `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escapeHtml(view.metricName)} per run">` +
    `${baseline}<polyline points="${line}" fill="none" stroke="#888" stroke-width="1.5"/>${dots}` +
    `<text x="${pad}" y="16" font-size="12" fill="#666">${escapeHtml(view.metricName)} (${escapeHtml(view.metricUnit || "unitless")}), ${view.direction} is better</text>` +
    "</svg>"
  );
}

function runsTable(view: SessionView): string {
  const base = view.baseline?.value;
  const secondary = view.secondaryMetrics.map((m) => m.name);
  const head = [
    "<th>#</th>",
    "<th>status</th>",
    `<th>${escapeHtml(view.metricName)}</th>`,
    "<th>vs baseline</th>",
    ...secondary.map((name) => `<th>${escapeHtml(name)}</th>`),
    "<th>commit</th>",
    "<th>description</th>",
  ].join("");
  const rows = view.runs.map((r) => {
    const delta = base !== undefined && base !== 0 ? pct(r.metric, base) : "—";
    const cells = [
      `<td>${r.run}</td>`,
      `<td>${escapeHtml(r.status)}</td>`,
      `<td>${escapeHtml(formatNum(r.metric, view.metricUnit))}</td>`,
      `<td>${delta}</td>`,
      ...secondary.map((name) => {
        const def = view.secondaryMetrics.find((m) => m.name === name);
        const value = r.metrics[name];
        return `<td>${value === undefined ? "—" : escapeHtml(formatNum(value, def?.unit ?? ""))}</td>`;
      }),
      `<td><code>${escapeHtml(r.commit)}</code></td>`,
      `<td>${escapeHtml(r.description)}</td>`,
    ];
    return `<tr class="${r.status}">${cells.join("")}</tr>`;
  });
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

export function renderExportHtml(view: SessionView): string {
  const title = escapeHtml(view.name ?? "Autoresearch session");
  const base = view.baseline;
  const best = view.best;
  const stats = [
    ["Baseline", base ? formatNum(base.value, view.metricUnit) : "—"],
    ["Best kept", best ? formatNum(best.value, view.metricUnit) : "—"],
    ["Confidence", view.confidence !== null ? `${view.confidence.toFixed(1)}× noise floor` : "—"],
    ["Runs", String(view.runs.length)],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 960px; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .muted, .meta, .foot { color: #666; }
  dl.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: .5rem; margin: 1rem 0; }
  dl.stats div { border: 1px solid #ddd; border-radius: 6px; padding: .5rem .75rem; }
  dt { color: #666; font-size: 12px; } dd { margin: 0; font-size: 16px; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; font-size: 13px; }
  th, td { border-bottom: 1px solid #eee; padding: .35rem .5rem; text-align: left; vertical-align: top; }
  tr.keep { background: #e8f5e9; }
  tr.crash, tr.checks_failed { color: #888; }
  code { font-size: 12px; }
</style>
</head>
<body>
<h1>${title}</h1>
<p class="meta">${escapeHtml(view.metricName)} (${escapeHtml(view.metricUnit || "unitless")}), ${view.direction} is better · segment ${view.segment} · ${view.allRuns.length} runs logged in total</p>
<dl class="stats">${stats}</dl>
${chartSvg(view)}
${runsTable(view)}
<p class="foot">Exported ${new Date().toISOString()} from ${escapeHtml(view.logPath)}</p>
</body>
</html>
`;
}

/** Write the export next to the log and return its path. The caller checks there is a session. */
export async function writeExport(co: Checkout, view: SessionView): Promise<string> {
  const file = exportPath(co.workDir);
  await co.ws.writeText(file, renderExportHtml(view));
  return file;
}
