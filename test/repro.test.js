// R6 — the signal's repro scenario: 3+ operator sessions submitting route
// override commands within a 30-second window. Asserts the system stays healthy:
// duplicates are suppressed, the conflict is caught, and every command ends in a
// visible terminal state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandState } from '../src/commandCenter.js';
import { buildScenario } from '../src/simulate.js';

test('R6: 4 operators within a 30s window — backlog stays bounded, conflict caught', () => {
  const { cc } = buildScenario();

  // 7 submissions were made, but 3 were blind resubmits inside the window.
  assert.equal(cc.metrics.submitted, 7);
  assert.equal(cc.metrics.duplicatesSuppressed, 3, 'blind resubmits did not grow the queue');
  assert.equal(cc.metrics.accepted, 4);

  // The R-17 opposite-direction reroute is escalated for a supervisor.
  const escalations = cc.listEscalations();
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].robotId, 'R-17');
});

test('R6: after supervisor resolution and draining, every command is terminal & visible', () => {
  const { cc } = buildScenario();

  const esc = cc.listEscalations()[0];
  cc.resolveConflict(esc.conflictId, esc.commands[0].id);

  let processed;
  while ((processed = cc.processNext())) cc.complete(processed.id);

  const snap = cc.snapshot();
  assert.equal(snap.queueDepth, 0);
  assert.equal(snap.escalations.length, 0);
  // No command is left stuck in a non-terminal state.
  const nonTerminal = snap.commands.filter(
    (c) => c.state === CommandState.QUEUED || c.state === CommandState.PROCESSING,
  );
  assert.equal(nonTerminal.length, 0);
  // Exactly one command failed (the superseded reroute); the rest completed.
  const failed = snap.commands.filter((c) => c.state === CommandState.FAILED);
  assert.equal(failed.length, 1);
});
