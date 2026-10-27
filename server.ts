// bb-plugin-autoresearch-self-loop — the backend entry.
//
// Ported from pi-autoresearch (MIT, see README.md). The loop logic lives in lib/;
// this file wires it to BB: three agent tools (init_experiment, run_experiment,
// log_experiment), the `bb self-loop` CLI, the panel's RPC contract, thread
// events for auto-resume, and the owner thread's instructions.
//
// A thread's checkout is on the environment the thread is in. The primary host is
// read and run on this plugin's disk; any other host is reached through the SDK.
import * as path from "node:path";

import {
  cliCommand,
  defineCli,
  defineRpcContract,
  experimental_PluginRpcRefusal,
  PluginCliError,
  type BbPluginApi,
  type PluginAgentToolResult,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

import { writeExport } from "./lib/export";
import { formatNum, type Direction } from "./lib/metrics";
import { buildPanelState, panelLoopOf, type PanelLoop, type PanelState, unavailableState } from "./lib/panel";
import { sessionPaths } from "./lib/paths";
import {
  clearSession,
  initExperiment,
  logExperiment,
  onThreadActive,
  onThreadIdle,
  ownerInstructions,
  rearmPendingResumes,
  refreshNote,
  requireLoggedExperiments,
  type ResumeDeps,
  runExperiment,
  startLoop,
  stopLoop,
  stopLoopRef,
} from "./lib/loop";
import { Refusal } from "./lib/refusal";
import { LoopRuntime, checkoutKey, type LoopRecord } from "./lib/runtime";
import { readSession } from "./lib/session";
import { stateLine } from "./lib/summary";
import { AUTORESUME_MESSAGE, BENCHMARK_GUARDRAIL } from "./lib/constants";
import { type Checkout, type CheckoutRef, checkoutLabel, openCheckout } from "./lib/workspace";

const CHANNEL = "self-loop-changed";

const threadInput = z.object({ threadId: z.string().min(1) });

/** Panel RPC: the panel reads state and runs its buttons through these methods. */
export const autoresearchContract = defineRpcContract({
  state: { input: threadInput, output: z.custom<PanelState>() },
  start: { input: threadInput.extend({ goal: z.string().optional() }), output: z.custom<PanelState>() },
  stop: { input: threadInput, output: z.custom<PanelState>() },
  finalize: { input: threadInput, output: z.custom<PanelState>() },
  export: { input: threadInput, output: z.object({ path: z.string() }) },
});

function refusalText(err: Refusal): string {
  return err.hint ? `${err.message}\n\n${err.hint}` : err.message;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Opens a checkout whose directory must already exist on its host. A missing one is
 * refused here: the session reads would find no files and report an empty loop
 * instead. The run directory is resolved only by the commands that run the benchmark,
 * so stop, status and clear still work with a broken config.json.
 */
async function openExistingCheckout(bb: BbPluginApi, ref: CheckoutRef): Promise<Checkout> {
  const co = openCheckout(bb.sdk, ref);
  if (!(await co.ws.isDirectory(co.workDir))) {
    throw new Refusal(
      `The checkout ${checkoutLabel(co)} does not exist or is not a directory.`,
      "Create the directory, or fix the environment's path or --dir.",
    );
  }
  return co;
}

/**
 * True when the host is the primary bb host, the one this plugin runs on. A config
 * that cannot be read is an error, not a guess: it propagates, so the run is refused
 * rather than sent to the wrong disk.
 */
async function isPrimaryHost(bb: BbPluginApi, hostId: string): Promise<boolean> {
  const system = await bb.sdk.system.config();
  return system.primaryHostId === hostId;
}

/**
 * The checkout a thread works in: its environment's path on the environment's own
 * host. The primary host is read from this disk; any other host is reached through
 * the SDK. A remote environment never falls back to this server's disk. The folder is
 * not checked here, so a loop can still be stopped after its folder is gone.
 */
async function checkoutRefForThread(bb: BbPluginApi, threadId: string): Promise<CheckoutRef> {
  const thread = await bb.sdk.threads.get({ threadId });
  if (!thread.environmentId) {
    throw new Refusal(
      "This thread has no environment, so there is no checkout to run in.",
      "Open the thread in an environment whose checkout holds the benchmark.",
    );
  }
  const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
  if (!environment.path) {
    throw new Refusal("This environment has no checkout path.", "Autoresearch needs a checkout in the thread's environment.");
  }
  if (!environment.hostId) {
    throw new Refusal("This environment has no host, so its checkout cannot be reached.", "Re-create the environment on a host.");
  }
  const hostId = (await isPrimaryHost(bb, environment.hostId)) ? null : environment.hostId;
  return { hostId, workDir: environment.path };
}

/** A thread's checkout, which must exist: the benchmark and the session reads need its files. */
async function checkoutForThread(bb: BbPluginApi, threadId: string): Promise<Checkout> {
  return openExistingCheckout(bb, await checkoutRefForThread(bb, threadId));
}

/** The target of a CLI command or tool: a thread's checkout, or a directory on the primary host for the shell. The folder is not checked here. */
async function cliTarget(
  bb: BbPluginApi,
  opts: { thread?: string; dir?: string },
  ctx: { cwd?: string; threadId?: string },
): Promise<{ ref: CheckoutRef; threadId: string | null }> {
  if (opts.thread && opts.dir) {
    throw new Refusal("Pass --thread or --dir, not both.", "--thread uses that thread's environment; --dir uses a directory on the primary host.");
  }
  if (opts.dir) {
    // A directory is not any thread's checkout. The calling thread is not attached to it, or its tools would find no loop.
    const workDir = path.resolve(ctx.cwd ?? process.cwd(), opts.dir);
    return { ref: { hostId: null, workDir }, threadId: null };
  }
  const threadId = opts.thread ?? ctx.threadId ?? null;
  if (!threadId) {
    throw new Refusal("No thread or checkout given.", "Pass --thread <id> or --dir <checkout>.");
  }
  return { ref: await checkoutRefForThread(bb, threadId), threadId };
}

/** A CLI target whose checkout must exist. */
async function cliCheckout(
  bb: BbPluginApi,
  opts: { thread?: string; dir?: string },
  ctx: { cwd?: string; threadId?: string },
): Promise<{ co: Checkout; threadId: string | null }> {
  const { ref, threadId } = await cliTarget(bb, opts, ctx);
  return { co: await openExistingCheckout(bb, ref), threadId };
}

async function sendToThread(bb: BbPluginApi, threadId: string, text: string): Promise<void> {
  await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
}

/** First message to the owner thread after a start: setup when there is no session yet, otherwise resume. */
async function kickoffMessage(co: Checkout, goal: string | null): Promise<string> {
  const goalLine = goal ? `Goal: ${goal}` : "No goal recorded.";
  const view = await readSession(co);
  const promptPath = (await sessionPaths(co)).file.prompt;
  if (!view.hasConfig || !(await co.ws.exists(promptPath))) {
    return `Autoresearch loop started. ${goalLine}\nSet up the session with the autoresearch-create skill, then call init_experiment.\n\n${BENCHMARK_GUARDRAIL}`;
  }
  return `Autoresearch loop resumed. ${goalLine}\n${stateLine(view)}\n${AUTORESUME_MESSAGE}\n\n${BENCHMARK_GUARDRAIL}`;
}

/**
 * Sends the start message. If it does not go out, the loop is stopped again: an active
 * loop with no agent to run it would wait for a run that never comes.
 */
async function handOff(bb: BbPluginApi, rt: LoopRuntime, co: Checkout, threadId: string, goal: string | null): Promise<void> {
  try {
    await sendToThread(bb, threadId, await kickoffMessage(co, goal));
  } catch (err) {
    const reason = `The start message was not sent to thread ${threadId}: ${errorText(err)}`;
    await stopLoop(rt, co, reason).catch((stopErr: unknown) =>
      bb.log.info(`Stopping the loop after a failed start also failed: ${errorText(stopErr)}`),
    );
    // The same text the status line shows, so the CLI and the panel say why the loop stopped.
    throw new Error(reason);
  }
}

/**
 * Stops the loops a thread is concerned with: the active one on the checkout it works
 * in, and every active loop it owns, even one on a checkout it has since left. Nothing
 * here reads the folder, so a stop works after the folder is gone. Returns what it stopped.
 */
function stopForThread(rt: LoopRuntime, threadId: string | null, current: CheckoutRef | null, reason: string): LoopRecord[] {
  const targets = new Map<string, CheckoutRef>();
  if (current && rt.get(current)?.active) targets.set(checkoutKey(current), current);
  if (threadId) {
    for (const record of rt.ownedBy(threadId)) {
      if (record.active) targets.set(checkoutKey(record), record);
    }
  }
  return [...targets.values()].map((ref) => stopLoopRef(rt, ref, reason));
}

/** The loop to show when the checkout cannot be read: the one on the thread's checkout if it runs, else an active one the thread owns. */
function fallbackLoop(rt: LoopRuntime, threadId: string, current: CheckoutRef | null): PanelLoop | null {
  const here = current ? rt.get(current) : null;
  const record = here?.active ? here : (rt.ownedBy(threadId).find((owned) => owned.active) ?? here);
  return record ? panelLoopOf(record, threadId, rt.runningFor(record)) : null;
}

/**
 * The panel's state for a thread. When the checkout cannot be read, the panel still
 * gets the thread's loop if it has one, so its Stop button stays.
 */
async function panelStateFor(bb: BbPluginApi, rt: LoopRuntime, threadId: string): Promise<PanelState> {
  let current: CheckoutRef | null = null;
  try {
    current = await checkoutRefForThread(bb, threadId);
    return await buildPanelState(rt, threadId, await openExistingCheckout(bb, current));
  } catch (err) {
    const reason = err instanceof Refusal ? refusalText(err) : errorText(err);
    return unavailableState(threadId, reason, fallbackLoop(rt, threadId, current));
  }
}

const FINALIZE_MESSAGE =
  "Finalize the autoresearch session now. Follow the autoresearch-finalize skill to group the kept runs into clean branches. The loop is stopped; do not run new experiments.";

async function statusText(rt: LoopRuntime, co: Checkout): Promise<string> {
  const view = await readSession(co);
  const record = rt.get(co);
  const loop = !record
    ? "off"
    : record.active
      ? record.stopReason ? `paused — ${record.stopReason}` : "active"
      : record.stopReason ? `stopped — ${record.stopReason}` : "stopped";
  // The owner shows in every state, so a loop that is not set up yet still says who has it.
  const owner = `Owner thread: ${record?.ownerThreadId ?? "—"}`;
  if (!view.hasConfig) return `Loop: ${loop}\nNo experiment is initialized in ${checkoutLabel(co)}.\n${owner}`;
  const count = (status: string) => view.runs.filter((r) => r.status === status).length;
  const unit = view.metricUnit || "unitless";
  return [
    `Loop: ${loop}`,
    `Session: ${view.name ?? "(unnamed)"} — ${view.metricName} (${unit}), ${view.direction} is better`,
    `Runs: ${view.runs.length} in segment ${view.segment} (keep ${count("keep")}, discard ${count("discard")}, crash ${count("crash")}, checks_failed ${count("checks_failed")})`,
    view.baseline ? `Baseline: ${formatNum(view.baseline.value, view.metricUnit)} (run #${view.baseline.run})` : "Baseline: —",
    view.best ? `Best kept: ${formatNum(view.best.value, view.metricUnit)} (run #${view.best.run ?? "?"})` : "Best kept: —",
    view.confidence !== null ? `Confidence: ${view.confidence.toFixed(1)}× noise floor` : "Confidence: —",
    owner,
  ].join("\n");
}

function parseSecondary(entry: string): [string, number] {
  const eq = entry.indexOf("=");
  const name = eq > 0 ? entry.slice(0, eq).trim() : "";
  // Number("") is 0, so an empty value is refused rather than read as zero.
  const raw = eq > 0 ? entry.slice(eq + 1).trim() : "";
  const value = raw === "" ? NaN : Number(raw);
  if (!name || !Number.isFinite(value)) {
    throw new PluginCliError(`Secondary metric "${entry}" must look like name=value with a number.`, { code: "invalid" });
  }
  return [name, value];
}

/** Run a CLI body. An expected refusal exits 1 with its hint; the output is the body's text. */
function cliRun(body: () => Promise<string>): Promise<PluginCliResult> {
  return body().then(
    (stdout) => ({ exitCode: 0, stdout: `${stdout}\n` }),
    (err: unknown) => {
      if (err instanceof Refusal) throw new PluginCliError(err.message, { code: "refused", hint: err.hint, exitCode: 1 });
      throw err;
    },
  );
}

/** Run an RPC body, turning an expected refusal into a conflict the panel can show. */
async function rpc<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof Refusal) throw new experimental_PluginRpcRefusal({ code: "conflict", message: refusalText(err) });
    throw err;
  }
}

/** Run a tool body; a refusal or failure comes back as the tool's error text, not a crash. */
async function toolRun(body: () => Promise<string>): Promise<PluginAgentToolResult> {
  try {
    return { content: [{ type: "text", text: await body() }] };
  } catch (err) {
    const text = err instanceof Refusal ? refusalText(err) : errorText(err);
    return { content: [{ type: "text", text }], isError: true };
  }
}

const targetOptions = {
  thread: { type: "string", description: "Thread whose environment checkout to use. Defaults to the calling thread." },
  dir: { type: "string", description: "Directory on the primary host to use instead of a thread's environment." },
} as const;

export default async function plugin(bb: BbPluginApi) {
  const open = (ref: CheckoutRef) => openCheckout(bb.sdk, ref);
  const rt = new LoopRuntime({
    kv: bb.storage.kv,
    publish: (ref) => bb.realtime.publish(CHANNEL, { workDir: ref.workDir, hostId: ref.hostId }),
    log: (message) => bb.log.info(message),
  });
  await rt.load();
  bb.onDispose(() => rt.dispose());

  // Owner notes live in memory; rebuild them for loops that were running before a reload.
  for (const record of rt.activeRecords()) {
    void refreshNote(rt, open(record)).catch((err: unknown) => bb.log.info(`note refresh failed: ${errorText(err)}`));
  }

  // ─── Agent tools ─────────────────────────────────────────────────────────

  bb.agents.registerTool({
    name: "init_experiment",
    description:
      "Set up an autoresearch session for this checkout: a name, the metric to optimize, its unit, and whether lower or higher is better. Writes the config header to the session log (.auto/log.jsonl, or autoresearch.jsonl in a legacy session) and activates the loop. Calling it again starts a new segment with a new baseline.",
    instructions:
      "Call init_experiment once before the first run_experiment of a session. The checkout must be a git repository with at least one commit and no uncommitted changes outside the session files (.auto/ and autoresearch.* at the checkout root).",
    parameters: z.object({
      name: z.string().min(1).describe("Short name for this session."),
      metric_name: z.string().min(1).describe("Name of the primary metric, as printed in METRIC name=value lines."),
      metric_unit: z.string().optional().describe("Unit of the primary metric, e.g. ms or kB. Leave empty when unitless."),
      direction: z.enum(["lower", "higher"]).optional().describe("Whether lower or higher is better. Defaults to lower."),
    }),
    execute: (params, ctx) =>
      toolRun(async () => {
        const co = await checkoutForThread(bb, ctx.threadId);
        return initExperiment(
          rt,
          co,
          {
            name: params.name,
            metricName: params.metric_name,
            metricUnit: params.metric_unit ?? "",
            direction: (params.direction ?? "lower") as Direction,
          },
          ctx.threadId,
        );
      }),
  });

  bb.agents.registerTool({
    name: "run_experiment",
    description:
      "Run the benchmark command, for example `bash .auto/measure.sh`. On a Windows checkout the scripts are PowerShell: `./.auto/measure.ps1`, and the checks script is `.auto/checks.ps1`. Captures the output, parses METRIC name=value lines, and runs the checks script (.auto/checks.sh or .ps1, or autoresearch.checks.sh in a legacy session) when it exists and the benchmark passed.",
    instructions:
      "Use run_experiment instead of bash for benchmark runs. After run_experiment, always call log_experiment with the result before starting another run.",
    parameters: z.object({
      command: z.string().min(1).describe("Shell command that runs the benchmark."),
      timeout_seconds: z.number().positive().optional().describe("Benchmark timeout in seconds. Defaults to 600."),
      checks_timeout_seconds: z.number().positive().optional().describe("Checks timeout in seconds. Defaults to 300."),
    }),
    execute: (params, ctx) =>
      toolRun(async () => {
        const co = await checkoutForThread(bb, ctx.threadId);
        return runExperiment(
          rt,
          co,
          {
            command: params.command,
            timeoutSeconds: params.timeout_seconds,
            checksTimeoutSeconds: params.checks_timeout_seconds,
          },
          ctx.signal,
        );
      }),
  });

  bb.agents.registerTool({
    name: "log_experiment",
    description:
      "Record the outcome of the last run_experiment. 'keep' commits the change with git. 'discard', 'crash', and 'checks_failed' revert code changes and keep the autoresearch files.",
    instructions: [
      "log_experiment automatically runs git add -A && git commit on 'keep', and auto-reverts code changes on 'discard'/'crash'/'checks_failed' (autoresearch files are preserved). Do NOT commit or revert manually.",
      "Always include the asi parameter. At minimum: {\"hypothesis\": \"what you tried\"}. On discard/crash, also include rollback_reason and next_action_hint.",
      "Record ideas you rule out or defer in the ideas file (.auto/ideas.md, or autoresearch.ideas.md in a legacy session).",
    ].join("\n"),
    parameters: z.object({
      commit: z.string().optional().describe("Commit the run is based on. Defaults to HEAD."),
      metric: z.number().describe("Primary metric value from the run."),
      status: z.enum(["keep", "discard", "crash", "checks_failed"]).describe("Outcome of the run."),
      description: z.string().min(1).describe("What this run tried, in one line."),
      metrics: z.record(z.string(), z.number()).optional().describe("Secondary metric values, keyed by name."),
      force: z.boolean().optional().describe("Accept a secondary metric not tracked before."),
      asi: z.record(z.string(), z.unknown()).optional().describe("Structured notes: hypothesis, rollback_reason, next_action_hint."),
    }),
    execute: (params, ctx) =>
      toolRun(async () => {
        const co = await checkoutForThread(bb, ctx.threadId);
        return logExperiment(rt, co, {
          commit: params.commit ?? "HEAD",
          metric: params.metric,
          status: params.status,
          description: params.description,
          metrics: params.metrics,
          force: params.force,
          asi: params.asi,
        });
      }),
  });

  // ─── Owner-thread instructions and auto-resume ───────────────────────────

  bb.agents.contributeInstructions(({ threadId }) => ownerInstructions(rt, threadId));

  const resume: ResumeDeps = {
    open,
    current: (threadId) => checkoutRefForThread(bb, threadId),
    status: async (threadId) => (await bb.sdk.threads.get({ threadId })).status,
    send: (threadId, text) => sendToThread(bb, threadId, text),
    log: (message) => bb.log.info(message),
  };
  bb.events.on("thread.idle", ({ thread }) => onThreadIdle(rt, thread.id, resume));
  bb.events.on("thread.active", ({ thread }) => onThreadActive(rt, thread.id));
  // A reload can land inside a resume's settle. Re-arm it now if its thread is still idle.
  void rearmPendingResumes(rt, resume).catch((err: unknown) => bb.log.info(`auto-resume re-arm failed: ${errorText(err)}`));

  // ─── Panel RPC ───────────────────────────────────────────────────────────

  bb.rpc.register(autoresearchContract, {
    state: ({ threadId }) => panelStateFor(bb, rt, threadId),
    start: ({ threadId, goal }) =>
      rpc(async () => {
        const co = await checkoutForThread(bb, threadId);
        const started = await startLoop(rt, co, threadId, goal ?? null);
        await handOff(bb, rt, co, threadId, started.goal);
        return buildPanelState(rt, threadId, co);
      }),
    stop: ({ threadId }) =>
      rpc(async () => {
        // Nothing here reads the folder, so a thread whose checkout is gone can still stop its loops.
        const current = await checkoutRefForThread(bb, threadId).catch((err: unknown) => {
          bb.log.info(`Stop could not read the thread's checkout: ${errorText(err)}`);
          return null;
        });
        stopForThread(rt, threadId, current, "Stopped from the panel");
        return panelStateFor(bb, rt, threadId);
      }),
    finalize: ({ threadId }) =>
      rpc(async () => {
        const co = await checkoutForThread(bb, threadId);
        await requireLoggedExperiments(co);
        const owner = rt.get(co)?.ownerThreadId ?? threadId;
        await stopLoop(rt, co, "Finalizing");
        await sendToThread(bb, owner, FINALIZE_MESSAGE);
        return buildPanelState(rt, threadId, co);
      }),
    export: ({ threadId }) =>
      rpc(async () => {
        const co = await checkoutForThread(bb, threadId);
        const view = await readSession(co);
        if (!view.hasConfig) throw new Refusal("No experiment is initialized here.", "Start the loop first.");
        return { path: await writeExport(co, view) };
      }),
  });

  // ─── `bb self-loop` CLI ───────────────────────────────────────────────

  bb.cli.register(
    defineCli({
      name: "self-loop",
      summary: "Run the autoresearch experiment loop in a checkout",
      description:
        "Targets a thread's environment checkout (--thread, or the calling thread), or a directory on the primary host (--dir). The loop is the same one the agent runs through its tools.",
      commands: {
        start: cliCommand({
          summary: "Start the loop and hand it to the thread",
          positionals: [{ name: "goal", description: "What to optimize, in words", required: false }],
          options: targetOptions,
          run: ({ options, positionals }, ctx) =>
            cliRun(async () => {
              const { co, threadId } = await cliCheckout(bb, options, ctx);
              const started = await startLoop(rt, co, threadId, positionals.goal ?? null);
              if (!threadId) {
                return `Loop started for ${checkoutLabel(co)}, but no thread is attached. Pass --thread <id> instead of --dir to hand it to an agent.`;
              }
              await handOff(bb, rt, co, threadId, started.goal);
              return `Loop started for ${checkoutLabel(co)} and handed to thread ${threadId}.`;
            }),
        }),
        init: cliCommand({
          summary: "Set up the session (config header, metric, direction)",
          options: {
            ...targetOptions,
            name: { type: "string", required: true, description: "Short name for the session." },
            metric: { type: "string", required: true, description: "Primary metric name." },
            unit: { type: "string", description: "Metric unit. Leave empty when unitless." },
            direction: { type: "enum", values: ["lower", "higher"], description: "Whether lower or higher is better. Defaults to lower." },
          },
          run: ({ options }, ctx) =>
            cliRun(async () => {
              const { co, threadId } = await cliCheckout(bb, options, ctx);
              return initExperiment(
                rt,
                co,
                {
                  name: options.name,
                  metricName: options.metric,
                  metricUnit: options.unit ?? "",
                  direction: options.direction === "higher" ? "higher" : "lower",
                },
                threadId,
              );
            }),
        }),
        run: cliCommand({
          summary: "Run the benchmark once and print what the agent would see",
          positionals: [{ name: "command", description: "Shell command that runs the benchmark", required: true }],
          options: {
            ...targetOptions,
            timeout: { type: "integer", min: 1, max: 86400, description: "Benchmark timeout in seconds." },
          },
          run: ({ options, positionals }, ctx) =>
            cliRun(async () => {
              const { co } = await cliCheckout(bb, options, ctx);
              return runExperiment(rt, co, {
                command: positionals.command,
                timeoutSeconds: options.timeout,
              });
            }),
        }),
        log: cliCommand({
          summary: "Record the outcome of the last run",
          positionals: [{ name: "description", description: "What this run tried, in one line", required: true }],
          options: {
            ...targetOptions,
            status: { type: "enum", values: ["keep", "discard", "crash", "checks_failed"], required: true, description: "Outcome of the run." },
            metric: { type: "string", required: true, description: "Primary metric value, a number." },
            commit: { type: "string", description: "Commit the run is based on. Defaults to HEAD." },
            secondary: { type: "string", repeatable: true, description: "Secondary metric as name=value. Repeat for each one." },
            asi: { type: "string", description: "Structured notes as a JSON object." },
            force: { type: "boolean", description: "Accept a secondary metric that was not tracked before." },
          },
          run: ({ options, positionals }, ctx) =>
            cliRun(async () => {
              const { co } = await cliCheckout(bb, options, ctx);
              // Number("") is 0, so an empty value is refused rather than read as zero.
              const metric = options.metric.trim() === "" ? NaN : Number(options.metric);
              if (!Number.isFinite(metric)) {
                throw new PluginCliError("--metric must be a number.", { code: "invalid" });
              }
              const metrics = Object.fromEntries((options.secondary ?? []).map(parseSecondary));
              let asi: Record<string, unknown> | undefined;
              if (options.asi) {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(options.asi);
                } catch {
                  throw new PluginCliError("--asi must be valid JSON.", { code: "invalid" });
                }
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                  throw new PluginCliError("--asi must be a JSON object.", { code: "invalid" });
                }
                asi = parsed as Record<string, unknown>;
              }
              return logExperiment(rt, co, {
                commit: options.commit ?? "HEAD",
                metric,
                status: options.status as "keep" | "discard" | "crash" | "checks_failed",
                description: positionals.description,
                metrics,
                force: options.force,
                asi,
              });
            }),
        }),
        status: cliCommand({
          summary: "Show the loop state and the session's numbers",
          options: targetOptions,
          run: (input, ctx) =>
            cliRun(async () => statusText(rt, (await cliCheckout(bb, input.options, ctx)).co)),
        }),
        off: cliCommand({
          summary: "Stop the loop (the session log is kept)",
          options: targetOptions,
          run: (input, ctx) =>
            cliRun(async () => {
              // No folder check: turning a loop off must still work after its checkout was removed. A thread whose
              // environment cannot be read still has its own loops stopped, as the panel's Stop does.
              const target = await cliTarget(bb, input.options, ctx).then(
                (found) => ({ ...found, reason: null as string | null }),
                (err: unknown) => {
                  const threadId = input.options.dir ? null : (input.options.thread ?? ctx.threadId ?? null);
                  if (!threadId) throw err;
                  return { ref: null, threadId, reason: errorText(err) };
                },
              );
              const stopped = stopForThread(rt, target.threadId, target.ref, "Turned off from the CLI");
              if (stopped.length > 0) {
                return `Autoresearch is off for ${stopped.map((record) => checkoutLabel(record)).join(", ")}. The session log is kept.`;
              }
              if (!target.ref) {
                return `No loop is running for thread ${target.threadId}. Its checkout could not be read: ${target.reason}`;
              }
              return `No loop is running for ${checkoutLabel(target.ref)}.`;
            }),
        }),
        finalize: cliCommand({
          summary: "Stop the loop and hand the kept runs to the finalize skill",
          options: targetOptions,
          run: (input, ctx) =>
            cliRun(async () => {
              const { co, threadId } = await cliCheckout(bb, input.options, ctx);
              await requireLoggedExperiments(co);
              const owner = rt.get(co)?.ownerThreadId ?? threadId;
              await stopLoop(rt, co, "Finalizing");
              if (!owner) return "Loop stopped. No thread to hand the finalize step to; run the autoresearch-finalize skill yourself.";
              await sendToThread(bb, owner, FINALIZE_MESSAGE);
              return `Loop stopped and finalize handed to thread ${owner}.`;
            }),
        }),
        export: cliCommand({
          summary: "Write the session as a static HTML page",
          options: targetOptions,
          run: (input, ctx) =>
            cliRun(async () => {
              const { co } = await cliCheckout(bb, input.options, ctx);
              const view = await readSession(co);
              if (!view.hasConfig) throw new Refusal("No experiment is initialized here.", "Run `bb self-loop init` first.");
              return writeExport(co, view);
            }),
        }),
        clear: cliCommand({
          summary: "Delete the session log and turn autoresearch off",
          options: {
            ...targetOptions,
            yes: { type: "boolean", description: "Confirm the deletion." },
          },
          run: (input, ctx) =>
            cliRun(async () => {
              if (!input.options.yes) {
                throw new PluginCliError("clear deletes the session log (.auto/log.jsonl, or autoresearch.jsonl in a legacy session). Re-run with --yes to confirm.", { code: "confirm" });
              }
              const { co } = await cliCheckout(bb, input.options, ctx);
              return clearSession(rt, co);
            }),
        }),
      },
    }),
  );
}
