/**
 * Runs one experiment or checks command in its own process group, so a timeout
 * or an abort takes the whole tree with it. Output is captured as a tail; the
 * full stream can be written to a log file as it arrives.
 *
 * A run settles when the child has exited and its output has drained, or when a
 * kill's deadline passes. A child that left the process group can hold the pipes
 * open, so waiting for `close` alone could wait forever.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";

/** Large enough that METRIC lines from a normal benchmark are never cut off before parsing. */
const TAIL_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;
/** How long to keep reading after the child exits, for output still in the pipes. */
const DRAIN_MS = 500;
/** The longest a killed run waits for its SIGKILL and the drain after it. */
const KILL_DEADLINE_MS = KILL_GRACE_MS + 2 * DRAIN_MS;

export interface CaptureOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** When set, the full combined output is written here as it streams. */
  logPath?: string;
}

export interface CaptureResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError: string | null;
  /** The last 8 MB of combined stdout and stderr. */
  output: string;
  totalBytes: number;
  durationMs: number;
}

/** Signal the process group led by `pid`. Each run is spawned detached, so it leads its own group. */
export function killTree(pid: number): void {
  const signal = (target: number, sig: NodeJS.Signals) => {
    try {
      process.kill(target, sig);
    } catch {
      // Already gone.
    }
  };
  signal(-pid, "SIGTERM");
  const force = setTimeout(() => signal(-pid, "SIGKILL"), KILL_GRACE_MS);
  force.unref();
}

export function captureCommand(file: string, args: string[], opts: CaptureOptions): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(file, args, {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logStream = opts.logPath ? fs.createWriteStream(opts.logPath) : null;
    // A log that cannot be written must not fail the run; the output is still kept in memory.
    logStream?.on("error", () => undefined);

    const tail: Buffer[] = [];
    let tailBytes = 0;
    let totalBytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    const onData = (chunk: Buffer) => {
      // Output after the run settled is not kept: the log stream is closed by then.
      if (settled) return;
      totalBytes += chunk.length;
      logStream?.write(chunk);
      tail.push(chunk);
      tailBytes += chunk.length;
      while (tailBytes > TAIL_BYTES && tail.length > 1) tailBytes -= tail.shift()!.length;
    };
    // Both streams are piped above; the optional chain is for the type, which cannot see that.
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const finish = (exitCode: number | null, spawnError: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(drain);
      clearTimeout(deadline);
      opts.signal?.removeEventListener("abort", onAbort);
      // Stop reading: a child that left the group can keep the pipes open.
      child.stdout?.destroy();
      child.stderr?.destroy();
      logStream?.end();
      let output = Buffer.concat(tail).toString("utf-8");
      // A cut at the start of the tail can land mid-line; drop the partial first line.
      if (totalBytes > TAIL_BYTES) output = output.slice(output.indexOf("\n") + 1);
      resolve({ exitCode, timedOut, aborted, spawnError, output, totalBytes, durationMs: Date.now() - t0 });
    };

    // A kill takes the group down. The deadline settles the run even if the pipes stay open.
    const stop = () => {
      if (child.pid) killTree(child.pid);
      if (!deadline) deadline = setTimeout(() => finish(null, null), KILL_DEADLINE_MS);
    };
    if (opts.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, opts.timeoutMs);
    }
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => finish(null, err.message));
    child.on("exit", (code) => {
      // Output can still be in the pipes after exit. Read for a moment, then settle. Whatever still
      // holds the pipes was started by the run, so its process group goes too.
      if (settled || drain) return;
      drain = setTimeout(() => {
        if (child.pid) killTree(child.pid);
        finish(code, null);
      }, DRAIN_MS);
    });
    child.on("close", (code) => finish(code, null));
  });
}
