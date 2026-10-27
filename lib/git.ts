/**
 * The git operations behind keep and discard. Every call takes an argv array, so
 * descriptions and paths never pass through a shell. The session files at the
 * checkout root (`.auto/` and the legacy flat files listed in lib/paths.ts) stay out
 * of commits, reverts and the clean-tree check, matching pi-autoresearch (MIT, see README.md).
 *
 * Git runs through the checkout's workspace, so a remote checkout runs git on its
 * own host. A terminal has one output stream, so stdout and stderr arrive merged;
 * the parsers below read only lines of a known shape, so the merge does not matter.
 *
 * Every failure fails closed: a step that cannot tell whether the tree is clean, or
 * whether there is a change to keep, stops the run rather than guessing.
 */
import { LEGACY_SESSION_PATHS } from "./paths";
import type { Checkout } from "./workspace";

/** Queries that read a few refs or compare the index. */
const QUICK_MS = 10_000;
/** Steps that scan or write the whole tree. A commit can run hooks, so it gets minutes. */
const SLOW_MS = 120_000;
/** Exit code for a run that never exited (timeout, spawn error): git's own fatal code. */
const NEVER_EXITED = 128;

export interface GitResult {
  code: number;
  /** Stdout and stderr together. */
  output: string;
  timedOut: boolean;
}

export async function git(co: Checkout, args: string[], timeoutMs = QUICK_MS): Promise<GitResult> {
  const run = await co.ws.exec({ argv: ["git", ...args], cwd: co.workDir, timeoutMs });
  return {
    code: run.exitCode ?? NEVER_EXITED,
    output: run.output || run.spawnError || "",
    timedOut: run.timedOut,
  };
}

/** How a failed git step ended, for a message. */
function howItEnded(result: GitResult): string {
  return result.timedOut ? "timed out" : `exit ${result.code}`;
}

/** The end of a git message, short enough for a tool result. */
function tail(output: string): string {
  return output.trim().slice(0, 200);
}

/**
 * Pathspec that leaves the session files out of status, commit and revert. The
 * patterns name the checkout root (`:(glob)` stops `*` from crossing folders), so a
 * `.auto` folder deeper in the project is ordinary content.
 */
const SESSION_EXCLUDES = [
  ":(exclude,glob).auto",
  ":(exclude,glob).auto/**",
  // Each legacy name, and the same name as a folder. A project's own autoresearch.* files stay in the tree.
  ...LEGACY_SESSION_PATHS.flatMap((name) => [`:(exclude,glob)${name}`, `:(exclude,glob)${name}/**`]),
];

/**
 * `git clean` keeps the same session files. Its patterns are anchored at the
 * repository top, not at the checkout, so `revertWork` puts the checkout's path in front.
 */
const CLEAN_EXCLUDES = [".auto", ...LEGACY_SESSION_PATHS];

/** A `git status --porcelain` line: two status characters, a space, the path. */
const PORCELAIN_LINE = /^.{2} /;

export async function isGitRepo(co: Checkout): Promise<boolean> {
  const result = await git(co, ["rev-parse", "--is-inside-work-tree"]);
  return result.code === 0 && result.output.trim().endsWith("true");
}

/** True when a commit exists, so `git checkout` and `commit` have a base. */
export async function hasHeadCommit(co: Checkout): Promise<boolean> {
  return (await git(co, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
}

/**
 * Changed files outside the session files; empty when the tree is clean for experiments.
 * A failed status throws: an unknown tree must not pass as clean, since a discard would revert it.
 */
export async function dirtyPaths(co: Checkout): Promise<string[]> {
  // Untracked files are listed even when status.showUntrackedFiles is off. A discard deletes them, so they count as changes.
  const result = await git(co, ["status", "--porcelain", "--untracked-files=all", "--", ".", ...SESSION_EXCLUDES], SLOW_MS);
  if (result.code !== 0) {
    throw new Error(`git status failed (${howItEnded(result)}): ${tail(result.output)}`);
  }
  return result.output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => PORCELAIN_LINE.test(line));
}

/** The short SHA that a revision names, or null when it names no commit. */
export async function resolveCommit(co: Checkout, revision: string): Promise<string | null> {
  // A leading dash would read as an option to rev-parse, not as a revision.
  if (revision.startsWith("-")) return null;
  const result = await git(co, ["rev-parse", "--short=7", "--verify", "--quiet", `${revision}^{commit}`]);
  const sha = result.output.trim().split("\n").pop() ?? "";
  return result.code === 0 && /^[0-9a-f]{7,}$/.test(sha) ? sha : null;
}

/**
 * `committed`: a commit was made, `sha` is its short SHA.
 * `nothing`: the tree matches HEAD, so there is nothing to commit.
 * `session-only`: only session files changed, and the caller did not allow that commit.
 * `failed`: git refused a step; nothing was committed.
 */
export type CommitKind = "committed" | "nothing" | "session-only" | "failed";

export interface CommitOutcome {
  kind: CommitKind;
  /** Short SHA of the new commit; null unless `kind` is `committed` and the SHA could be read. */
  sha: string | null;
  /** One human-readable line for the tool result. */
  message: string;
}

/** Unstage this checkout's files, so a keep that did not commit leaves the index at HEAD. */
async function unstage(co: Checkout): Promise<void> {
  await git(co, ["reset", "-q", "--", "."], SLOW_MS);
}

async function failed(co: Checkout, message: string): Promise<CommitOutcome> {
  await unstage(co);
  return { kind: "failed", sha: null, message: `⚠️ ${message}` };
}

/**
 * Stage this checkout's files and commit them. Session files are staged too, as pi
 * does. A change made only of session files is not a change to keep: it is reported
 * as `session-only` and unstaged, unless `sessionOnlyOk` allows the commit (the
 * baseline records the starting state, session files included). Every outcome other
 * than `committed` leaves the index at HEAD.
 */
export async function commitKeep(
  co: Checkout,
  description: string,
  trailer: Record<string, unknown>,
  opts: { sessionOnlyOk: boolean },
): Promise<CommitOutcome> {
  const add = await git(co, ["add", "-A", "--", "."], SLOW_MS);
  if (add.code !== 0) return failed(co, `Git add failed (${howItEnded(add)}): ${tail(add.output)}`);

  // `diff --quiet` exits 0 for no difference, 1 for a difference, and anything else for an error.
  const staged = await git(co, ["diff", "--cached", "--quiet", "--", "."], SLOW_MS);
  if (staged.code === 0) {
    await unstage(co);
    return { kind: "nothing", sha: null, message: "📝 Git: nothing to commit (working tree clean)" };
  }
  if (staged.code !== 1) return failed(co, `Git diff failed (${howItEnded(staged)}): ${tail(staged.output)}`);

  const codeStaged = await git(co, ["diff", "--cached", "--quiet", "--", ".", ...SESSION_EXCLUDES], SLOW_MS);
  if (codeStaged.code > 1) return failed(co, `Git diff failed (${howItEnded(codeStaged)}): ${tail(codeStaged.output)}`);
  if (codeStaged.code === 0 && !opts.sessionOnlyOk) {
    await unstage(co);
    return { kind: "session-only", sha: null, message: "📝 Git: only autoresearch session files changed" };
  }

  // The pathspec keeps the commit to this checkout. A plain commit would also take anything else staged in the repository.
  const commit = await git(co, ["commit", "-m", `${description}\n\nResult: ${JSON.stringify(trailer)}`, "--", "."], SLOW_MS);
  if (commit.code !== 0) {
    return failed(co, `Git commit failed (${howItEnded(commit)}): ${tail(commit.output)}`);
  }
  // The summary line is "[branch sha] subject"; warnings can precede it in the merged output.
  const lines = commit.output.trim().split("\n");
  const summary = lines.find((line) => line.startsWith("[")) ?? lines[0] ?? "";
  return { kind: "committed", sha: await resolveCommit(co, "HEAD"), message: `📝 Git: committed — ${summary}` };
}

/** The checkout's path inside its repository, escaped for an exclude pattern: "" at the top, otherwise e.g. "sub/". */
async function checkoutPrefix(co: Checkout): Promise<string> {
  const result = await git(co, ["rev-parse", "--show-prefix"]);
  if (result.code !== 0) throw new Error(`git rev-parse failed (${howItEnded(result)}): ${tail(result.output)}`);
  // The prefix is the last line: a warning on stderr can come before it in the merged output.
  const prefix = result.output.trimEnd().split("\n").pop() ?? "";
  // A prefix is empty or ends in a slash. Anything else means git printed something other than the path.
  if (prefix !== "" && !prefix.endsWith("/")) {
    throw new Error(`git rev-parse printed no checkout path: ${tail(result.output)}`);
  }
  return prefix.replace(/[*?[\\]/g, "\\$&");
}

/**
 * Restore tracked files and drop untracked ones, leaving the session files alone.
 * The prefix is read first: without it the clean's excludes would miss a checkout
 * inside a larger repository, and the clean would delete the session log.
 * The index is reset first: `checkout -- .` restores from the index, so a change
 * staged by an earlier step would survive the discard. A failed step throws, since
 * the tree would still hold the rejected change.
 */
export async function revertWork(co: Checkout): Promise<void> {
  const prefix = await checkoutPrefix(co);
  const reset = await git(co, ["reset", "-q", "--", ".", ...SESSION_EXCLUDES], SLOW_MS);
  if (reset.code !== 0) {
    throw new Error(`git reset failed (${howItEnded(reset)}): ${tail(reset.output)}`);
  }
  const checkout = await git(co, ["checkout", "--", ".", ...SESSION_EXCLUDES], SLOW_MS);
  if (checkout.code !== 0) {
    throw new Error(`git checkout failed (${howItEnded(checkout)}): ${tail(checkout.output)}`);
  }
  const cleanArgs = ["clean", "-fd"];
  for (const pattern of CLEAN_EXCLUDES) cleanArgs.push("-e", `/${prefix}${pattern}`);
  const clean = await git(co, cleanArgs, SLOW_MS);
  if (clean.code !== 0) {
    throw new Error(`git clean failed (${howItEnded(clean)}): ${tail(clean.output)}`);
  }
}
