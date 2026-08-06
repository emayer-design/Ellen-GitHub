// Repro simulator (R6) — reproduces the signal's scenario deterministically:
// 3+ active operator sessions submitting route override commands within a
// 30-second window, including blind resubmissions and a safety-adjacent
// conflicting reroute of the same robot.
//
// Run with:  npm run simulate
//
// Uses a virtual clock so the 30-second window is exercised without waiting.

import { CommandCenter, CommandState } from './commandCenter.js';

/** Builds a CommandCenter driven by a controllable virtual clock. */
export function buildScenario() {
  let now = 0;
  const cc = new CommandCenter({ clock: () => now, dedupeWindowMs: 30_000 });
  const at = (ms, fn) => {
    now = ms;
    return fn();
  };

  const events = [];
  const log = (label, receipt) => events.push({ t: now, label, receipt });

  // Four operator sessions active during a shift handoff (T0..T+28s).
  log('op-A submits reroute of R-17 -> AISLE-3 (forward)',
    at(0, () => cc.submit({ operatorId: 'op-A', robotId: 'R-17', targetRoute: 'AISLE-3' })));

  log('op-B submits reroute of R-42 -> DOCK-1 (forward)',
    at(2_000, () => cc.submit({ operatorId: 'op-B', robotId: 'R-42', targetRoute: 'DOCK-1' })));

  // op-A sees no feedback and resubmits the SAME command twice (R3).
  log('op-A RESUBMITS R-17 -> AISLE-3 (no feedback seen)',
    at(6_000, () => cc.submit({ operatorId: 'op-A', robotId: 'R-17', targetRoute: 'AISLE-3' })));
  log('op-A RESUBMITS R-17 -> AISLE-3 again',
    at(9_000, () => cc.submit({ operatorId: 'op-A', robotId: 'R-17', targetRoute: 'AISLE-3' })));

  // op-C reroutes R-17 the OPPOSITE way -> safety-adjacent conflict (R4).
  log('op-C submits reroute of R-17 -> AISLE-9 (reverse) — CONFLICT',
    at(12_000, () => cc.submit({ operatorId: 'op-C', robotId: 'R-17', targetRoute: 'AISLE-9', direction: 'reverse' })));

  // op-D adds unrelated traffic.
  log('op-D submits reroute of R-88 -> CHARGE-2 (forward)',
    at(15_000, () => cc.submit({ operatorId: 'op-D', robotId: 'R-88', targetRoute: 'CHARGE-2' })));

  // op-B resubmits within the window (R3).
  log('op-B RESUBMITS R-42 -> DOCK-1 (no feedback seen)',
    at(20_000, () => cc.submit({ operatorId: 'op-B', robotId: 'R-42', targetRoute: 'DOCK-1' })));

  return { cc, events, setNow: (ms) => { now = ms; } };
}

function badge(state) {
  return {
    [CommandState.QUEUED]: 'QUEUED    ',
    [CommandState.PROCESSING]: 'PROCESSING',
    [CommandState.COMPLETED]: 'COMPLETED ',
    [CommandState.FAILED]: 'FAILED    ',
  }[state];
}

function run() {
  const { cc, events, setNow } = buildScenario();

  console.log('\n=== Command Queue Visibility & Conflict Handling — repro (R6) ===\n');
  console.log('Shift-handoff burst: 4 operators, route overrides within a 30s window.\n');
  for (const { t, label, receipt } of events) {
    const tag = receipt.accepted ? (receipt.reason === 'conflict' ? '⚠ HELD ' : '✓ OK   ') : '↺ DEDUP';
    console.log(`  [t+${String(t / 1000).padStart(2)}s] ${label}`);
    console.log(`            -> ${tag}  ${receipt.message}`);
  }

  setNow(30_000);
  console.log('\n-- Supervisor console: open escalations (R5) --');
  const escalations = cc.listEscalations();
  for (const e of escalations) {
    console.log(`  ${e.conflictId}  robot=${e.robotId}  priority=${e.priority}  operators=${e.operators.join(', ')}`);
    for (const c of e.commands) {
      console.log(`      ${c.id}  ${c.operatorId}  ${c.targetRoute}/${c.direction}  [${badge(c.state)}]`);
    }
  }

  // Supervisor picks the earliest legitimate command as the winner for R-17.
  if (escalations.length > 0) {
    const esc = escalations[0];
    const winner = esc.commands[0].id;
    console.log(`\n  Supervisor resolves ${esc.conflictId} -> winner ${winner}`);
    cc.resolveConflict(esc.conflictId, winner);
  }

  // Drain the processable queue.
  console.log('\n-- Draining queue --');
  let processed;
  while ((processed = cc.processNext())) {
    cc.complete(processed.id);
    console.log(`  processed ${processed.id} (${processed.operatorId} ${processed.robotId} -> ${processed.targetRoute}) -> completed`);
  }

  const snap = cc.snapshot();
  console.log('\n-- Final snapshot (R1 + R2) --');
  for (const c of snap.commands) {
    const extra = c.suppressedResubmits ? `  (+${c.suppressedResubmits} duplicate resubmits suppressed)` : '';
    const reason = c.failureReason ? `  reason=${c.failureReason}` : '';
    console.log(`  ${c.id}  ${c.operatorId}  ${c.robotId} -> ${c.targetRoute}/${c.direction}  [${badge(c.state)}]${extra}${reason}`);
  }

  console.log('\n-- Metrics --');
  console.log(`  submitted:            ${snap.metrics.submitted}`);
  console.log(`  accepted (new):       ${snap.metrics.accepted}`);
  console.log(`  duplicates suppressed:${snap.metrics.duplicatesSuppressed}`);
  console.log(`  conflicts detected:   ${snap.metrics.conflictsDetected}`);
  console.log(`  queue depth (final):  ${snap.queueDepth}`);
  console.log('\nWithout this system, the 3 blind resubmits would have added 3 more');
  console.log('queue entries and the R-17 conflict would have executed unnoticed.\n');
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
