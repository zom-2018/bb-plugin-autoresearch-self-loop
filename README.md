# Autoresearch Self Loop

A BB port of [pi-autoresearch](https://pi.dev/packages/pi-autoresearch) v1.9.0.
An agent runs an experiment loop in a git checkout: it edits the code, runs a
benchmark, and decides whether to keep or discard the change. The plugin runs
the benchmark and the checks, enforces the keep rules, and appends every run to
a session log. The log lets a loop survive restarts and context resets.

This is a close port of pi-autoresearch adapted for BB. It presents a compact
panel and an autonomous workflow: after setup, the agent can iterate without a
series of manual approval steps. BB permissions and repository protections
still apply.

> Based on pi-autoresearch, MIT License, Copyright (c) 2026 Tobi Lutke,
> David Cortés (the upstream `LICENSE`). The skills under `skills/` are adapted
> from it.

## The panel

The dashboard is the plugin's `app` (`app.tsx`, declared in `package.json`). It
is kept per thread, because a loop belongs to one thread and one checkout. It
shows the session (metric, baseline, best kept run, confidence), the run table,
and the Start/Resume, Stop, Finalize and Export buttons. There are no approval
steps; see [Behaviour notes](#behaviour-notes).

## Install

```
npm install
bb plugin build .
bb plugin install . --yes
bb plugin reload
```

- `bb plugin build .` compiles `dist/` and needs no server.
- `bb plugin install` runs on the BB server, so the server must be up. Without
  `--yes` it shows a confirmation prompt first; read that prompt before you
  accept it.
- `bb plugin reload` with no id reloads every plugin. Pass an id to reload one.

## Requirements

- The checkout is a git repository with at least one commit.
- `init` and `start` require a clean working tree. The session files (`.auto/`
  and the legacy flat files listed under Session files) are not counted as
  changes. Any other `autoresearch.*` file at the root is the project's own.
- The checkout is the thread's environment path, on the environment's host. The
  directory must exist on that host. See Remote environments.

## Remote environments

A loop runs on the host of its thread's environment. Its files, commands and
checks go to that host. The plugin never falls back to a path with the same name
on the primary host.

- On the **primary BB host** the plugin reads, writes and runs commands on its
  own disk.
- On **any other host** every read, write, existence check and command goes
  through the BB server's SDK: files through `files`, existence through
  `hosts.pathsExist`, and commands in a terminal scoped to that host and the
  checkout directory. The plugin runs no agent on the remote host.
- **A remote loop depends on the BB server.** The server is the only channel to
  the remote host, so if it is down, remote operations fail with an error. This
  path has been tested only against a mocked SDK.
- A checkout path that does not exist on its host is refused.
- A file read that comes back short is refused, not used. An append to a remote
  file is read-modify-write, so two processes appending at the same moment can
  lose a line.
- Whether a path is a directory or a file asks for its existence first. Only a
  path that exists gets a terminal to test it. A test that cannot run is an
  error, not a "no".

What a remote host must provide:

- POSIX, with `sh`, `bash` and `git` installed.
- A git committer identity (`user.name` and `user.email`), because a `keep`
  commits there.

What that costs and how it behaves:

- Each command opens a terminal titled `autoresearch` and force-closes it when
  the command ends. The plugin polls for the output every 250 ms, so each command
  adds at least one round trip. If closing fails, the error is ignored and the
  terminal can stay open.
- A terminal merges stdout and stderr into one stream. Terminal escape sequences
  (colour, cursor and title codes) are stripped from it. Only the last 8 MB of
  output is kept.
- The panel's refresh makes several round trips to the remote host, so it is
  slower there.

## CLI

```
bb self-loop start ["goal"] [--thread <id> | --dir <checkout>]
bb self-loop init --name <name> --metric <metric> [--unit <u>] [--direction lower|higher]
bb self-loop run "<command>" [--timeout <seconds>]
bb self-loop log "<what this run tried>" --status keep|discard|crash|checks_failed --metric <value> [--commit <sha>] [--secondary name=value ...] [--asi '<json>'] [--force]
bb self-loop status
bb self-loop off
bb self-loop finalize
bb self-loop export
bb self-loop clear --yes
```

- `--thread` defaults to the calling thread. Passing `--thread` and `--dir`
  together is refused.
- `--dir` targets a checkout on the primary host. It attaches no thread, so
  `start --dir` starts the loop but never hands it to an agent. The CLI says so
  and tells you to pass `--thread`. It also clears the owner of that checkout's
  loop, so no thread resumes it until a `start --thread`.
- `start` with a thread sends the agent its setup or resume message. If that
  message cannot reach the thread, the loop is stopped again and `start` fails
  with the reason.
- A refused command prints its message and a hint, and exits 1.
- `off` stops the loop on the checkout that `--thread` or `--dir` names. For a
  thread it also stops every active loop that thread owns, even one on a
  checkout it has since left. The panel's Stop does the same for its thread.
  Neither reads the folder, so both work after the folder is gone.

## Agent tools

The plugin registers three tools. Each one checks the loop state itself.

- `init_experiment` names the session and sets the primary metric, its unit and
  its direction (default `lower`). Calling it again starts a new segment with a
  new baseline.
- `run_experiment` runs the benchmark and parses its `METRIC name=value` lines.
  The benchmark timeout defaults to 600 s. If the benchmark passes, it runs
  `.auto/checks.sh` when that file exists, with a 300 s default timeout.
- `log_experiment` records the outcome. `keep` commits the checkout's changes
  with a `Result:` trailer and logs the new commit; anything else staged in the
  repository stays out of it. `discard`, `crash` and `checks_failed` revert every
  change outside the session files, staged or not, delete the untracked files
  that git does not ignore, and log the base commit. The session files are kept.

The plugin enforces these rules:

- A `keep` is refused when the last benchmark failed (log it as `crash`) or its
  checks failed (log it as `checks_failed`).
- A `run` sets that result, and a `log` clears it. So a `keep` logged with no new
  `run` is not checked against a benchmark or its checks.
- A `keep` with no change outside the session files is refused, except for the
  baseline.
- A refusal is an error result from the tool, and nothing is recorded.
- If a git step fails (status, commit or revert), the tool refuses and logs
  nothing. The next run is never measured on a tree the plugin could not check.

## Session files

Everything lives under `.auto/` in the checkout.

| File | Purpose |
| --- | --- |
| `log.jsonl` | Every run, appended. The source of truth. |
| `config.json` | Optional. See Config below. |
| `measure.sh` | Your benchmark script. The agent writes it during setup. While it exists, `run` accepts only this script. |
| `checks.sh` | Optional. Runs after a benchmark that passed. A `keep` is refused while the last checks failed. |
| `hooks/before.sh`, `hooks/after.sh` | Optional hooks. See Hooks. |
| `prompt.md` | The session brief. The agent writes it during setup. `start` sends the resume message when the log has its config header and this file exists. |
| `ideas.md` | The agent's backlog of ideas it ruled out or deferred. `finalize` prints it. The plugin's code does not otherwise read it. |
| `run.log` | The output of the most recent benchmark run, kept to its last 8 MB. In a legacy session it is `autoresearch.run.log` at the checkout root. |
| `export.html` | A static page with the run table, written by `export`. The export result gives its path. |

Legacy layout: when no `.auto/` session file exists yet, the flat files at the
checkout root are read instead: `autoresearch.jsonl` (the log), `autoresearch.md`
(the prompt), `autoresearch.ideas.md`, `autoresearch.checks.sh`,
`autoresearch.sh` (the benchmark), `autoresearch.config.json`,
`autoresearch.hooks/` and `autoresearch.run.log`. Once any `.auto/` session file
exists, `.auto/` wins. The `init`, `run` and `log` commands follow the layout in
use. These are the only `autoresearch.*` names git treats as session files; any
other one at the root is committed and reverted like the project's own files.

## Config

`.auto/config.json` is an optional JSON object.

- `maxIterations` caps the runs in a segment. It must be a positive whole number,
  or `null` or absent for no limit. Any other value, such as `0`, a string or
  `2.5`, makes the config broken (see below). Once a segment has reached the cap,
  the loop stops, and `run`, `log` and `start` are refused. A new segment (`init`)
  starts the count again. If the limit is lowered below the runs already logged,
  the next resume stops the loop with the same reason.
- `workingDir` is an existing directory inside the checkout. The benchmark,
  checks and hooks run there. Git and the session files stay at the checkout
  root. A `workingDir` that does not exist is refused.
- A broken `config.json` is an error, not ignored. It is a file that is not a JSON
  object, or a `maxIterations` that is not a positive whole number. `run`, `log`,
  `init` and `start` are refused until it is fixed. `off`, `status`, `clear` and
  `export` still work. The panel shows the config error.

## Hooks

`.auto/hooks/after.sh` runs after each logged run. `before.sh` runs when `init`
sets up a session while the loop was not active, and after each logged run while
the loop stays active, to prime the next experiment. It does not run once the
loop has reached `maxIterations`. A missing hook file is skipped.

Each hook runs with `bash` in `cwd`, with a 30 s timeout. It gets a JSON payload
on stdin with `event`, `cwd`, `session`, and either `run_entry` (after) or
`next_run` and `last_run` (before). Its stdout and stderr together, capped at
8 KB, are returned in the tool result. A hook that fails, times out or cannot
start is reported in the tool result, and the logged run stands. The examples in
`skills/autoresearch-hooks/examples/` are ready to copy.

## Auto-resume

When an agent thread goes idle with an active loop, the plugin waits 0.8 s and
sends the agent a message to continue. Activity on the thread cancels the
pending resume. A thread that becomes active while the resume is being prepared
gets no message. Auto-resume starts only after a run has been logged in the
current plugin process, so after a restart or a Start it waits for the next
logged run. A resume still in its settle when the plugin reloads is re-armed by
the new process, if its thread is still idle then. The reload waits for the write
that stores the resume to finish, so the new process finds it. That resume was
decided before the reload, so the logged-run rule does not apply to it. It stops,
and the panel
shows why, when:

- 200 resumes have been sent since the last `init` or `start`
  (`AUTORESUME_TURN_LIMIT`), or
- more than 20 consecutive discards or crashes at the end of the current segment
  (`CONSECUTIVE_FAILURE_LIMIT`). The count runs over the trailing discard and
  crash runs. Any other status, including `checks_failed`, breaks the streak.

A broken `config.json` pauses auto-resume, and no message is sent. A stopped or
paused loop never resumes on its own.

A loop also stops, rather than pauses, when its checkout folder is gone, when the
thread now works in another checkout, or when its segment has reached
`maxIterations`. If the folder cannot be checked for another reason, the attempt is
logged and the next idle retries.

## Refusals

A refused command exits 1 from the CLI, or returns an error result from the
tool, with a hint. Nothing is recorded. Refusals cover:

- a `keep` after a failed benchmark or failing checks, or with no change outside
  the session files (the baseline excepted);
- a `log` whose secondary metrics are missing, or include one not tracked before
  (unless `--force`);
- a git step that failed;
- a `run`, `log` or `start` once the segment has reached `maxIterations`;
- `run`, `log`, `init`, `start` or `clear` while a benchmark is still running
  (see Caveats for the per-process limit);
- `init` or `start` on a working tree with changes outside the session files,
  untracked files included;
- a `--metric` or `--secondary` value that is not a number;
- a broken config (including a `maxIterations` that is not a positive whole
  number) or an unreadable `workingDir`;
- a custom `run` command while `.auto/measure.sh` exists.

## Skills

- `autoresearch-create` sets up a session: the goal, the metric, `prompt.md` and
  `measure.sh`.
- `autoresearch-finalize` turns the kept runs into clean, reviewable commits
  (`finalize.sh <groups.json>`).
- `autoresearch-hooks` writes before and after hooks.

## Behaviour notes

- **No approval gates.** Start, continue and finalize run without a confirmation
  step. `clear` is the one command that asks for confirmation: it needs `--yes`.
- `clear` deletes `.auto/log.jsonl` and turns the loop off. The other session
  files stay.
- `--commit` names the base commit. It defaults to HEAD. A discard, crash or
  `checks_failed` run logs it. A keep logs the commit it creates.
- Hook output goes back to the agent in the tool result.
- The baseline is the first run of a segment, whatever its status. "Best kept"
  counts only kept runs, so a baseline that is not a keep does not count as best.
- Confidence is the gap between the best kept run and the baseline, divided by
  the MAD of the segment's positive metrics.
- The panel shows the primary metric. Secondary metrics appear in the export only.

## Caveats

- Testing so far: real git repositories on local disk, a scripted harness, and a
  mocked BB SDK for remote hosts. Not yet run against a live BB server, a remote
  host, or the panel in BB.
- The owner-thread instructions come from `contributeInstructions`, which is
  synchronous. They are rebuilt after each change and on resume, but may go stale
  until the agent's session rebuilds, so every resume message carries the current
  state line.
- The idle/resume timer calls `bb.sdk` from a timer, and the reload re-arm calls
  `bb.sdk.threads.get` at plugin load. Both paths have only been exercised against
  a mocked host, and the reload's wait for pending writes has not been timed
  against a live reload.
- Remote paths: the terminal behaviour, the directory check (`pathsExist` does
  not document directories) and the panel's refresh cost are not checked against
  a real host.
- Remote loops depend on the BB server. The loop runtime, its timers and the
  auto-resume run in the plugin's server process. Each remote file, path,
  command and git step goes through `bb.sdk`. With the server down, a remote
  loop cannot be driven, resumed or controlled from the panel or the CLI.
- A `keep` is checked only against the last `run`, and a `log` clears that result.
  Nothing requires a `run` before each `log`.
- The "benchmark is running" and "log is being written" checks see only this
  plugin process. A `log` from the CLI in another process is not refused by a run
  in the panel's process.
- `workingDir` is checked lexically: `..` and absolute paths outside the checkout
  are refused, but a symlink inside the checkout that points outside is followed.
  It is not a security boundary.
- If the git step of a `keep` or a discard succeeds and the log append then fails,
  the change is committed or reverted with no log line. The tool's text says so;
  add the line by hand.
- Uncommitted edits, staged or not, and untracked files outside the session files
  are part of the experiment: a discard reverts them too. That is why `init` and
  `start` refuse a dirty tree.

## Development

```
npm install
npx tsc --noEmit -p tsconfig.json
bb plugin build .
bb plugin install . --yes
bb plugin reload
```

`bb plugin dev .` watches the sources, rebuilds and reloads on every change
(Ctrl+C to stop).

Sources: `server.ts` (backend, CLI, tools, events), `app.tsx` (the panel), `lib/`
(`loop.ts`, `git.ts`, `paths.ts`, `workspace.ts`, `hooks.ts`, `process.ts`,
`autoresume.ts`, `runtime.ts`, `session.ts`, `jsonl.ts`, `metrics.ts`,
`summary.ts`, `panel.ts`, `export.ts`, `refusal.ts`, `constants.ts`), `skills/`
(agent skills).
