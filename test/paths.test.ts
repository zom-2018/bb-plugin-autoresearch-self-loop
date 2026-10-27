import { describe, expect, test } from "bun:test";

import { readablePath, resolveRunDir, sessionPaths } from "../lib/paths";
import { Refusal } from "../lib/refusal";
import type { Checkout } from "../lib/workspace";

/**
 * A checkout backed by a fixed set of existing paths. The config file reads as `config`;
 * any path in `files` also counts as an existing directory.
 */
function fakeCheckout(workDir: string, shell: "posix" | "powershell", files: string[] = [], config?: string): Checkout {
  const present = new Set(files);
  const ws = {
    hostId: null,
    existence: async (paths: string[]) => Object.fromEntries(paths.map((p) => [p, present.has(p)])),
    isDirectory: async (p: string) => present.has(p),
    isFile: async (p: string) => present.has(p),
    readText: async (p: string) => (p.endsWith("config.json") ? (config ?? null) : null),
  };
  return { hostId: null, workDir, runDir: workDir, ws, shell } as unknown as Checkout;
}

describe("sessionPaths", () => {
  test("a PowerShell checkout gets .ps1 scripts under .auto", async () => {
    const paths = await sessionPaths(fakeCheckout("C:\\repo", "powershell"));
    expect(paths.file.checks).toBe("C:\\repo\\.auto\\checks.ps1");
    expect(paths.file.measure).toBe("C:\\repo\\.auto\\measure.ps1");
    expect(paths.hook.before).toBe("C:\\repo\\.auto\\hooks\\before.ps1");
    expect(paths.runLog).toBe("C:\\repo\\.auto\\run.log");
  });

  test("a POSIX checkout keeps .sh", async () => {
    const paths = await sessionPaths(fakeCheckout("/repo", "posix"));
    expect(paths.file.checks).toBe("/repo/.auto/checks.sh");
    expect(paths.hook.after).toBe("/repo/.auto/hooks/after.sh");
  });

  test("a legacy PowerShell checks script is still used while it is the only one", async () => {
    const legacy = "C:\\repo\\autoresearch.checks.ps1";
    const paths = await sessionPaths(fakeCheckout("C:\\repo", "powershell", [legacy]));
    expect(paths.file.checks).toBe(legacy);
  });

  test("once .auto holds a session file, legacy files are ignored", async () => {
    const paths = await sessionPaths(fakeCheckout("/repo", "posix", ["/repo/.auto/log.jsonl", "/repo/autoresearch.checks.sh"]));
    expect(paths.file.checks).toBe("/repo/.auto/checks.sh");
  });
});

describe("resolveRunDir", () => {
  test("workingDir on a Windows checkout resolves with backslashes", async () => {
    const root = fakeCheckout("C:\\repo", "powershell", ["C:\\repo\\sub\\dir"], JSON.stringify({ workingDir: "sub/dir" }));
    expect((await resolveRunDir(root)).runDir).toBe("C:\\repo\\sub\\dir");
  });

  test("a workingDir that climbs out of a Windows checkout is refused", async () => {
    const root = fakeCheckout("C:\\repo", "powershell", [], JSON.stringify({ workingDir: "..\\other" }));
    await expect(resolveRunDir(root)).rejects.toBeInstanceOf(Refusal);
  });

  test("no workingDir keeps the checkout root", async () => {
    const root = fakeCheckout("/repo", "posix");
    expect((await resolveRunDir(root)).runDir).toBe("/repo");
  });
});

describe("readablePath", () => {
  test("shows a path under a Windows checkout relative to it", () => {
    expect(readablePath("C:\\repo", "C:\\repo\\.auto\\log.jsonl")).toBe(".auto\\log.jsonl");
  });

  test("shows a path under a POSIX checkout relative to it", () => {
    expect(readablePath("/repo", "/repo/.auto/log.jsonl")).toBe(".auto/log.jsonl");
  });

  test("keeps a path outside the checkout as given", () => {
    expect(readablePath("C:\\repo", "D:\\other\\x.txt")).toBe("D:\\other\\x.txt");
  });
});
