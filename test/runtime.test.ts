import { describe, expect, test } from "bun:test";

import { type KvStore, LoopRuntime } from "../lib/runtime";

const REF = { hostId: null, workDir: "/repo" };

/** A store whose writes go through `write`; nothing is read back. */
function kvWith(write: () => Promise<void>): KvStore {
  return {
    get: async () => undefined,
    set: async () => write(),
    delete: async () => undefined,
    list: async () => [],
  };
}

describe("LoopRuntime.dispose", () => {
  test("gives up on a KV write that never settles, after flushTimeoutMs", async () => {
    const logs: string[] = [];
    const runtime = new LoopRuntime({
      kv: kvWith(() => new Promise<void>(() => {})),
      publish: () => {},
      log: (message) => logs.push(message),
      flushTimeoutMs: 50,
    });
    runtime.update(REF, { active: true });

    const started = Date.now();
    await runtime.dispose();

    expect(Date.now() - started).toBeLessThan(1000);
    expect(logs).toEqual(["1 KV write(s) still pending after 50 ms; not waiting for them."]);
  });

  test("waits for a write that settles in time, and logs nothing", async () => {
    const logs: string[] = [];
    let saved = false;
    const runtime = new LoopRuntime({
      kv: kvWith(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        saved = true;
      }),
      publish: () => {},
      log: (message) => logs.push(message),
      flushTimeoutMs: 1000,
    });
    runtime.update(REF, { active: true });

    await runtime.dispose();

    expect(saved).toBe(true);
    expect(logs).toEqual([]);
  });
});
