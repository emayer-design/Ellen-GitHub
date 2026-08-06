# Explainer — Command Queue Visibility & Conflict Handling

**Signal:** Command queue latency during shift changes (Robotics Control,
Critical / At Risk).
**PRD:** Command Queue Visibility and Conflict Handling.

This document explains what the prototype does, the decisions behind it, and how
to verify it against the PRD.

## The problem, in one paragraph

During shift handoffs (6am / 2pm), multiple operators issue route override
commands at once. Response time degrades from <1s to 4–8s, and — critically —
operators get **no feedback** about whether a command is queued, processing, or
failed. So they resubmit. That grows the backlog and, worse, lets two operators
reroute the same robot in opposite directions without anyone noticing: a
safety-adjacent conflict.

## The approach

The root cause the operators experience is **ambiguity**, not just latency. The
prototype attacks the ambiguity directly:

1. **Make state explicit (R1).** Every command has one of four states —
   `queued`, `processing`, `completed`, `failed` — plus a recorded history of
   transitions.
2. **Show the queue (R2).** A single `snapshot()` exposes per-command state,
   queue depth, suppressed-duplicate counts, and open conflicts. It powers a
   JSON API and a live browser dashboard.
3. **Stop blind resubmissions (R3).** Identical resubmissions within a 30s
   window are collapsed onto the original command and answered with a clear
   receipt ("already queued — no need to resubmit").
4. **Catch conflicting reroutes (R4).** Two operators, same robot, different
   route/direction → both commands are held and an escalation is opened.
5. **Route to a supervisor (R5).** Escalations are prioritized so the worst
   (most operators, longest wait) surface first. The supervisor picks a winner;
   the losing commands fail as `superseded_by_supervisor`.

## Why these design choices

- **Zero dependencies / built-in Node test runner + HTTP server.** Keeps the
  prototype trivial to run and review, and avoids supply-chain and install
  friction for a throwaway-friendly first release.
- **Injectable clock.** The 30s dedupe window and the repro scenario are
  exercised deterministically in tests without waiting on real time.
- **Block-and-escalate (not auto-resolve) for conflicts.** The signal flags this
  as a safety issue, so the safe default is to hold and require a human decision
  rather than guess.
- **Per-robot escalation grouping.** Mirrors how a supervisor actually thinks
  ("what's happening with R-17?") rather than a flat list of pairwise conflicts.

## Mapping to acceptance criteria

| Requirement | Verified by |
| --- | --- |
| R1 command state | `test/lifecycle.test.js` |
| R2 queue visibility | `test/lifecycle.test.js` + `src/server.js` / dashboard |
| R3 duplicate detection | `test/duplicates.test.js` |
| R4 conflict detection | `test/conflicts.test.js` |
| R5 supervisor routing | `test/conflicts.test.js` |
| R6 repro (3+ ops / 30s) | `test/repro.test.js`, `npm run simulate` |

## How to verify

```bash
npm test          # 18 checks across R1–R6
npm run simulate  # readable console walk-through of the repro scenario
npm start         # live dashboard at http://localhost:3000
```

## Open questions carried from the PRD

These were left as TBD in the approved PRD and are **not** decided by this
prototype:

- **Owner** of the PRD / first-release scope (Q1).
- Explicit **out-of-scope** items (Q2).
- Concrete **latency target** for the 3+ operator / 30s scenario (Q3).
- Concrete **duplicate-resubmission reduction target** (Q4).

The prototype instruments the relevant signals (queue depth, duplicates
suppressed, conflicts detected) so targets can be set against real measurements.

## Follow-ups beyond the prototype

- Persist state (currently in-memory only).
- Integrate real command execution / robot telemetry instead of simulated
  processing.
- Route-graph-aware conflict detection (intersecting paths across robots).
- AuthN/AuthZ and per-operator/supervisor roles on the API.
