import { describe, expect, test } from "bun:test";

import { isMeasureCommand } from "../lib/metrics";

describe("isMeasureCommand on a POSIX checkout", () => {
  test("accepts the measure script, with bash, a path prefix, a wrapper or 2>&1", () => {
    expect(isMeasureCommand("bash .auto/measure.sh", "posix")).toBe(true);
    expect(isMeasureCommand("./.auto/measure.sh", "posix")).toBe(true);
    expect(isMeasureCommand("time bash autoresearch.sh 2>&1", "posix")).toBe(true);
  });

  test("refuses anything that could run more than the script", () => {
    expect(isMeasureCommand("bash .auto/measure.sh && echo done", "posix")).toBe(false);
    expect(isMeasureCommand("bash .auto/measure.sh; rm x", "posix")).toBe(false);
    expect(isMeasureCommand("cat .auto/measure.sh", "posix")).toBe(false);
  });
});

describe("isMeasureCommand on a PowerShell checkout", () => {
  test("accepts the measure script by its .ps1 path, with either separator", () => {
    expect(isMeasureCommand("./.auto/measure.ps1", "powershell")).toBe(true);
    expect(isMeasureCommand(".\\.auto\\measure.ps1", "powershell")).toBe(true);
    expect(isMeasureCommand("& ./.auto/measure.ps1 2>&1", "powershell")).toBe(true);
    expect(isMeasureCommand("autoresearch.ps1", "powershell")).toBe(true);
  });

  test("refuses anything that could run more than the script", () => {
    expect(isMeasureCommand("./.auto/measure.ps1; Remove-Item x", "powershell")).toBe(false);
    expect(isMeasureCommand("./.auto/measure.ps1 && echo done", "powershell")).toBe(false);
    expect(isMeasureCommand("./.auto/measure.sh", "powershell")).toBe(false);
  });
});
