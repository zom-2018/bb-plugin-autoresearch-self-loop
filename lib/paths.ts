/**
 * Session file paths and per-checkout configuration.
 *
 * All autoresearch session files live under one `.auto/` folder at the checkout
 * root. Legacy flat `autoresearch.*` files (from the pi extension) are read only
 * when no `.auto/` layout exists yet, so in-flight pi sessions keep working.
 */
import type { Checkout } from "./workspace";
import { Refusal } from "./refusal";
import { type Shell, pathsFor, scriptExtension } from "./shell";

export const AUTO_DIR = ".auto";

export type SessionFileKind = "log" | "prompt" | "ideas" | "checks" | "measure" | "config";
export type HookStage = "before" | "after";

interface SessionFileName {
  current: string;
  legacy: string;
  /** A script: its name takes the checkout's script extension, `.sh` or `.ps1`. */
  script?: boolean;
}

const SESSION_FILE_NAMES: Record<SessionFileKind, SessionFileName> = {
  log: { current: "log.jsonl", legacy: "autoresearch.jsonl" },
  prompt: { current: "prompt.md", legacy: "autoresearch.md" },
  ideas: { current: "ideas.md", legacy: "autoresearch.ideas.md" },
  checks: { current: "checks", legacy: "autoresearch.checks", script: true },
  measure: { current: "measure", legacy: "autoresearch", script: true },
  config: { current: "config.json", legacy: "autoresearch.config.json" },
};

const KINDS = Object.keys(SESSION_FILE_NAMES) as SessionFileKind[];
const STAGES: HookStage[] = ["before", "after"];
const HOOKS_DIR = "hooks";
const LEGACY_HOOKS_DIR = "autoresearch.hooks";
const LEGACY_RUN_LOG = "autoresearch.run.log";

/** A session file's name on a checkout with this shell. The legacy names are pi's, and pi only ran bash. */
function sessionFileName(kind: SessionFileKind, shell: Shell, legacy: boolean): string {
  const spec = SESSION_FILE_NAMES[kind];
  const name = legacy ? spec.legacy : spec.current;
  return spec.script ? name + scriptExtension(shell) : name;
}

function hookFileName(stage: HookStage, shell: Shell): string {
  return stage + scriptExtension(shell);
}

/**
 * Every flat name a pi session can leave at the checkout root: the legacy session files,
 * the hooks folder and the run log. Git leaves exactly these names out of commits and
 * reverts; any other `autoresearch.*` file belongs to the project.
 */
export const LEGACY_SESSION_PATHS: readonly string[] = [
  ...KINDS.map((kind) => sessionFileName(kind, "posix", true)),
  LEGACY_HOOKS_DIR,
  LEGACY_RUN_LOG,
];

export interface SessionPaths {
  /** Effective path of each session file. */
  file: Record<SessionFileKind, string>;
  /** Effective path of each hook script. */
  hook: Record<HookStage, string>;
  /** Where a benchmark's full output goes. It sits beside the session log, so git leaves it out too. */
  runLog: string;
}

/**
 * Effective paths for one checkout, from a single existence probe. `.auto/` wins
 * once any of its session files exist; otherwise a legacy file is used when present.
 */
export async function sessionPaths(co: Checkout): Promise<SessionPaths> {
  const dir = co.workDir;
  const { join } = pathsFor(dir);
  const current = (kind: SessionFileKind) => join(dir, AUTO_DIR, sessionFileName(kind, co.shell, false));
  const legacy = (kind: SessionFileKind) => join(dir, sessionFileName(kind, co.shell, true));
  const hookCurrent = (stage: HookStage) => join(dir, AUTO_DIR, HOOKS_DIR, hookFileName(stage, co.shell));
  const hookLegacy = (stage: HookStage) => join(dir, LEGACY_HOOKS_DIR, hookFileName(stage, co.shell));

  // The hooks folder is not in the probe: a project's own `hooks/` must not switch the layout.
  const found = await co.ws.existence([
    ...KINDS.map(current),
    ...KINDS.map(legacy),
    ...STAGES.map(hookCurrent),
    ...STAGES.map(hookLegacy),
  ]);
  const has = (filePath: string) => found[filePath] === true;
  const currentLayout = KINDS.some((kind) => has(current(kind)));

  const file = Object.fromEntries(
    KINDS.map((kind) => {
      if (currentLayout || !has(legacy(kind))) return [kind, current(kind)];
      return [kind, legacy(kind)];
    }),
  ) as Record<SessionFileKind, string>;
  const hook = Object.fromEntries(
    STAGES.map((stage) => {
      if (currentLayout || !has(hookLegacy(stage))) return [stage, hookCurrent(stage)];
      return [stage, hookLegacy(stage)];
    }),
  ) as Record<HookStage, string>;
  // The run log follows the layout the session log uses, so a legacy session stays flat.
  const runLog = file.log === legacy("log") ? join(dir, LEGACY_RUN_LOG) : join(dir, AUTO_DIR, "run.log");
  return { file, hook, runLog };
}

export interface AutoresearchConfig {
  maxIterations?: number;
  workingDir?: string;
}

/**
 * Read the session config (`.auto/config.json`, or the legacy file). A missing file
 * reads as empty. A broken one is a refusal, so a typo cannot quietly move where
 * the benchmark runs or lift a limit.
 */
export async function readConfig(co: Checkout): Promise<AutoresearchConfig> {
  const text = await co.ws.readText((await sessionPaths(co)).file.config);
  if (text === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Refusal(
      `The session config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      "Fix or remove the config file.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Refusal("The session config must be a JSON object.", "Fix or remove the config file.");
  }
  // A limit that is not a positive whole number is refused, not read as unlimited: 0, a string or 2.5 must not lift or change the cap.
  const maxIterations: unknown = (parsed as AutoresearchConfig).maxIterations;
  if (maxIterations !== undefined && maxIterations !== null && !(typeof maxIterations === "number" && Number.isInteger(maxIterations) && maxIterations > 0)) {
    throw new Refusal(
      "maxIterations in the session config must be a positive whole number.",
      "Set maxIterations to a whole number above 0, or remove it for no limit.",
    );
  }
  return parsed as AutoresearchConfig;
}

/** `maxIterations` from config, or null for unlimited. readConfig has already checked the value. */
export async function readMaxIterations(co: Checkout): Promise<number | null> {
  return (await readConfig(co)).maxIterations ?? null;
}

/**
 * The run directory: where the benchmark, the checks and the hooks run. It is the
 * checkout root, or `workingDir` from config. Git and the session files stay at
 * the root, so `workingDir` must be inside the checkout: a run directory outside
 * it would make changes that the git commands never see.
 */
export async function resolveRunDir(root: Checkout): Promise<Checkout> {
  const { workingDir } = await readConfig(root);
  if (workingDir === undefined || workingDir === null) return root;
  if (typeof workingDir !== "string" || workingDir === "") {
    throw new Refusal("workingDir in the session config must be a path.", "Set workingDir to a directory inside the checkout, or remove it.");
  }
  const { resolve, relative: relativeTo, isAbsolute, sep } = pathsFor(root.workDir);
  const runDir = resolve(root.workDir, workingDir);
  const relative = relativeTo(root.workDir, runDir);
  if (relative === ".." || relative.startsWith(`..${sep}`) || isAbsolute(relative)) {
    throw new Refusal(`workingDir "${workingDir}" is outside the checkout.`, "Set workingDir to a directory inside the checkout.");
  }
  if (!(await root.ws.isDirectory(runDir))) {
    throw new Refusal(`workingDir "${workingDir}" is not an existing directory.`, "Create it, or fix workingDir in the session config.");
  }
  return { ...root, runDir };
}

/** A path relative to the workDir when it lives under it, otherwise the path as given. */
export function readablePath(workDir: string, filePath: string): string {
  const { relative: relativeTo, isAbsolute, sep } = pathsFor(workDir);
  const relative = relativeTo(workDir, filePath);
  if (!relative || relative === ".." || relative.startsWith(`..${sep}`) || isAbsolute(relative)) return filePath;
  return relative;
}
