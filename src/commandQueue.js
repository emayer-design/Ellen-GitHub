// Route-override command queue for Robotics Control.
//
// Prototype for Signal ROBO-2891: keep command latency low during
// high-concurrency shift-change windows, give operators an explicit terminal
// state for every submission (queued -> applied | failed | conflict), and never
// silently apply opposing overrides to the same robot.
//
// Design (see docs/EXPLAINER.md):
//   * Bounded worker concurrency so unrelated robots are handled in parallel,
//     instead of a single global lock that serialized every command under load.
//   * Per-robot serialization so one robot never has two in-flight commands.
//   * Per-robot conflict window so an opposing override that arrives while a
//     robot is actively under an override is rejected with a `conflict` status
//     instead of re-routing the robot.

const now = () => performance.now();

/** Operator-visible command lifecycle states. */
export const CommandStatus = Object.freeze({
  QUEUED: 'queued', // accepted, waiting or processing
  APPLIED: 'applied', // successfully applied to the robot
  FAILED: 'failed', // downstream processing error
  CONFLICT: 'conflict', // rejected: opposing override still active for this robot
  REJECTED: 'rejected', // rejected: invalid command (validation)
});

export const DIRECTIONS = Object.freeze(['NORTH', 'SOUTH', 'EAST', 'WEST', 'STOP']);

const OPPOSITES = Object.freeze({
  NORTH: 'SOUTH',
  SOUTH: 'NORTH',
  EAST: 'WEST',
  WEST: 'EAST',
});

/** Two directions conflict when they point opposite ways. STOP is always safe. */
export function directionsConflict(a, b) {
  if (!a || !b) return false;
  if (a === 'STOP' || b === 'STOP') return false;
  return OPPOSITES[a] === b;
}

export class CommandQueue {
  /**
   * @param {object} options
   * @param {number} [options.concurrency=8]        Max commands processed in parallel.
   * @param {number} [options.conflictWindowMs=2000] How long an applied override stays "active" for conflict checks.
   * @param {(command: object, ctx: {queueDepth:number}) => Promise<any>} options.processFn
   *        Applies a route override to the robot. Resolve = applied, throw = failed.
   */
  constructor({ concurrency = 8, conflictWindowMs = 2000, processFn } = {}) {
    if (typeof processFn !== 'function') {
      throw new TypeError('CommandQueue requires a processFn');
    }
    this.concurrency = concurrency;
    this.conflictWindowMs = conflictWindowMs;
    this.processFn = processFn;

    this._seq = 0;
    this._pending = []; // records awaiting a worker
    this._activeCount = 0;
    this._robotsInFlight = new Set(); // robotIds currently processing
    this._lastApplied = new Map(); // robotId -> { direction, operatorId, appliedAt }
    this._records = []; // every command record, in submission order
    this._idleWaiters = [];
  }

  /**
   * Submit a route override. Returns immediately with a fast acknowledgement so
   * the operator instantly sees a `queued` (or `rejected`) state.
   */
  submit(command) {
    const submittedAt = now();
    const commandId = command?.commandId ?? `cmd-${++this._seq}`;
    const record = {
      commandId,
      robotId: command?.robotId,
      direction: command?.direction,
      operatorId: command?.operatorId,
      submittedAt,
      ackAt: submittedAt,
      startedAt: null,
      terminalAt: null,
      status: CommandStatus.QUEUED,
      reason: null,
      queueDepthAtStart: null,
    };
    record.result = new Promise((resolve) => {
      record._resolve = resolve;
    });
    this._records.push(record);

    const validationError = validateCommand(command);
    if (validationError) {
      this._finalize(record, CommandStatus.REJECTED, validationError);
      return this._ack(record, false);
    }

    this._pending.push(record);
    // Kick the scheduler asynchronously so submit() always returns fast.
    queueMicrotask(() => this._schedule());
    return this._ack(record, true);
  }

  /** Resolves with the terminal record for a command id. */
  result(commandId) {
    const record = this._records.find((r) => r.commandId === commandId);
    if (!record) return Promise.reject(new Error(`unknown command: ${commandId}`));
    return record.result;
  }

  /** Resolves once the queue has drained (no pending and no in-flight work). */
  onIdle() {
    if (this._pending.length === 0 && this._activeCount === 0) return Promise.resolve();
    return new Promise((resolve) => this._idleWaiters.push(resolve));
  }

  /** Snapshot of every command record (for diagnostics / metrics). */
  getRecords() {
    return this._records.map((r) => ({
      commandId: r.commandId,
      robotId: r.robotId,
      direction: r.direction,
      operatorId: r.operatorId,
      status: r.status,
      reason: r.reason,
      submittedAt: r.submittedAt,
      ackAt: r.ackAt,
      startedAt: r.startedAt,
      terminalAt: r.terminalAt,
      queueDepthAtStart: r.queueDepthAtStart,
      ackLatencyMs: r.ackAt - r.submittedAt,
      endToEndLatencyMs: r.terminalAt == null ? null : r.terminalAt - r.submittedAt,
    }));
  }

  _ack(record, accepted) {
    return {
      commandId: record.commandId,
      status: record.status,
      accepted,
      reason: record.reason,
      submittedAt: record.submittedAt,
    };
  }

  _schedule() {
    while (this._activeCount < this.concurrency) {
      // First pending command whose robot is idle: preserves per-robot ordering
      // while letting different robots run in parallel.
      const idx = this._pending.findIndex((r) => !this._robotsInFlight.has(r.robotId));
      if (idx === -1) break;
      const [record] = this._pending.splice(idx, 1);
      this._process(record);
    }
  }

  _process(record) {
    this._robotsInFlight.add(record.robotId);
    this._activeCount += 1;
    record.startedAt = now();
    record.queueDepthAtStart = this._pending.length + this._activeCount;

    this._execute(record).finally(() => {
      this._robotsInFlight.delete(record.robotId);
      this._activeCount -= 1;
      this._schedule();
      this._checkIdle();
    });
  }

  async _execute(record) {
    const last = this._lastApplied.get(record.robotId);
    const stillActive = last && now() - last.appliedAt <= this.conflictWindowMs;
    if (stillActive && directionsConflict(last.direction, record.direction)) {
      this._finalize(
        record,
        CommandStatus.CONFLICT,
        `Opposing override active for robot ${record.robotId}: ` +
          `${last.direction} (operator ${last.operatorId}) still in effect, ` +
          `so ${record.direction} (operator ${record.operatorId}) was rejected to prevent an unsafe re-route.`,
      );
      return;
    }

    try {
      await this.processFn(record, { queueDepth: record.queueDepthAtStart });
      this._lastApplied.set(record.robotId, {
        direction: record.direction,
        operatorId: record.operatorId,
        appliedAt: now(),
      });
      this._finalize(record, CommandStatus.APPLIED, null);
    } catch (err) {
      this._finalize(record, CommandStatus.FAILED, err?.message ?? String(err));
    }
  }

  _finalize(record, status, reason) {
    record.status = status;
    record.reason = reason;
    record.terminalAt = now();
    record._resolve(this._recordSnapshot(record));
  }

  _recordSnapshot(record) {
    return {
      commandId: record.commandId,
      robotId: record.robotId,
      direction: record.direction,
      operatorId: record.operatorId,
      status: record.status,
      reason: record.reason,
      submittedAt: record.submittedAt,
      terminalAt: record.terminalAt,
      endToEndLatencyMs: record.terminalAt == null ? null : record.terminalAt - record.submittedAt,
    };
  }

  _checkIdle() {
    if (this._pending.length === 0 && this._activeCount === 0) {
      const waiters = this._idleWaiters;
      this._idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}

function validateCommand(command) {
  if (!command || typeof command !== 'object') return 'command must be an object';
  if (!command.robotId || typeof command.robotId !== 'string') return 'robotId is required';
  if (!command.operatorId || typeof command.operatorId !== 'string') return 'operatorId is required';
  if (!DIRECTIONS.includes(command.direction)) {
    return `direction must be one of ${DIRECTIONS.join(', ')}`;
  }
  return null;
}
