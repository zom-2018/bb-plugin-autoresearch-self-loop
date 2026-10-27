/**
 * Before/after hook scripts: `.auto/hooks/{before,after}.sh` (`.ps1` on a Windows
 * checkout), run with a JSON payload on stdin. Their output comes back inside the
 * tool result, where the agent reads it on its next step. Ported from pi-autoresearch (MIT, see README.md).
 */
import { randomUUID } from "node:crypto";

import { hasAutoresearchConfigHeader } from "./jsonl";
import { AUTO_DIR, type HookStage, sessionPaths } from "./paths";
import { pathsFor, scriptArgv } from "./shell";
import type { SessionSnapshot } from "./session";
import { type Checkout, appendJsonLine } from "./workspace";

const TIMEOUT_MS = 30_000;
const OUTPUT_MAX_BYTES = 8 * 1024;
const TRUNCATION_MARKER = "\n…[truncated: hook output exceeded 8KB]";

const NEWLINE = 0x0a;
const UTF8_CONT_MASK = 0xc0;
const UTF8_CONT = 0x80;
const UTF8_LEAD = 0xc0;

/** Trim at the last newline, falling back to the last complete UTF-8 character. */
function truncateAtBoundary(buf: Buffer): Buffer {
  const newlineEnd = buf.lastIndexOf(NEWLINE);
  if (newlineEnd >= 0) return buf.subarray(0, newlineEnd + 1);
  let end = buf.length;
  while (end > 0 && (buf[end - 1] & UTF8_CONT_MASK) === UTF8_CONT) end--;
  if (end > 0 && (buf[end - 1] & UTF8_CONT_MASK) === UTF8_LEAD) end--;
  return buf.subarray(0, end);
}

/** The first 8 KB of the output, cut at a line or character boundary. */
function capOutput(output: string): string {
  const buf = Buffer.from(output, "utf8");
  if (buf.length <= OUTPUT_MAX_BYTES) return output;
  return truncateAtBoundary(buf.subarray(0, OUTPUT_MAX_BYTES)).toString("utf8") + TRUNCATION_MARKER;
}

export interface BeforeHookPayload {
  event: "before";
  cwd: string;
  next_run: number;
  last_run: Record<string, unknown> | null;
  session: SessionSnapshot;
}

export interface AfterHookPayload {
  event: "after";
  cwd: string;
  run_entry: Record<string, unknown>;
  session: SessionSnapshot;
}

export type HookPayload = BeforeHookPayload | AfterHookPayload;

export interface HookResult {
  fired: boolean;
  /** Stdout and stderr together, capped at 8 KB. */
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

const NOT_FIRED: HookResult = { fired: false, output: "", exitCode: null, timedOut: false, durationMs: 0 };

/**
 * Runs the stage's script in the payload's directory, so the script needs no executable bit. The payload reaches
 * it on stdin, from a file written for this run and removed after it: a remote terminal has no stdin of its own.
 */
export async function runHook(co: Checkout, payload: HookPayload): Promise<HookResult> {
  const script = (await sessionPaths(co)).hook[payload.event];
  if (!(await co.ws.isFile(script))) return NOT_FIRED;

  const stdinPath = pathsFor(co.workDir).join(co.workDir, AUTO_DIR, `.stdin-${randomUUID()}`);
  await co.ws.writeText(stdinPath, JSON.stringify(payload));
  try {
    const run = await co.ws.exec({
      argv: scriptArgv(co.shell, script, stdinPath),
      cwd: payload.cwd,
      timeoutMs: TIMEOUT_MS,
    });
    const raw = run.spawnError ? [run.output, run.spawnError].filter(Boolean).join("\n") : run.output;
    return {
      fired: true,
      output: capOutput(raw),
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
    };
  } finally {
    await co.ws.remove(stdinPath).catch(() => undefined);
  }
}

/** The note the agent sees for a hook result, or null when the hook had nothing to say. */
export function hookNoteFor(stage: HookStage, result: HookResult): string | null {
  if (!result.fired) return null;
  if (result.timedOut) return `[${stage} hook timed out after ${TIMEOUT_MS / 1000}s]`;
  if (result.exitCode !== 0) {
    return [`[${stage} hook exited ${result.exitCode}]`, result.output.trim()].filter(Boolean).join("\n");
  }
  return result.output.trim() || null;
}

export function hookLogEntry(stage: HookStage, result: HookResult): Record<string, unknown> {
  return {
    type: "hook",
    stage,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    stdout_bytes: Buffer.byteLength(result.output, "utf8"),
    timed_out: result.timedOut,
  };
}

/** Append a hook record to the log only once the config header exists, so a bare log stays parseable. */
export async function appendHookLogEntryIfConfigured(co: Checkout, stage: HookStage, result: HookResult): Promise<void> {
  if (!result.fired) return;
  try {
    const logPath = (await sessionPaths(co)).file.log;
    const content = await co.ws.readText(logPath);
    if (content === null || !hasAutoresearchConfigHeader(content)) return;
    await appendJsonLine(co, logPath, hookLogEntry(stage, result));
  } catch {
    // The hook record is diagnostic; a failed append must not fail the run.
  }
}
