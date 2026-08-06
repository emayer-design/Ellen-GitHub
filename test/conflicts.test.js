// R4 (conflict detection) + R5 (supervisor routing / resolution)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandCenter, CommandState } from '../src/commandCenter.js';

test('R4: two operators rerouting the same robot differently are held + escalated', () => {
  const cc = new CommandCenter();
  const a = cc.submit({ operatorId: 'op-A', robotId: 'R-17', targetRoute: 'AISLE-3' });
  const c = cc.submit({ operatorId: 'op-C', robotId: 'R-17', targetRoute: 'AISLE-9', direction: 'reverse' });

  assert.equal(c.reason, 'conflict');
  assert.equal(c.blocked, true);
  assert.equal(cc.commands.get(a.id).blocked, true, 'the earlier command is also held');
  assert.equal(cc.metrics.conflictsDetected, 1);

  // Neither conflicting command is processable while held.
  assert.equal(cc.processNext(), null);
});

test('R4: same operator + same robot + different route is a dedupe/no-conflict case, not a conflict', () => {
  const cc = new CommandCenter();
  cc.submit({ operatorId: 'op-A', robotId: 'R-17', targetRoute: 'AISLE-3' });
  const again = cc.submit({ operatorId: 'op-A', robotId: 'R-17', targetRoute: 'AISLE-9' });
  // Same operator changing their own mind is not a multi-operator safety conflict.
  assert.notEqual(again.reason, 'conflict');
  assert.equal(cc.listEscalations().length, 0);
});

test('R4: different robots never conflict', () => {
  const cc = new CommandCenter();
  cc.submit({ operatorId: 'op-A', robotId: 'R-1', targetRoute: 'AISLE-3' });
  const other = cc.submit({ operatorId: 'op-B', robotId: 'R-2', targetRoute: 'AISLE-3', direction: 'reverse' });
  assert.equal(other.reason, 'queued');
  assert.equal(cc.listEscalations().length, 0);
});

test('R5: escalations are prioritized by operator count, worst first', () => {
  const cc = new CommandCenter();
  // Robot R-17: three operators fighting.
  cc.submit({ operatorId: 'op-A', robotId: 'R-17', targetRoute: 'AISLE-3' });
  cc.submit({ operatorId: 'op-B', robotId: 'R-17', targetRoute: 'AISLE-9', direction: 'reverse' });
  cc.submit({ operatorId: 'op-C', robotId: 'R-17', targetRoute: 'DOCK-1' });
  // Robot R-20: two operators.
  cc.submit({ operatorId: 'op-D', robotId: 'R-20', targetRoute: 'AISLE-1' });
  cc.submit({ operatorId: 'op-E', robotId: 'R-20', targetRoute: 'AISLE-2' });

  const escalations = cc.listEscalations();
  assert.equal(escalations.length, 2);
  assert.equal(escalations[0].robotId, 'R-17', 'the 3-operator conflict ranks first');
  assert.ok(escalations[0].priority > escalations[1].priority);
});

test('R5: resolving a conflict lets the winner proceed and fails the rest', () => {
  const cc = new CommandCenter();
  const a = cc.submit({ operatorId: 'op-A', robotId: 'R-17', targetRoute: 'AISLE-3' });
  const c = cc.submit({ operatorId: 'op-C', robotId: 'R-17', targetRoute: 'AISLE-9', direction: 'reverse' });

  const conflictId = cc.listEscalations()[0].conflictId;
  cc.resolveConflict(conflictId, a.id);

  assert.equal(cc.commands.get(a.id).blocked, false);
  assert.equal(cc.commands.get(c.id).state, CommandState.FAILED);
  assert.match(cc.commands.get(c.id).failureReason, /superseded_by_supervisor/);
  assert.equal(cc.listEscalations().length, 0, 'escalation is resolved');

  // The winner is now processable.
  const processing = cc.processNext();
  assert.equal(processing.id, a.id);
});

test('R5: resolving with a command outside the conflict is rejected', () => {
  const cc = new CommandCenter();
  cc.submit({ operatorId: 'op-A', robotId: 'R-17', targetRoute: 'AISLE-3' });
  cc.submit({ operatorId: 'op-C', robotId: 'R-17', targetRoute: 'AISLE-9', direction: 'reverse' });
  const conflictId = cc.listEscalations()[0].conflictId;
  assert.throws(() => cc.resolveConflict(conflictId, 'cmd-999'), /not part of/);
});
