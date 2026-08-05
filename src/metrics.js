// Queue diagnostics for PM / engineering (Requirement R5).
//
// Turns a list of command records (from CommandQueue.getRecords()) into the
// numbers that matter for the ROBO-2891 investigation: latency percentiles,
// state breakdown, operator-feedback coverage, and peak queue depth.

export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

export function computeMetrics(records) {
  const total = records.length;
  const terminal = records.filter((r) => r.terminalAt != null);

  const endToEnd = terminal.map((r) => r.terminalAt - r.submittedAt);
  const ack = records.map((r) => r.ackAt - r.submittedAt);

  const byStatus = {};
  for (const r of records) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  }

  return {
    total,
    byStatus,
    // Fraction of submissions that reached an explicit terminal state.
    feedbackCoverage: total === 0 ? 1 : terminal.length / total,
    ackLatencyMs: {
      p50: round(percentile(ack, 50)),
      p95: round(percentile(ack, 95)),
      max: round(Math.max(0, ...ack)),
    },
    endToEndLatencyMs: {
      p50: round(percentile(endToEnd, 50)),
      p95: round(percentile(endToEnd, 95)),
      max: round(Math.max(0, ...endToEnd)),
    },
    maxQueueDepth: Math.max(0, ...records.map((r) => r.queueDepthAtStart ?? 0)),
  };
}

export function formatMetrics(metrics) {
  const lines = [
    `commands:            ${metrics.total}`,
    `by status:           ${JSON.stringify(metrics.byStatus)}`,
    `feedback coverage:   ${(metrics.feedbackCoverage * 100).toFixed(1)}%`,
    `ack latency (ms):    p50=${metrics.ackLatencyMs.p50}  p95=${metrics.ackLatencyMs.p95}  max=${metrics.ackLatencyMs.max}`,
    `response time (ms):  p50=${metrics.endToEndLatencyMs.p50}  p95=${metrics.endToEndLatencyMs.p95}  max=${metrics.endToEndLatencyMs.max}`,
    `max queue depth:     ${metrics.maxQueueDepth}`,
  ];
  return lines.join('\n');
}

function round(n) {
  return Math.round(n * 100) / 100;
}
