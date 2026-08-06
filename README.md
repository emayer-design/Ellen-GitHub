# Command Queue Visibility & Conflict Handling (prototype)

A first-release prototype for the Robotics Control signal
**“Command queue latency during shift changes.”** During shift handoffs, route
override commands can slow down or appear unconfirmed, so operators resubmit —
compounding queue backlog and creating safety-adjacent conflicts (two operators
rerouting the same robot in opposite directions).

This prototype makes command state **explicit**, suppresses blind
**resubmissions**, detects **conflicting reroutes**, and routes them to a
**supervisor** — with a live dashboard to see it all.

> Zero runtime dependencies. Node.js ≥ 18 (uses the built-in test runner and
> HTTP server).

## Requirements mapping

| Req | What it means | Where |
| --- | --- | --- |
| **R1** | Command state is queued / processing / completed / failed | `src/commandCenter.js` (`CommandState`, `#transition`) |
| **R2** | Queue visibility for operators | `snapshot()`, `src/server.js`, `public/index.html` |
| **R3** | Detect duplicate resubmissions | `submit()` dedupe window |
| **R4** | Alert/block conflicting reroutes | `submit()` conflict detection + `#escalate()` |
| **R5** | Supervisor can see & prioritize conflicts | `listEscalations()`, `resolveConflict()` |
| **R6** | Repro: 3+ operators within a 30s window | `src/simulate.js`, `test/repro.test.js` |

## Quick start

```bash
# Run the test suite (maps 1:1 to R1–R6)
npm test

# Run the deterministic repro scenario in the console (R6)
npm run simulate

# Launch the live dashboard, seeded with the repro scenario
npm start   # then open http://localhost:3000
```

## How it works

- **`CommandCenter`** (`src/commandCenter.js`) is the engine. Every route
  override becomes a tracked command with an explicit lifecycle and full state
  history.
- **Duplicate detection (R3):** an identical submission (same operator, robot,
  target, direction) while the original is still active and within a 30s window
  is collapsed onto the original and reported back — so the operator gets clear
  feedback instead of piling on resubmissions.
- **Conflict detection (R4):** when a *different* operator targets the *same*
  robot with a *different* route/direction, both commands are held and an
  escalation is opened for that robot.
- **Supervisor console (R5):** open escalations are prioritized (more operators
  fighting over one robot + longer waits rank higher). Resolving picks a winner;
  the rest fail as `superseded_by_supervisor`.
- **Visibility (R2):** `snapshot()` powers both the JSON API and the dashboard,
  showing per-command state, queue depth, suppressed duplicates, and open
  conflicts.

## API (demo server)

| Method & path | Purpose |
| --- | --- |
| `GET /api/state` | Full queue + escalation snapshot |
| `POST /api/commands` | Submit `{ operatorId, robotId, targetRoute, direction? }` |
| `POST /api/process` | Process (and complete) the next eligible command |
| `POST /api/resolve` | Resolve `{ conflictId, winnerCommandId }` |

## Known limitations (prototype)

- In-memory state only; nothing is persisted across restarts.
- Command "processing" is simulated (no real robot/actuator integration).
- Conflict rule is intentionally simple (same robot, differing route/direction).
  Route-graph-aware conflicts (e.g. intersecting paths on different robots) are
  a follow-up.
- No authentication/authorization on the demo API.
