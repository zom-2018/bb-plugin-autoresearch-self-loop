/**
 * The shell a checkout's commands run in. A POSIX host runs `bash` and `sh`. A
 * Windows host has no `sh`: its commands run in Windows PowerShell, and its session
 * scripts are `.ps1`. The checkout's path says which, since a drive letter or a UNC
 * share only exists on Windows.
 */
import * as path from "node:path";

export type Shell = "posix" | "powershell";

const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** The shell for a checkout at this path. */
export function shellOf(workDir: string): Shell {
  return WINDOWS_PATH.test(workDir) ? "powershell" : "posix";
}

/** The path module that reads a checkout's paths: `path.win32` takes `\` and `/` alike. */
export function pathsFor(workDir: string): typeof path.posix {
  return shellOf(workDir) === "powershell" ? path.win32 : path.posix;
}

export function scriptExtension(shell: Shell): string {
  return shell === "powershell" ? ".ps1" : ".sh";
}

/** Windows PowerShell 5.1 comes with every Windows host, and `-EncodedCommand` passes a script with no quoting. */
const POWERSHELL = "powershell.exe";
const POWERSHELL_FLAGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];

/** Native tools print UTF-8. Setting the console encoding can fail with no console, so a failure is skipped. */
const UTF8_OUTPUT = "try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}\n";

/**
 * Ends the script with the exit code of its last native command, or 1 when the last command failed.
 * Without it a script ending in a failing native tool would exit 0.
 */
const EXIT_LAST = "\nif ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 }";

/** A PowerShell single-quoted string. Nothing inside expands, and each quote, straight or curly, is doubled. */
export function psQuote(text: string): string {
  return `'${text.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`;
}

/**
 * The argv that runs a command line in the checkout's shell. POSIX gets `bash -c`. A
 * Windows host gets PowerShell with the script base64-encoded, so no quoting of the
 * command reaches the terminal, which hands argv to PowerShell itself.
 */
export function commandArgv(shell: Shell, command: string): string[] {
  if (shell === "posix") return ["bash", "-c", command];
  const script = UTF8_OUTPUT + command + EXIT_LAST;
  return [POWERSHELL, ...POWERSHELL_FLAGS, "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

/**
 * The argv that runs a session script (checks, measure, a hook). A hook passes the
 * file at `stdinPath` to the script on its stdin, which is how a hook receives its
 * JSON payload. A file is used because a remote terminal has no stdin of its own.
 */
export function scriptArgv(shell: Shell, scriptPath: string, stdinPath?: string): string[] {
  if (shell === "posix") {
    if (stdinPath === undefined) return ["bash", scriptPath];
    return ["bash", "-c", 'bash "$1" < "$2"', "bash", scriptPath, stdinPath];
  }
  const run = `& ${psQuote(scriptPath)}`;
  if (stdinPath === undefined) return commandArgv(shell, run);
  // The payload is one string, which the script reads from `$input`.
  return commandArgv(shell, `[IO.File]::ReadAllText(${psQuote(stdinPath)}, [System.Text.Encoding]::UTF8) | ${run}`);
}
