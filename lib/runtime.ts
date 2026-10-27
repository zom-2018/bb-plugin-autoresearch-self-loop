/**
 * Loop state per checkout. Records live in memory, are persisted to plugin KV so
 * a reload keeps the loop, and every change is announced on the realtime channel
 * so the panel refetches. Timers, transient counters and the owner note are not
 * persisted. A pending resume's start time is, so a reload can re-arm it.
 */
import type { CheckoutRef } from "./workspace";

export interface PendingChecks {
  pass: boolean;
  /** Last 500 characters of the checks output, quoted back when a keep is refused. */
  output: string;
  durationSeconds: number;
}

/**
 * How the last run_experiment ended, until its result is logged. A keep needs the
 * benchmark to have passed, and its checks too when they ran.
 */
export interface LastRun {
  benchmarkPassed: boolean;
  checks: PendingChecks | null;
}

export interface LoopRecord {
  /** Absolute path of the checkout on its host. */
  workDir: string;
  /** The bb host the checkout lives on; null for the primary host. */
  hostId: string | null;
  active: boolean;
  ownerThreadId: string | null;
  goal: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  /** Why the loop stopped (when inactive) or paused auto-resume (when active). */
  stopReason: string | null;
  autoResumeTurns: number;
  /**
   * When the owner's next resume was armed and has not fired or been cancelled, or null. A reload that lands
   * in the settle window re-arms it from here.
   */
  pendingResumeAt: string | null;
  /** The last run_experiment's result, or null when none is waiting to be logged. */
  lastRun: LastRun | null;
  updatedAt: string;
}

export interface RunningExperiment {
  startedAt: number;
  command: string;
}

export interface KvStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface RuntimeDeps {
  kv: KvStore;
  /** Tell open panels that the loop for this checkout changed. */
  publish(ref: CheckoutRef): void;
  log(message: string): void;
  /** How long dispose waits for KV writes in flight. Defaults to FLUSH_TIMEOUT_MS. */
  flushTimeoutMs?: number;
}

const KEY_PREFIX = "loop:";
/** The longest a reload waits for KV writes. A store that hangs must not hold up the reload. */
const FLUSH_TIMEOUT_MS = 5_000;

/**
 * A checkout's map key. The primary host keeps the bare path, so records from
 * before remote hosts existed still match; other hosts add their id, since the
 * same path can exist on two machines.
 */
export function checkoutKey(ref: CheckoutRef): string {
  return ref.hostId ? `@${ref.hostId}:${ref.workDir}` : ref.workDir;
}

function emptyRecord(ref: CheckoutRef): LoopRecord {
  return {
    workDir: ref.workDir,
    hostId: ref.hostId ?? null,
    active: false,
    ownerThreadId: null,
    goal: null,
    startedAt: null,
    stoppedAt: null,
    stopReason: null,
    autoResumeTurns: 0,
    pendingResumeAt: null,
    lastRun: null,
    updatedAt: new Date().toISOString(),
  };
}

export class LoopRuntime {
  private readonly records = new Map<string, LoopRecord>();
  private readonly running = new Map<string, RunningExperiment>();
  private readonly experiments = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly notes = new Map<string, string>();
  private readonly activations = new Map<string, number>();
  private readonly writes = new Set<Promise<unknown>>();

  constructor(private readonly deps: RuntimeDeps) {}

  /** Restore persisted records at plugin load. */
  async load(): Promise<void> {
    for (const listed of await this.deps.kv.list(KEY_PREFIX)) {
      // The store may return keys with or without the prefix; read by the full key either way.
      const key = listed.startsWith(KEY_PREFIX) ? listed : KEY_PREFIX + listed;
      const stored = await this.deps.kv.get<LoopRecord>(key);
      if (!stored) continue;
      // Records saved before lastRun existed carry the old pendingChecks field, which is dropped here.
      const record: LoopRecord = {
        ...stored,
        hostId: stored.hostId ?? null,
        lastRun: stored.lastRun ?? null,
        pendingResumeAt: stored.pendingResumeAt ?? null,
      };
      this.records.set(checkoutKey(record), record);
    }
  }

  get(ref: CheckoutRef): LoopRecord | null {
    return this.records.get(checkoutKey(ref)) ?? null;
  }

  /** Records whose loop is owned by this thread, active or not. */
  ownedBy(threadId: string): LoopRecord[] {
    return [...this.records.values()].filter((record) => record.ownerThreadId === threadId);
  }

  /** Records whose loop is running, on any host. */
  activeRecords(): LoopRecord[] {
    return [...this.records.values()].filter((record) => record.active);
  }

  /** Apply a patch, persist it, and announce the change. */
  update(ref: CheckoutRef, patch: Partial<Omit<LoopRecord, "workDir" | "hostId">>): LoopRecord {
    const key = checkoutKey(ref);
    const record = this.records.get(key) ?? emptyRecord(ref);
    const next: LoopRecord = {
      ...record,
      ...patch,
      workDir: ref.workDir,
      hostId: ref.hostId ?? null,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(key, next);
    this.persist(key, next);
    this.deps.publish(ref);
    return next;
  }

  remove(ref: CheckoutRef): void {
    const key = checkoutKey(ref);
    // Only the timer here: the record is deleted below, and a write now could bring it back.
    this.clearTimer(key);
    this.records.delete(key);
    this.experiments.delete(key);
    this.running.delete(key);
    this.notes.delete(key);
    this.track(
      this.deps.kv.delete(KEY_PREFIX + key).catch((err: unknown) => this.deps.log(`kv delete failed: ${String(err)}`)),
    );
    this.deps.publish(ref);
  }

  runningFor(ref: CheckoutRef): RunningExperiment | null {
    return this.running.get(checkoutKey(ref)) ?? null;
  }

  setRunning(ref: CheckoutRef, experiment: RunningExperiment | null): void {
    const key = checkoutKey(ref);
    if (experiment) this.running.set(key, experiment);
    else this.running.delete(key);
    this.deps.publish(ref);
  }

  experimentsThisSession(ref: CheckoutRef): number {
    return this.experiments.get(checkoutKey(ref)) ?? 0;
  }

  countExperiment(ref: CheckoutRef): void {
    this.experiments.set(checkoutKey(ref), this.experimentsThisSession(ref) + 1);
  }

  resetExperiments(ref: CheckoutRef): void {
    this.experiments.delete(checkoutKey(ref));
  }

  /** The owner-thread instructions for this loop, as of its last refresh. */
  noteFor(ref: CheckoutRef): string | null {
    return this.notes.get(checkoutKey(ref)) ?? null;
  }

  setNote(ref: CheckoutRef, note: string | null): void {
    const key = checkoutKey(ref);
    if (note === null) this.notes.delete(key);
    else this.notes.set(key, note);
  }

  /** Arm the owner's next resume. The arming is stored, so a reload can re-arm it. */
  scheduleAutoResume(ref: CheckoutRef, delayMs: number, fire: () => void): void {
    const key = checkoutKey(ref);
    this.clearTimer(key);
    this.setPendingResume(ref, new Date().toISOString());
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.setPendingResume(ref, null);
      fire();
    }, delayMs);
    this.timers.set(key, timer);
  }

  /** Cancel the owner's pending resume, in this process and in storage. */
  cancelAutoResume(ref: CheckoutRef): void {
    this.clearTimer(checkoutKey(ref));
    this.setPendingResume(ref, null);
  }

  /** Count a thread becoming active. A resume scheduled while it was idle compares the count before it sends. */
  noteThreadActive(threadId: string): void {
    this.activations.set(threadId, this.activationsOf(threadId) + 1);
  }

  activationsOf(threadId: string): number {
    return this.activations.get(threadId) ?? 0;
  }

  /**
   * At reload or shutdown: stops the timers, then waits for the KV writes in flight, so the next load sees them.
   * Stored resumes stay, so the next load re-arms them.
   */
  async dispose(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.flush();
  }

  /**
   * Wait until every KV write issued so far has settled, including any issued while waiting. Past the timeout the
   * wait ends and the writes still pending are logged, so a hung store cannot hold up a reload.
   */
  private async flush(): Promise<void> {
    const limitMs = this.deps.flushTimeoutMs ?? FLUSH_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), limitMs);
    });
    const settled = (async () => {
      while (this.writes.size > 0) await Promise.allSettled(this.writes);
      return false;
    })();
    try {
      if (await Promise.race([settled, timedOut])) {
        this.deps.log(`${this.writes.size} KV write(s) still pending after ${limitMs} ms; not waiting for them.`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(key);
  }

  /** Store when a resume was armed, or clear it. A record that does not exist is left alone, so this never recreates one. */
  private setPendingResume(ref: CheckoutRef, at: string | null): void {
    const record = this.records.get(checkoutKey(ref));
    if (!record || record.pendingResumeAt === at) return;
    this.update(ref, { pendingResumeAt: at });
  }

  private persist(key: string, record: LoopRecord): void {
    this.track(
      this.deps.kv.set(KEY_PREFIX + key, record).catch((err: unknown) => {
        this.deps.log(`kv set failed: ${String(err)}`);
      }),
    );
  }

  /** Keep a KV write so dispose can wait for it. A settled write leaves the set, so a long-lived process does not grow it. */
  private track(write: Promise<unknown>): void {
    this.writes.add(write);
    const settle = (): void => {
      this.writes.delete(write);
    };
    void write.then(settle, settle);
  }
}
