// Demo harness: reproduces the ROBO-2891 shift-change scenario.
//
//   4 operators submit route overrides in a burst (the "3+ operators within a
//   30-second window" case from the signal). The set intentionally includes two
//   opposing overrides against the same robot so the conflict policy is visible.
//
// Run:
//   npm run demo          # optimized queue (bounded concurrency, per-robot order)
//   npm run demo:legacy   # legacy model (single global worker + lock contention)

import { CommandQueue } from './commandQueue.js';
import { createRouteProcessor } from './robotController.js';
import { computeMetrics, formatMetrics } from './metrics.js';

// Deterministic PRNG so demo output is stable across runs.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A representative shift-change burst. Two operators target robot R-03 in
// opposing directions (NORTH vs SOUTH) to exercise the conflict policy.
function buildBurst() {
  return [
    { operatorId: 'op-1', robotId: 'R-01', direction: 'NORTH' },
    { operatorId: 'op-2', robotId: 'R-02', direction: 'EAST' },
    { operatorId: 'op-3', robotId: 'R-03', direction: 'NORTH' },
    { operatorId: 'op-4', robotId: 'R-04', direction: 'WEST' },
    { operatorId: 'op-1', robotId: 'R-05', direction: 'SOUTH' },
    { operatorId: 'op-2', robotId: 'R-06', direction: 'NORTH' },
    { operatorId: 'op-3', robotId: 'R-03', direction: 'SOUTH' }, // conflicts with op-3's NORTH on R-03
    { operatorId: 'op-4', robotId: 'R-07', direction: 'EAST' },
    { operatorId: 'op-1', robotId: 'R-08', direction: 'STOP' },
    { operatorId: 'op-2', robotId: 'R-01', direction: 'STOP' }, // STOP is always safe, even after NORTH
    { operatorId: 'op-3', robotId: 'R-02', direction: 'WEST' }, // conflicts with op-2's EAST on R-02
    { operatorId: 'op-4', robotId: 'R-04', direction: 'NORTH' },
    { operatorId: 'op-1', robotId: 'R-05', direction: 'SOUTH' },
    { operatorId: 'op-2', robotId: 'R-06', direction: 'EAST' },
    { operatorId: 'op-3', robotId: 'R-07', direction: 'WEST' }, // conflicts with op-4's EAST on R-07
    { operatorId: 'op-4', robotId: 'R-08', direction: 'STOP' },
  ];
}

async function runScenario({ legacy }) {
  const processFn = legacy
    ? createRouteProcessor({ baseMs: 300, jitterMs: 40, contentionMsPerDepth: 25, rng: mulberry32(7) })
    : createRouteProcessor({ baseMs: 40, jitterMs: 20, contentionMsPerDepth: 0, rng: mulberry32(7) });

  const queue = new CommandQueue({
    concurrency: legacy ? 1 : 8,
    conflictWindowMs: 2000,
    processFn,
  });

  const burst = buildBurst();
  const acks = burst.map((cmd) => queue.submit(cmd));
  await queue.onIdle();

  const records = queue.getRecords();
  const metrics = computeMetrics(records);

  console.log(`\n=== ${legacy ? 'LEGACY (global serialization + contention)' : 'OPTIMIZED (bounded concurrency + per-robot order)'} ===`);
  console.log(`operators: ${new Set(burst.map((c) => c.operatorId)).size}, robots: ${new Set(burst.map((c) => c.robotId)).size}, commands: ${burst.length}`);
  console.log(`immediate acks (queued): ${acks.filter((a) => a.accepted).length}/${acks.length}`);
  console.log('');
  console.log(formatMetrics(metrics));
  console.log('\nper-command outcomes:');
  for (const r of records) {
    const detail = r.reason ? `  — ${r.reason}` : '';
    console.log(
      `  ${r.commandId.padEnd(7)} ${r.operatorId} -> ${r.robotId} ${String(r.direction).padEnd(5)} ` +
        `[${r.status}] ${r.endToEndLatencyMs == null ? '' : Math.round(r.endToEndLatencyMs) + 'ms'}${detail}`,
    );
  }
  console.log('');

  return metrics;
}

const legacy = process.argv.includes('--legacy');
runScenario({ legacy }).catch((err) => {
  console.error(err);
  process.exit(1);
});
