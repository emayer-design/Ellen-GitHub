# Robotics Control — Route Override Command Queue (Prototype)

Prototype for **Signal ROBO-2891 — "Command queue latency spikes during shift
change windows."** It demonstrates a route-override command path for Robotics
Control that stays fast under high-concurrency shift-change windows, gives
operators an explicit result for every command, and refuses to silently re-route
a robot when operators issue opposing overrides.

> Status: prototype / demo. Self-contained Node.js (no external dependencies).

## The problem (from the signal)

FleetOps Logistics reported that when **3+ operators submit route overrides
within a 30-second shift-change window**, command response time degrades from
**under 1s to 4–8s**. Operators also get **no indication whether a command is
queued or failed**, and there were **two safety-adjacent incidents of conflicting
commands re-routing the same robot in opposite directions**. The account renewal
was flagged at risk.

## The approach

| Concern | Legacy model (reproduced) | This prototype |
| --- | --- | --- |
| Latency under load | Single global lock serializes every command; latency grows with queue depth (→ 4–8s) | Bounded worker **concurrency** so unrelated robots are handled in parallel |
| Command ordering / safety | Ambiguous | **Per-robot serialization** — one robot never has two in-flight commands |
| Operator feedback | "Queued vs failed" is invisible | Every submission resolves to an explicit state: `queued → applied \| failed \| conflict \| rejected` |
| Conflicting overrides | Opposing commands can both apply and re-route a robot | Opposing override within a **conflict window** is rejected as `conflict` with a reason — never silently applied |
| Investigation | No visibility | **Diagnostics**: latency percentiles, status breakdown, feedback coverage, peak queue depth |

## Run it

```bash
npm test          # unit + reproduction tests
npm run demo      # optimized queue: p95 response time well under 1s
npm run demo:legacy   # legacy model: p95 response time in the 4–8s band
```

Representative demo output:

```
OPTIMIZED  response time (ms):  p50≈52   p95≈111   feedback coverage 100%   (3 conflicts safely rejected)
LEGACY     response time (ms):  p50≈4304 p95≈7543  feedback coverage 100%
```

## Layout

```
src/commandQueue.js    Core queue: concurrency, per-robot ordering, conflict policy, states
src/robotController.js Simulated route controller (processFn); models work + optional contention
src/metrics.js         Diagnostics: latency percentiles, status breakdown, feedback coverage
src/simulate.js        Demo harness reproducing the 3+ operators / 30s burst
test/commandQueue.test.js  Reproduction + behavior tests
docs/EXPLAINER.md      Design rationale and how it maps to the PRD
```

## Prototype decisions (PRD open questions)

These fill TBDs in the PRD and are intended for review — they are easy to tune:

- **Latency threshold (Q3):** p95 ≤ **1000ms** under the reproduction load.
- **Conflict policy (Q4):** per-robot serialization; an **opposing** override
  that arrives while a robot is under an active override (within a
  **2000ms** window) is rejected as `conflict`. `STOP` is always safe.
- **Feedback coverage (Q6):** target **100%** of submissions reach a terminal state.
- **Root-cause model:** legacy degradation modeled as global serialization plus
  lock contention that scales with queue depth.

See `docs/EXPLAINER.md` for the full mapping to PRD requirements R1–R6.
