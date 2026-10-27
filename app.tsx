// The Autoresearch panel: one tab in the thread's right panel, opened from the
// panel's launcher. It shows the loop and the session's primary numbers, and holds
// Start, Stop, Finalize and Export. Everything it shows is read through the `state`
// RPC; the realtime channel tells it when the log or the loop changed.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";

import type { autoresearchContract } from "./server";
import { formatNum } from "./lib/metrics";
import type { PanelRun, PanelState } from "./lib/panel";

const CHANNEL = "self-loop-changed";

type Action = "start" | "stop" | "finalize" | "export";

const muted: CSSProperties = { color: "var(--muted-foreground)", fontSize: 12 };
const cell: CSSProperties = { padding: "4px 6px", borderTop: "1px solid var(--border)", textAlign: "left", verticalAlign: "top" };
const box: CSSProperties = { border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", background: "var(--card)" };
const input: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--card)",
  color: "var(--foreground)",
  font: "inherit",
};

function button(primary: boolean): CSSProperties {
  return {
    padding: "6px 12px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: primary ? "var(--primary)" : "var(--card)",
    color: primary ? "var(--card)" : "var(--foreground)",
    font: "inherit",
    cursor: "pointer",
  };
}

function signed(pct: number): string {
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function loopStatus(state: PanelState): { label: string; detail: string | null } {
  const loop = state.loop;
  if (!loop) return { label: "Off", detail: null };
  if (loop.running) return { label: "Running", detail: loop.running.command };
  if (!loop.active) return { label: "Stopped", detail: loop.stopReason };
  if (loop.stopReason) return { label: "Paused", detail: loop.stopReason };
  return { label: "Active", detail: loop.ownedByThread ? null : "Owned by another thread" };
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={box}>
      <div style={muted}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{value}</div>
      {note && <div style={muted}>{note}</div>}
    </div>
  );
}

function RunRow({ run, unit }: { run: PanelRun; unit: string }) {
  const kept = run.status === "keep";
  return (
    <tr
      style={{
        background: kept ? "color-mix(in srgb, var(--primary) 12%, transparent)" : undefined,
        color: kept ? "var(--foreground)" : "var(--muted-foreground)",
      }}
    >
      <td style={cell}>{run.run}</td>
      <td style={cell}>{run.status}</td>
      <td style={cell}>{formatNum(run.metric, unit)}</td>
      <td style={cell}>{run.deltaPct === null ? "—" : signed(run.deltaPct)}</td>
      <td style={cell}>{run.description}</td>
    </tr>
  );
}

function Message({ children }: { children: ReactNode }) {
  return <div style={{ ...muted, fontSize: 13, padding: 8 }}>{children}</div>;
}

function AutoresearchPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof autoresearchContract>();
  const connection = useRealtimeConnectionState();
  const [state, setState] = useState<PanelState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [goal, setGoal] = useState("");
  const [exportedTo, setExportedTo] = useState<string | null>(null);
  // The async callbacks below can outlive the render that created them, so they read the
  // current thread and the newest request through refs.
  const threadRef = useRef(threadId);
  threadRef.current = threadId;
  const latest = useRef(0);
  const connected = useRef(connection === "connected");

  const refresh = () => {
    const seq = ++latest.current;
    return rpc.call("state", { threadId: threadRef.current }).then(
      (next) => {
        if (seq !== latest.current) return;
        setState(next);
        setLoadError(null);
      },
      (err: Error) => {
        if (seq === latest.current) setLoadError(err.message);
      },
    );
  };

  useEffect(() => {
    setState(null);
    setExportedTo(null);
    void refresh();
  }, [threadId]);
  useRealtime(CHANNEL, () => {
    void refresh();
  });
  // Realtime signals are ephemeral, so read the state again after a reconnect.
  useEffect(() => {
    if (connection !== "connected") connected.current = false;
    else if (!connected.current) {
      connected.current = true;
      void refresh();
    }
  }, [connection]);

  const act = <T,>(name: Action, call: () => Promise<T>, done: (value: T) => void) => {
    const forThread = threadId;
    setPending(name);
    setActionError(null);
    call()
      .then(
        (value) => {
          if (threadRef.current !== forThread) return;
          // A refresh that started before this result is older than it.
          latest.current++;
          done(value);
        },
        (err: Error) => {
          if (threadRef.current === forThread) setActionError(err.message);
        },
      )
      .finally(() => setPending(null));
  };

  // Defined before the early returns: a loop whose checkout cannot be read still gets its Stop.
  const stop = () => act("stop", () => rpc.call("stop", { threadId }), setState);

  if (!state) return <Message>{loadError ?? "Loading…"}</Message>;
  if (state.unavailable) {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <Message>{state.unavailable}</Message>
        {actionError && <Message>{actionError}</Message>}
        {state.loop?.active === true && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <button style={button(false)} onClick={stop} disabled={pending !== null}>
              Stop
            </button>
          </div>
        )}
      </div>
    );
  }

  const unit = state.metricUnit;
  const base = state.baseline;
  const best = state.best;
  const status = loopStatus(state);
  const error = actionError ?? loadError;
  const checksFailed = state.loop?.pendingChecks?.pass === false;

  const start = () =>
    act(
      "start",
      () => rpc.call("start", { threadId, goal: goal.trim() || undefined }),
      (next) => {
        setState(next);
        setGoal("");
      },
    );
  const finalize = () => act("finalize", () => rpc.call("finalize", { threadId }), setState);
  const exportHtml = () => act("export", () => rpc.call("export", { threadId }), (r) => setExportedTo(r.path));

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <strong>{state.name ?? "Autoresearch Self Loop"}</strong>
          <span style={{ ...box, padding: "1px 8px", fontSize: 12 }}>{status.label}</span>
        </div>
        <div style={muted}>
          {state.hasConfig
            ? `${state.metricName} (${unit || "unitless"}), ${state.direction} is better · segment ${state.segment}`
            : "No session yet. Give a goal and start."}
        </div>
        {status.detail && <div style={muted}>{status.detail}</div>}
      </div>

      {state.hasConfig && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            <Stat label="Baseline" value={base ? formatNum(base.value, unit) : "—"} note={base ? `run #${base.run}` : undefined} />
            <Stat
              label="Best kept"
              value={best ? formatNum(best.value, unit) : "—"}
              note={best && base && base.value !== 0 ? `${signed(((best.value - base.value) / base.value) * 100)} vs baseline` : undefined}
            />
            <Stat label="Confidence" value={state.confidence !== null ? `${state.confidence.toFixed(1)}×` : "—"} note="vs noise floor" />
          </div>
          <div style={muted}>
            {state.counts.keep} kept · {state.counts.discard} discarded · {state.counts.crash} crashed · {state.counts.checks_failed} checks failed
          </div>
        </>
      )}

      {checksFailed && (
        <div style={{ ...box, fontWeight: 600 }}>
          The last run failed its checks. Log it as checks_failed before the next run.
        </div>
      )}

      {state.configError && (
        <div style={{ ...box, fontWeight: 600 }}>
          config.json cannot be read: {state.configError}. Run, log, init and start are refused until it is fixed.
        </div>
      )}

      {state.runs.length > 0 && (
        <div style={{ maxHeight: 360, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                {["#", "Status", state.metricName, "vs baseline", "What"].map((h) => (
                  <th key={h} style={{ ...cell, fontWeight: 600, color: "var(--muted-foreground)" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...state.runs].reverse().map((run) => (
                <RunRow key={run.run} run={run} unit={unit} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "grid", gap: 8 }}>
        {state.loop?.active !== true && (
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={state.hasConfig ? "New goal (optional)" : "What to optimize"}
              style={input}
            />
            <button
              style={button(true)}
              onClick={start}
              disabled={pending !== null || (!state.hasConfig && goal.trim() === "")}
            >
              {state.hasConfig ? "Resume" : "Start"}
            </button>
          </div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {state.loop?.active === true && (
            <button style={button(false)} onClick={stop} disabled={pending !== null}>
              Stop
            </button>
          )}
          {state.hasConfig && state.counts.keep > 0 && (
            <button style={button(false)} onClick={finalize} disabled={pending !== null}>
              Finalize
            </button>
          )}
          {state.hasConfig && (
            <button style={button(false)} onClick={exportHtml} disabled={pending !== null}>
              Export
            </button>
          )}
        </div>

        {exportedTo && (
          <div style={muted}>
            Exported to <code>{exportedTo}</code>
          </div>
        )}
        {error && <div style={{ fontWeight: 600 }}>{error}</div>}
      </div>
    </div>
  );
}

export default definePluginApp((app) =>
  app.slots.threadPanelAction({
    id: "self-loop",
    title: "Autoresearch Self Loop",
    component: AutoresearchPanel,
    layout: "padded",
  }),
);
