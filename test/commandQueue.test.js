import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CommandQueue, CommandStatus, directionsConflict } from '../src/commandQueue.js';
import { createRouteProcessor } from '../src/robotController.js';
import { computeMetrics } from '../src/metrics.js';

// Acceptance threshold for the prototype (PRD open question Q3): restore the
// signal's "<1s" behaviour under the reproduction load.
const RESPONSE_TIME_P95_MS = 1000;

async function drain(queue) {
  await queue.onIdle();
  return queue.getRecords();
}

test('R1/R2/R6: reproduces 3+ operators in a burst and keeps p95 response time under 1s', async () => {
  const queue = new CommandQueue({
    concurrency: 8,
    conflictWindowMs: 2000,
    processFn: createRouteProcessor({ baseMs: 40, jitterMs: 20, rng: () => 0.5 }),
  });

  // 4 operators, distinct robots, all submitted within the same window.
  const burst = [];
  const operators = ['op-1', 'op-2', 'op-3', 'op-4'];
  for (let i = 0; i < 16; i += 1) {
    burst.push({
      operatorId: operators[i % operators.length],
      robotId: `R-${String(i).padStart(2, '0')}`,
      direction: 'NORTH',
    });
  }

  const acks = burst.map((cmd) => queue.submit(cmd));
  // Every submission is acknowledged immediately as queued.
  assert.equal(acks.filter((a) => a.accepted && a.status === CommandStatus.QUEUED).length, burst.length);

  const records = await drain(queue);
  const metrics = computeMetrics(records);

  assert.equal(metrics.total, burst.length);
  assert.ok(
    metrics.endToEndLatencyMs.p95 <= RESPONSE_TIME_P95_MS,
    `p95 response time ${metrics.endToEndLatencyMs.p95}ms should be <= ${RESPONSE_TIME_P95_MS}ms`,
  );
  // Distinct robots => no conflicts => everything applied.
  assert.equal(metrics.byStatus[CommandStatus.APPLIED], burst.length);
});

test('R3: every submission resolves to an explicit terminal state (no silent outcomes)', async () => {
  const queue = new CommandQueue({
    processFn: createRouteProcessor({ baseMs: 10, jitterMs: 5, failRobotIds: ['R-FAIL'], rng: () => 0.5 }),
  });

  const acks = [
    queue.submit({ operatorId: 'op-1', robotId: 'R-01', direction: 'NORTH' }), // applied
    queue.submit({ operatorId: 'op-1', robotId: 'R-FAIL', direction: 'EAST' }), // failed
    queue.submit({ operatorId: 'op-1', robotId: 'R-02', direction: 'DIAGONAL' }), // rejected (invalid)
  ];

  const results = await Promise.all(acks.map((a) => queue.result(a.commandId)));
  const statuses = results.map((r) => r.status);

  assert.deepEqual(statuses, [CommandStatus.APPLIED, CommandStatus.FAILED, CommandStatus.REJECTED]);
  const metrics = computeMetrics(await drain(queue));
  assert.equal(metrics.feedbackCoverage, 1, 'all commands must reach a terminal state');
  // Failed and rejected commands carry an actionable reason for the operator.
  assert.match(results[1].reason, /could not apply/);
  assert.match(results[2].reason, /direction must be one of/);
});

test('R4: opposing overrides on the same robot are rejected as conflict, not silently re-routed', async () => {
  const queue = new CommandQueue({
    conflictWindowMs: 5000,
    processFn: createRouteProcessor({ baseMs: 15, jitterMs: 0, rng: () => 0 }),
  });

  const first = queue.submit({ operatorId: 'op-1', robotId: 'R-03', direction: 'NORTH' });
  const second = queue.submit({ operatorId: 'op-2', robotId: 'R-03', direction: 'SOUTH' });

  const firstResult = await queue.result(first.commandId);
  const secondResult = await queue.result(second.commandId);

  assert.equal(firstResult.status, CommandStatus.APPLIED);
  assert.equal(secondResult.status, CommandStatus.CONFLICT);
  assert.match(secondResult.reason, /Opposing override active for robot R-03/);
});

test('R4: STOP is always safe and is never treated as a conflict', async () => {
  assert.equal(directionsConflict('NORTH', 'STOP'), false);
  assert.equal(directionsConflict('NORTH', 'SOUTH'), true);

  const queue = new CommandQueue({
    conflictWindowMs: 5000,
    processFn: createRouteProcessor({ baseMs: 10, jitterMs: 0, rng: () => 0 }),
  });

  const a = queue.submit({ operatorId: 'op-1', robotId: 'R-09', direction: 'NORTH' });
  const b = queue.submit({ operatorId: 'op-2', robotId: 'R-09', direction: 'STOP' });

  assert.equal((await queue.result(a.commandId)).status, CommandStatus.APPLIED);
  assert.equal((await queue.result(b.commandId)).status, CommandStatus.APPLIED);
});

test('per-robot serialization: a single robot never has two commands in flight at once', async () => {
  let inFlight = 0;
  let maxConcurrentSameRobot = 0;
  const perRobotActive = new Map();

  const queue = new CommandQueue({
    concurrency: 8,
    processFn: async (command) => {
      inFlight += 1;
      const active = (perRobotActive.get(command.robotId) ?? 0) + 1;
      perRobotActive.set(command.robotId, active);
      maxConcurrentSameRobot = Math.max(maxConcurrentSameRobot, active);
      await new Promise((r) => setTimeout(r, 15));
      perRobotActive.set(command.robotId, perRobotActive.get(command.robotId) - 1);
      inFlight -= 1;
    },
  });

  // Five commands all targeting the SAME robot.
  for (let i = 0; i < 5; i += 1) {
    queue.submit({ operatorId: `op-${i}`, robotId: 'R-SAME', direction: 'STOP' });
  }
  await queue.onIdle();

  assert.equal(maxConcurrentSameRobot, 1, 'same robot must be serialized');
});

test('R5: metrics expose status breakdown, latency percentiles, and peak queue depth', async () => {
  const queue = new CommandQueue({
    concurrency: 4,
    processFn: createRouteProcessor({ baseMs: 10, jitterMs: 5, rng: () => 0.5 }),
  });

  for (let i = 0; i < 10; i += 1) {
    queue.submit({ operatorId: 'op-1', robotId: `R-${i}`, direction: 'NORTH' });
  }
  const metrics = computeMetrics(await drain(queue));

  assert.ok('applied' in metrics.byStatus);
  assert.ok(metrics.endToEndLatencyMs.p95 >= metrics.endToEndLatencyMs.p50);
  assert.ok(metrics.maxQueueDepth >= 1);
  assert.equal(metrics.feedbackCoverage, 1);
});
