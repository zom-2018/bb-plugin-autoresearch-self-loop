## What you get

Run an autonomous experiment loop in a Git checkout. The agent changes the
code, runs the benchmark and checks, and records whether each iteration was
kept, discarded, or failed. A thread panel shows the metric, baseline, best
result, run history, and controls to start or stop the loop.

The workflow is a close BB port of
[pi-autoresearch](https://pi.dev/packages/pi-autoresearch) by Tobi Lutke and
David Cortés. It offers a compact interface and lets the agent keep iterating
after setup without a sequence of manual approval steps. BB permissions and
repository protections still apply.

## Requirements

Requires BB 0.46 or later, Git, a checkout with at least one commit, and a
benchmark that prints the configured metric. A session starts from a clean
working tree. Each experiment is logged in the checkout. Remote execution
uses the BB server and its connection to the thread's machine.
