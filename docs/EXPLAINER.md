# Explainer — Route Override Command Queue Prototype

**Signal:** ROBO-2891 — Command queue latency spikes during shift change windows
**PRD:** Route override command latency and operator feedback during shift changes
**Scope:** MVP prototype of the Robotics Control route-override path.

## Why this design

The signal describes three intertwined failures during shift-change windows:

1. **Latency** grows from `<1s` to `4–8s` when 3+ operators submit overrides at once.
2. **No feedback** — operators can't tell if a command is queued or failed.
3. **Safety** — two operators re-routed the same robot in opposite directions.

The most likely shape of the legacy bug is that a single global processing path
(one lock / one worker) serialized *every* command in the system. Under a burst,
each command waits behind all the others, so the last operator in a 16-command
burst waits ~16 × processing-time — landing squarely in the 4–8s band. You can
reproduce this with `npm run demo:legacy`.

This prototype separates two things that the legacy path conflated:

- **Throughput** is a global concern → solved with **bounded worker concurrency**.
  Commands for *different* robots run in parallel, so a burst drains quickly.
- **Safety / ordering** is a *per-robot* concern → solved with **per-robot
  serialization**. A single robot never has two in-flight commands, so we can
  reason about "what override is currently active" for each robot.

On top of per-robot ordering we add a **conflict window**: once an override is
applied to a robot, an *opposing* override arriving within the window is rejected
as `conflict` (with a human-readable reason) instead of being applied on top of
the first. `STOP` is always safe and is never a conflict. This directly prevents
the "same robot, opposite directions" incident from the signal.

Finally, every submission returns a **fast acknowledgement** (`queued`) and
resolves to exactly one **terminal state** (`applied` / `failed` / `conflict` /
`rejected`) with a reason — so the operator always knows what happened.

## How it maps to the PRD requirements

| PRD | Requirement | Where |
| --- | --- | --- |
| R1 | Support 3+ operators submitting overrides within a 30s window | `src/simulate.js` burst; reproduction test in `test/commandQueue.test.js` |
| R2 | Response time does not degrade to 4–8s (restore `<1s`) | Bounded concurrency in `CommandQueue`; test asserts **p95 ≤ 1000ms** |
| R3 | Operator can tell queued vs failed | `CommandStatus` states + immediate ack; test asserts 100% terminal coverage with reasons |
| R4 | Safe handling of conflicting same-robot overrides | Conflict window + `directionsConflict`; test asserts opposing override → `conflict` |
| R5 | Diagnostic visibility for PM/eng | `src/metrics.js` — percentiles, status breakdown, coverage, peak queue depth |
| R6 | A validation test reproduces the scenario and checks latency + feedback | `test/commandQueue.test.js` |

## Key parameters (tunable, documented as prototype assumptions)

| Parameter | Default | PRD open question |
| --- | --- | --- |
| `concurrency` | 8 | root-cause / throughput |
| `conflictWindowMs` | 2000 | Q4 — conflict policy |
| acceptance `p95` | 1000 ms | Q3 — latency threshold |
| feedback coverage target | 100% | Q6 |

## Conflict policy details

- Directions: `NORTH`, `SOUTH`, `EAST`, `WEST`, `STOP`.
- "Opposing" = `NORTH↔SOUTH`, `EAST↔WEST`. Perpendicular directions are *not*
  treated as conflicts in this prototype.
- The check is **operator-agnostic and fail-safe**: if a robot is under an active
  opposing override, the new one is rejected regardless of who sent it. `STOP`
  overrides anything and is always accepted.
- Because the window is time-based, an opposing override that arrives *after* the
  window has elapsed is treated as a fresh command (visible in the legacy demo,
  where slow processing pushes some commands past the window).

## Known limitations / follow-ups

- The robot controller is **simulated** (`setTimeout`), not wired to a real
  Robotics Control backend. `processFn` is the integration seam.
- Conflict detection only models **opposite** directions; a production policy may
  need speed/zone/priority-aware conflict rules (PRD Q7 — safety guardrail).
- No persistence, auth, or multi-process coordination — this is a single-process
  prototype to validate the model and the acceptance criteria.
- Exact latency threshold, conflict window, and feedback-coverage target are
  prototype defaults pending PRD confirmation (Q3, Q4, Q6).
