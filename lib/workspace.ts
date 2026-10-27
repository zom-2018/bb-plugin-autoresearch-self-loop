/**
 * Where a checkout lives and how the loop reaches it. The primary bb host runs
 * this plugin, so its checkouts are read and written on disk. Any other host is
 * reached through the SDK: `files` for reads, writes and folder listings,
 * `hosts.pathsExist` for existence, and a terminal running argv for commands. The
 * loop only sees the `Workspace` surface, so both run the same code. A POSIX host
 * needs `sh` and `bash`; a Windows host needs Windows PowerShell and `git` (see
 * lib/shell.ts for the argv each shell takes). A path's existence and kind need only
 * the SDK, so status also works on a Windows host.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { type CaptureResult, captureCommand } from "./process";
import { type Shell, shellOf } from "./shell";

/**
 * Large enough that METRIC lines from a normal benchmark are never cut off before parsing.
 * The host refuses a larger tailBytes with HTTP 400 "Too big", so this is its maximum.
 */
const TAIL_BYTES = 4 * 1024 * 1024;
const POLL_MS = 250;
/** Entries of a remote folder's listing read when a path's kind is looked up. */
const LISTING_LIMIT = 100;
const TERMINAL_COLS = 200;
const TERMINAL_ROWS = 50;

/** Colour, cursor and title codes that a terminal (PTY) stream carries. */
const TERMINAL_ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

export type ExecResult = CaptureResult;

export interface ExecOptions {
  /** Program and arguments, run directly. A shell is the program when a command needs one (see lib/shell.ts). */
  argv: string[];
  cwd: string;
  /** 0 means no limit. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Where the output is written. Local runs stream the full output as it arrives; remote runs write the captured tail when the command ends. */
  logPath?: string;
}

export interface Workspace {
  /** The bb host the checkout lives on, or null for the primary host. */
  readonly hostId: string | null;
  /** Existence for several paths in one call. */
  existence(filePaths: string[]): Promise<Record<string, boolean>>;
  exists(filePath: string): Promise<boolean>;
  isDirectory(filePath: string): Promise<boolean>;
  /** A regular file, following symlinks. */
  isFile(filePath: string): Promise<boolean>;
  /** The file's text, or null when it does not exist. */
  readText(filePath: string): Promise<string | null>;
  /** Writes the whole file, creating parent directories. */
  writeText(filePath: string, text: string): Promise<void>;
  appendText(filePath: string, text: string): Promise<void>;
  /** Removes a file. A missing file is not an error. */
  remove(filePath: string): Promise<void>;
  exec(options: ExecOptions): Promise<ExecResult>;
}

/** A checkout's identity: the host it lives on and the absolute path of its root there. The runtime keys records by it. */
export interface CheckoutRef {
  readonly hostId: string | null;
  readonly workDir: string;
}

/**
 * A checkout: its workspace, its root (`workDir`, where git and the session files
 * are), and the directory the benchmark, checks and hooks run in (`runDir`: the
 * root, or `workingDir` from config). `shell` is the one its commands and scripts run in.
 */
export interface Checkout extends CheckoutRef {
  readonly ws: Workspace;
  readonly runDir: string;
  readonly shell: Shell;
}

/** A checkout for messages: its path, and its host when that is not the primary. */
export function checkoutLabel(ref: CheckoutRef): string {
  return ref.hostId ? `${ref.workDir} on host ${ref.hostId}` : ref.workDir;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** A path that does not exist, or whose parent is a file: either way it is not a directory. */
function isNotDirectory(err: unknown): boolean {
  return isNotFound(err) || (err as NodeJS.ErrnoException | undefined)?.code === "ENOTDIR";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function cleanTerminalText(text: string): string {
  return text.replace(TERMINAL_ESCAPES, "").replace(/\r\n?/g, "\n");
}

function failedRun(startedAt: number, spawnError: string): ExecResult {
  return {
    exitCode: null,
    timedOut: false,
    aborted: false,
    spawnError,
    output: "",
    totalBytes: 0,
    durationMs: Date.now() - startedAt,
  };
}

/** The primary host: the plugin's own disk and processes. */
export class LocalWorkspace implements Workspace {
  readonly hostId = null;

  async existence(filePaths: string[]): Promise<Record<string, boolean>> {
    return Object.fromEntries(filePaths.map((filePath) => [filePath, fs.existsSync(filePath)]));
  }

  async exists(filePath: string): Promise<boolean> {
    return fs.existsSync(filePath);
  }

  async isDirectory(filePath: string): Promise<boolean> {
    try {
      return (await fs.promises.stat(filePath)).isDirectory();
    } catch (err) {
      // Permissions or I/O are an error, not "missing": a caller that acts on "missing" would act on a guess.
      if (isNotDirectory(err)) return false;
      throw err;
    }
  }

  async isFile(filePath: string): Promise<boolean> {
    try {
      return (await fs.promises.stat(filePath)).isFile();
    } catch {
      return false;
    }
  }

  async readText(filePath: string): Promise<string | null> {
    try {
      return await fs.promises.readFile(filePath, "utf-8");
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async writeText(filePath: string, text: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, text);
  }

  async appendText(filePath: string, text: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.appendFile(filePath, text);
  }

  async remove(filePath: string): Promise<void> {
    await fs.promises.rm(filePath, { force: true });
  }

  async exec(options: ExecOptions): Promise<ExecResult> {
    if (options.logPath) await fs.promises.mkdir(path.dirname(options.logPath), { recursive: true });
    return captureCommand(options.argv[0], options.argv.slice(1), {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      logPath: options.logPath,
    });
  }
}

/**
 * Another bb host, reached through the SDK. Commands run in a terminal scoped to
 * the host and the checkout's directory, and their output is read back when they end.
 */
export class RemoteWorkspace implements Workspace {
  /** `root` is the checkout's path on the host; commands run from there. */
  constructor(
    private readonly sdk: BbPluginApi["sdk"],
    readonly hostId: string,
    private readonly root: string,
  ) {}

  async existence(filePaths: string[]): Promise<Record<string, boolean>> {
    if (filePaths.length === 0) return {};
    const { existence } = await this.sdk.hosts.pathsExist({ hostId: this.hostId, paths: filePaths });
    // A path the host did not answer for is unknown, not missing. A caller that writes on "missing" would overwrite the file.
    for (const filePath of filePaths) {
      if (typeof existence[filePath] !== "boolean") {
        throw new Error(`Host ${this.hostId} did not report whether ${filePath} exists.`);
      }
    }
    return existence;
  }

  async exists(filePath: string): Promise<boolean> {
    return (await this.existence([filePath]))[filePath] === true;
  }

  async isDirectory(filePath: string): Promise<boolean> {
    return (await this.kindOf(filePath)) === "directory";
  }

  async isFile(filePath: string): Promise<boolean> {
    return (await this.kindOf(filePath)) === "file";
  }

  /**
   * What the host has at a path: a directory, a file, or null when nothing is there.
   * The host lists the folder that holds the path, with each entry's kind, so no shell
   * runs there. A `test` probe would need `sh`, and a host without it (Windows
   * PowerShell) exits 1 for an unknown command, the same as a "no".
   */
  private async kindOf(filePath: string): Promise<"directory" | "file" | null> {
    if (!(await this.exists(filePath))) return null;
    // path.win32 takes `/` and `\` alike, so one split serves a Windows host and a POSIX one.
    const name = path.win32.basename(filePath);
    if (name === "") return "directory"; // a filesystem root
    const listing = await this.sdk.files.listPaths({
      hostId: this.hostId,
      path: path.win32.dirname(filePath),
      query: name,
      limit: LISTING_LIMIT,
      includeFiles: true,
      includeDirectories: true,
      includeHidden: true,
    });
    const entry = listing.paths.find((candidate) => candidate.name === name);
    if (entry) return entry.kind;
    // The host reported the path exists, so a listing without it is unknown, not missing.
    throw new Error(`Host ${this.hostId} has ${filePath}, but its folder listing does not show it.`);
  }

  async readText(filePath: string): Promise<string | null> {
    if (!(await this.exists(filePath))) return null;
    const file = await this.sdk.files.read({ hostId: this.hostId, path: filePath });
    const bytes = Buffer.from(file.content, file.contentEncoding === "base64" ? "base64" : "utf-8");
    // The read has no truncation flag. A short body would drop log lines without an error, so it is refused.
    if (bytes.length !== file.sizeBytes) {
      throw new Error(`Reading ${filePath} on the host returned ${bytes.length} of ${file.sizeBytes} bytes.`);
    }
    return bytes.toString("utf-8");
  }

  async writeText(filePath: string, text: string): Promise<void> {
    await this.sdk.files.write({
      hostId: this.hostId,
      path: filePath,
      content: text,
      contentEncoding: "utf8",
      createParents: true,
    });
  }

  async appendText(filePath: string, text: string): Promise<void> {
    // Read-modify-write: two processes appending at once can lose a line. Calls in one process are serialised by the loop.
    await this.writeText(filePath, ((await this.readText(filePath)) ?? "") + text);
  }

  async remove(filePath: string): Promise<void> {
    if (!(await this.exists(filePath))) return;
    await this.sdk.files.remove({ hostId: this.hostId, path: filePath });
  }

  async exec(options: ExecOptions): Promise<ExecResult> {
    const result = await this.runInTerminal(options.argv, options);
    if (options.logPath) await this.writeText(options.logPath, result.output);
    return result;
  }

  private async runInTerminal(argv: string[], options: ExecOptions): Promise<ExecResult> {
    const startedAt = Date.now();
    const created = await this.sdk.terminals
      .create({
        cols: TERMINAL_COLS,
        rows: TERMINAL_ROWS,
        scope: { kind: "host_path", hostId: this.hostId, cwd: options.cwd },
        start: { mode: "argv", argv },
        title: "autoresearch",
      })
      .then(
        (session) => ({ session }),
        (err: unknown) => ({ error: errorText(err) }),
      );
    if ("error" in created) return failedRun(startedAt, created.error);

    const terminalId = created.session.id;
    let session = created.session;
    try {
      const deadline = options.timeoutMs > 0 ? startedAt + options.timeoutMs : Number.POSITIVE_INFINITY;
      let timedOut = false;
      let aborted = false;
      while (session.status === "starting" || session.status === "running") {
        if (options.signal?.aborted) {
          aborted = true;
          break;
        }
        if (Date.now() >= deadline) {
          timedOut = true;
          break;
        }
        await sleep(POLL_MS);
        session = await this.sdk.terminals.get({ terminalId });
      }

      const body = await this.sdk.terminals.output({ terminalId, tailBytes: TAIL_BYTES });
      const bytes = Buffer.concat(body.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")));
      let text = bytes.toString("utf-8");
      // A tail cut can land mid-line; drop the partial first line, as the local run does.
      if (body.truncated) text = text.slice(text.indexOf("\n") + 1);
      return {
        exitCode: timedOut || aborted ? null : (body.exitCode ?? session.exitCode),
        timedOut,
        aborted,
        spawnError: session.status === "disconnected" ? "The terminal lost its connection to the host." : null,
        output: cleanTerminalText(text),
        totalBytes: bytes.length,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      // Force-closing also stops a command that is still running (a timeout or an abort).
      await this.sdk.terminals.close({ terminalId, mode: "force" }).catch(() => undefined);
    }
  }
}

const LOCAL = new LocalWorkspace();

/**
 * Rebuilds a checkout from its record: the local disk for the primary host, otherwise the SDK.
 * The run directory starts at the root; `resolveRunDir` moves it to `workingDir`.
 */
export function openCheckout(sdk: BbPluginApi["sdk"], ref: CheckoutRef): Checkout {
  const ws = ref.hostId ? new RemoteWorkspace(sdk, ref.hostId, ref.workDir) : LOCAL;
  return { hostId: ref.hostId ?? null, workDir: ref.workDir, runDir: ref.workDir, ws, shell: shellOf(ref.workDir) };
}

/**
 * Appends one JSON line, such as a log entry. A file whose last line was cut short
 * (no newline at the end) gets a line break first, so the new entry is not glued to it.
 */
export async function appendJsonLine(co: Checkout, file: string, entry: unknown): Promise<void> {
  const current = (await co.ws.readText(file)) ?? "";
  const separator = current !== "" && !current.endsWith("\n") ? "\n" : "";
  await co.ws.appendText(file, `${separator}${JSON.stringify(entry)}\n`);
}
