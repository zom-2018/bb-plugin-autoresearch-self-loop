import { describe, expect, test } from "bun:test";

import { commandArgv, pathsFor, psQuote, scriptArgv, scriptExtension, shellOf } from "../lib/shell";

/** The PowerShell script an argv runs, decoded from `-EncodedCommand`. */
function decoded(argv: string[]): string {
  const i = argv.indexOf("-EncodedCommand");
  return Buffer.from(argv[i + 1], "base64").toString("utf16le");
}

describe("shellOf", () => {
  test("drive letters and UNC paths are PowerShell checkouts", () => {
    expect(shellOf("C:\\Users\\me\\repo")).toBe("powershell");
    expect(shellOf("d:/work/repo")).toBe("powershell");
    expect(shellOf("\\\\server\\share\\repo")).toBe("powershell");
  });

  test("everything else is POSIX", () => {
    expect(shellOf("/home/me/repo")).toBe("posix");
    expect(shellOf("~/repo")).toBe("posix");
  });
});

describe("pathsFor", () => {
  test("joins with backslashes on Windows and slashes elsewhere", () => {
    expect(pathsFor("C:\\repo").join("C:\\repo", ".auto", "checks.ps1")).toBe("C:\\repo\\.auto\\checks.ps1");
    expect(pathsFor("/repo").join("/repo", ".auto", "checks.sh")).toBe("/repo/.auto/checks.sh");
  });
});

describe("scriptExtension", () => {
  test("follows the shell", () => {
    expect(scriptExtension("posix")).toBe(".sh");
    expect(scriptExtension("powershell")).toBe(".ps1");
  });
});

describe("psQuote", () => {
  test("wraps in single quotes and doubles embedded quotes, curly ones included", () => {
    expect(psQuote("C:\\repo\\it's")).toBe("'C:\\repo\\it''s'");
    expect(psQuote("a\u2018b\u2019c")).toBe("'a\u2018\u2018b\u2019\u2019c'");
  });
});

describe("commandArgv", () => {
  test("POSIX runs the line in bash", () => {
    expect(commandArgv("posix", "echo hi")).toEqual(["bash", "-c", "echo hi"]);
  });

  test("PowerShell sets UTF-8 output first and passes the exit code on", () => {
    const argv = commandArgv("powershell", "git status");
    expect(argv.slice(0, 5)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
    const script = decoded(argv);
    expect(script.startsWith("try { [Console]::OutputEncoding")).toBe(true);
    expect(script).toContain("git status");
    expect(script.endsWith("\nif ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 }")).toBe(true);
  });

  test("the line reaches PowerShell unchanged, quotes and all", () => {
    const line = "Write-Output \"it's $HOME\"";
    expect(decoded(commandArgv("powershell", line))).toContain(line);
  });
});

describe("scriptArgv", () => {
  test("POSIX runs the script with bash and feeds stdin from its file", () => {
    expect(scriptArgv("posix", "/r/.auto/checks.sh")).toEqual(["bash", "/r/.auto/checks.sh"]);
    expect(scriptArgv("posix", "/r/.auto/hooks/before.sh", "/r/.auto/.stdin-1")).toEqual([
      "bash",
      "-c",
      'bash "$1" < "$2"',
      "bash",
      "/r/.auto/hooks/before.sh",
      "/r/.auto/.stdin-1",
    ]);
  });

  test("PowerShell calls the script by its quoted path", () => {
    expect(decoded(scriptArgv("powershell", "C:\\repo\\.auto\\checks.ps1"))).toContain("& 'C:\\repo\\.auto\\checks.ps1'");
  });

  test("PowerShell pipes the stdin file into the script", () => {
    const script = decoded(scriptArgv("powershell", "C:\\repo\\.auto\\hooks\\before.ps1", "C:\\repo\\.auto\\.stdin-1"));
    expect(script).toContain(
      "[IO.File]::ReadAllText('C:\\repo\\.auto\\.stdin-1', [System.Text.Encoding]::UTF8) | & 'C:\\repo\\.auto\\hooks\\before.ps1'",
    );
  });

  test("an apostrophe in the path stays inside one quoted argument", () => {
    expect(decoded(scriptArgv("powershell", "C:\\Men's\\x.ps1"))).toContain("& 'C:\\Men''s\\x.ps1'");
  });
});
