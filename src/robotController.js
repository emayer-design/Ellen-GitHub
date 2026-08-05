// Simulated robot route controller.
//
// Produces a `processFn` for CommandQueue that models the work of applying a
// route override to a robot. Two knobs let us reproduce the ROBO-2891 signal:
//   * contentionMsPerDepth: extra delay proportional to queue depth, modelling
//     the lock contention that made the legacy path degrade to 4-8s under load.
//   * failRobotIds: robots whose overrides fail downstream, so we can verify
//     operators get an explicit `failed` state (never a silent outcome).

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export function createRouteProcessor({
  baseMs = 40,
  jitterMs = 20,
  contentionMsPerDepth = 0,
  failRobotIds = new Set(),
  rng = Math.random,
} = {}) {
  const failing = failRobotIds instanceof Set ? failRobotIds : new Set(failRobotIds);

  return async function processRouteOverride(command, ctx) {
    const depth = Math.max(1, ctx?.queueDepth ?? 1);
    const contention = contentionMsPerDepth * (depth - 1);
    const jitter = Math.floor(rng() * jitterMs);
    await delay(baseMs + jitter + contention);

    if (failing.has(command.robotId)) {
      throw new Error(`route controller could not apply ${command.direction} to ${command.robotId}`);
    }
    return { robotId: command.robotId, direction: command.direction, appliedMs: baseMs + jitter + contention };
  };
}
