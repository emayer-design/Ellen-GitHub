// R1 (command state) + R2 (queue visibility)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandCenter, CommandState } from '../src/commandCenter.js';

function fixedClock() {
  let now = 0;
  return { clock: () => now, set: (v) => { now = v; } };
}

test('R1: a command moves queued -> processing -> completed', () => {
  const cc = new CommandCenter();
  const { id, state } = cc.submit({ operatorId: 'op-A', robotId: 'R-1', targetRoute: 'AISLE-3' });
  assert.equal(state, CommandState.QUEUED);

  const processing = cc.processNext();
  assert.equal(processing.id, id);
  assert.equal(processing.state, CommandState.PROCESSING);

  cc.complete(id);
  assert.equal(cc.commands.get(id).state, CommandState.COMPLETED);
});

test('R1: a command can be marked failed with a reason', () => {
  const cc = new CommandCenter();
  const { id } = cc.submit({ operatorId: 'op-A', robotId: 'R-1', targetRoute: 'AISLE-3' });
  cc.processNext();
  cc.fail(id, 'actuator_timeout');
  const cmd = cc.commands.get(id);
  assert.equal(cmd.state, CommandState.FAILED);
  assert.equal(cmd.failureReason, 'actuator_timeout');
});

test('R1: state history is recorded for every transition', () => {
  const cc = new CommandCenter();
  const { id } = cc.submit({ operatorId: 'op-A', robotId: 'R-1', targetRoute: 'AISLE-3' });
  cc.processNext();
  cc.complete(id);
  const states = cc.commands.get(id).history.map((h) => h.state);
  assert.deepEqual(states, [
    CommandState.QUEUED,
    CommandState.PROCESSING,
    CommandState.COMPLETED,
  ]);
});

test('R2: snapshot exposes queue depth and per-state counts', () => {
  const cc = new CommandCenter();
  cc.submit({ operatorId: 'op-A', robotId: 'R-1', targetRoute: 'AISLE-3' });
  cc.submit({ operatorId: 'op-B', robotId: 'R-2', targetRoute: 'DOCK-1' });
  cc.processNext(); // R-1 -> processing

  const snap = cc.snapshot();
  assert.equal(snap.queueDepth, 1); // one still waiting
  assert.equal(snap.byState[CommandState.PROCESSING], 1);
  assert.equal(snap.byState[CommandState.QUEUED], 1);
  assert.equal(snap.commands.length, 2);
});

test('R2: submit receipt tells the operator the command state and position', () => {
  const clock = fixedClock();
  const cc = new CommandCenter({ clock: clock.clock });
  const receipt = cc.submit({ operatorId: 'op-A', robotId: 'R-1', targetRoute: 'AISLE-3' });
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.state, CommandState.QUEUED);
  assert.match(receipt.message, /position 1/);
});

test('boundary: submit rejects missing required fields', () => {
  const cc = new CommandCenter();
  assert.throws(() => cc.submit({ operatorId: 'op-A', robotId: 'R-1' }), /targetRoute/);
});
