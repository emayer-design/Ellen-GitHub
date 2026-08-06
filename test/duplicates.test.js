// R3 (duplicate detection / resubmission suppression)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandCenter } from '../src/commandCenter.js';

function fixedClock() {
  let now = 0;
  return { clock: () => now, set: (v) => { now = v; } };
}

test('R3: identical resubmit within the window is suppressed onto the original', () => {
  const clock = fixedClock();
  const cc = new CommandCenter({ clock: clock.clock, dedupeWindowMs: 30_000 });

  const first = cc.submit({ operatorId: 'op-A', robotId: 'R-1', targetRoute: 'AISLE-3' });
  clock.set(6_000);
  const second = cc.submit({ operatorId: 'op-A', robotId: 'R-1', targetRoute: 'AISLE-3' });

  assert.equal(second.accepted, false);
  assert.equal(second.reason, 'duplicate');
  assert.equal(second.deduplicatedOf, first.id);
  assert.equal(cc.commands.size, 1, 'no second command should be created');
  assert.equal(cc.commands.get(first.id).suppressedResubmits, 1);
  assert.equal(cc.metrics.duplicatesSuppressed, 1);
});

test('R3: three blind resubmits collapse to a single queue entry', () => {
  const clock = fixedClock();
  const cc = new CommandCenter({ clock: clock.clock });
  cc.submit({ operatorId: 'op-A', robotId: 'R-1', targetRoute: 'AISLE-3' });
  clock.set(3_000);
  cc.submit({ operatorId: 'op-A', robotId: 'R-1', targetRoute: 'AISLE-3' });
  clock.set(9_000);
  cc.submit({ operatorId: 'op-A', robotId: 'R-1', targetRoute: 'AISLE-3' });

  const snap = cc.snapshot();
  assert.equal(snap.commands.length, 1);
  assert.equal(snap.queueDepth, 1);
  assert.equal(snap.metrics.duplicatesSuppressed, 2);
});

test('R3: a resubmit AFTER the window is treated as a new command', () => {
  const clock = fixedClock();
  const cc = new CommandCenter({ clock: clock.clock, dedupeWindowMs: 30_000 });
  cc.submit({ operatorId: 'op-A', robotId: 'R-1', targetRoute: 'AISLE-3' });
  clock.set(31_000);
  const later = cc.submit({ operatorId: 'op-A', robotId: 'R-1', targetRoute: 'AISLE-3' });
  assert.equal(later.accepted, true);
  assert.equal(cc.commands.size, 2);
});

test('R3: a different target from the same operator is NOT a duplicate', () => {
  const cc = new CommandCenter();
  cc.submit({ operatorId: 'op-A', robotId: 'R-1', targetRoute: 'AISLE-3' });
  const other = cc.submit({ operatorId: 'op-A', robotId: 'R-1', targetRoute: 'AISLE-9' });
  assert.equal(other.accepted, true);
  assert.equal(cc.commands.size, 2);
});
