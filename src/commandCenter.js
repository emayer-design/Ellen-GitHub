// Command Queue Visibility and Conflict Handling — core engine.
//
// This module is the heart of the prototype. It makes the state of every route
// override command explicit (R1), exposes queue visibility (R2), suppresses
// duplicate resubmissions (R3), detects conflicting reroutes and escalates them
// (R4), and gives supervisors a prioritized console to resolve them (R5).
//
// The engine is deterministic and clock-injectable so it can be driven by the
// repro simulator (R6) and unit tests without relying on wall-clock time.

/** Canonical lifecycle states for a route override command (R1). */
export const CommandState = Object.freeze({
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const ACTIVE_STATES = new Set([CommandState.QUEUED, CommandState.PROCESSING]);
const TERMINAL_STATES = new Set([CommandState.COMPLETED, CommandState.FAILED]);

/**
 * Fingerprint used for duplicate detection (R3). Two submissions with the same
 * operator, robot, target route, and direction are considered the "same intent".
 */
function fingerprint({ operatorId, robotId, targetRoute, direction }) {
  return [operatorId, robotId, targetRoute, direction].join('::');
}

/**
 * Two active commands conflict (R4) when different operators target the SAME
 * robot with a different route or direction. This is the safety-adjacent case
 * called out in the signal ("two operators reroute the same robot in opposite
 * directions").
 */
function conflicts(a, b) {
  if (a.operatorId === b.operatorId) return false;
  if (a.robotId !== b.robotId) return false;
  return a.targetRoute !== b.targetRoute || a.direction !== b.direction;
}

export class CommandCenter {
  #clock;
  #dedupeWindowMs;
  #seq = 0;
  #escalationSeq = 0;

  constructor({ clock = () => Date.now(), dedupeWindowMs = 30_000 } = {}) {
    this.#clock = clock;
    this.#dedupeWindowMs = dedupeWindowMs;
    /** @type {Map<string, object>} id -> command */
    this.commands = new Map();
    /** @type {string[]} ids of commands eligible to be processed, in FIFO order */
    this.processable = [];
    /** @type {Map<string, object>} conflictId -> escalation */
    this.escalations = new Map();
    this.metrics = {
      submitted: 0,
      accepted: 0,
      duplicatesSuppressed: 0,
      conflictsDetected: 0,
    };
  }

  #now() {
    return this.#clock();
  }

  #activeCommands() {
    return [...this.commands.values()].filter((c) => ACTIVE_STATES.has(c.state));
  }

  /**
   * Submit a route override command. Returns a receipt that always tells the
   * operator exactly what happened — accepted, suppressed as a duplicate, or
   * held for a supervisor because of a conflict. This explicit feedback is what
   * stops the blind resubmission loop from the signal.
   */
  submit(input) {
    const { operatorId, robotId, targetRoute } = input;
    const direction = input.direction ?? 'forward';
    // Boundary validation: this is the system edge (operator input).
    if (!operatorId || !robotId || !targetRoute) {
      throw new Error('submit requires operatorId, robotId, and targetRoute');
    }

    const now = this.#now();
    this.metrics.submitted += 1;
    const fp = fingerprint({ operatorId, robotId, targetRoute, direction });

    // R3 — duplicate detection. If the same operator re-submits the same intent
    // while an identical command is still active (within the dedupe window),
    // collapse it onto the original instead of piling up the queue.
    const duplicateOf = this.#activeCommands().find(
      (c) => c.fingerprint === fp && now - c.submittedAt <= this.#dedupeWindowMs,
    );
    if (duplicateOf) {
      duplicateOf.suppressedResubmits += 1;
      this.metrics.duplicatesSuppressed += 1;
      return {
        accepted: false,
        reason: 'duplicate',
        id: duplicateOf.id,
        state: duplicateOf.state,
        deduplicatedOf: duplicateOf.id,
        message: `Already ${duplicateOf.state}. Your earlier command ${duplicateOf.id} is still in flight — no need to resubmit.`,
      };
    }

    const id = `cmd-${++this.#seq}`;
    const command = {
      id,
      operatorId,
      robotId,
      targetRoute,
      direction,
      fingerprint: fp,
      state: CommandState.QUEUED,
      submittedAt: now,
      updatedAt: now,
      blocked: false,
      conflictId: null,
      failureReason: null,
      suppressedResubmits: 0,
      history: [{ state: CommandState.QUEUED, at: now }],
    };
    this.commands.set(id, command);
    this.metrics.accepted += 1;

    // R4 — conflict detection against other active commands on the same robot.
    const conflicting = this.#activeCommands().filter(
      (c) => c.id !== id && conflicts(c, command),
    );
    if (conflicting.length > 0) {
      this.#escalate(command, conflicting, now);
      return {
        accepted: true,
        reason: 'conflict',
        id,
        state: command.state,
        blocked: true,
        conflictId: command.conflictId,
        message: `Conflicts with ${conflicting.length} active command(s) on ${robotId}. Held for supervisor review.`,
      };
    }

    this.processable.push(id);
    return {
      accepted: true,
      reason: 'queued',
      id,
      state: command.state,
      blocked: false,
      message: `Queued at position ${this.processable.length}.`,
    };
  }

  /** Create or extend a per-robot escalation and block every command in it (R4/R5). */
  #escalate(newCommand, conflictingActive, now) {
    // Group conflicts on the same robot into a single escalation.
    let escalation = [...this.escalations.values()].find(
      (e) => e.status === 'open' && e.robotId === newCommand.robotId,
    );
    if (!escalation) {
      const conflictId = `esc-${++this.#escalationSeq}`;
      escalation = {
        conflictId,
        robotId: newCommand.robotId,
        status: 'open',
        createdAt: now,
        commandIds: new Set(),
      };
      this.escalations.set(conflictId, escalation);
    }
    this.metrics.conflictsDetected += 1;

    for (const cmd of [newCommand, ...conflictingActive]) {
      this.#block(cmd, escalation.conflictId, now);
      escalation.commandIds.add(cmd.id);
    }
  }

  #block(command, conflictId, now) {
    if (TERMINAL_STATES.has(command.state)) return; // can't retract finished work
    command.blocked = true;
    command.conflictId = conflictId;
    command.updatedAt = now;
    // A blocked command must not be processed until a supervisor resolves it.
    this.processable = this.processable.filter((id) => id !== command.id);
  }

  /**
   * Move the next eligible (queued, unblocked) command into PROCESSING.
   * Returns the command, or null if nothing is processable.
   */
  processNext() {
    const id = this.processable.shift();
    if (!id) return null;
    const command = this.commands.get(id);
    this.#transition(command, CommandState.PROCESSING);
    return command;
  }

  /** Mark a processing command as completed (R1). */
  complete(id) {
    const command = this.#requireCommand(id);
    this.#transition(command, CommandState.COMPLETED);
    return command;
  }

  /** Mark a command as failed with a reason (R1). */
  fail(id, reason = 'unknown') {
    const command = this.#requireCommand(id);
    command.failureReason = reason;
    this.#transition(command, CommandState.FAILED);
    this.processable = this.processable.filter((cid) => cid !== id);
    return command;
  }

  #transition(command, nextState) {
    command.state = nextState;
    command.updatedAt = this.#now();
    command.history.push({ state: nextState, at: command.updatedAt });
  }

  #requireCommand(id) {
    const command = this.commands.get(id);
    if (!command) throw new Error(`unknown command: ${id}`);
    return command;
  }

  // --- Supervisor console (R5) ------------------------------------------------

  /** Open escalations, prioritized so supervisors see the worst ones first. */
  listEscalations() {
    return [...this.escalations.values()]
      .filter((e) => e.status === 'open')
      .map((e) => this.#escalationView(e))
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
  }

  #escalationView(escalation) {
    const commands = [...escalation.commandIds]
      .map((id) => this.commands.get(id))
      .sort((a, b) => a.submittedAt - b.submittedAt); // earliest first

    const operators = new Set(commands.map((c) => c.operatorId));
    const waitingMs = this.#now() - escalation.createdAt;
    // More operators fighting over one robot + longer waits = higher priority.
    const priority = operators.size * 100 + Math.floor(waitingMs / 1000);
    return {
      conflictId: escalation.conflictId,
      robotId: escalation.robotId,
      status: escalation.status,
      createdAt: escalation.createdAt,
      priority,
      operators: [...operators],
      commands: commands.map((c) => this.commandView(c)),
    };
  }

  /**
   * Supervisor resolves a conflict by choosing a winning command. The winner
   * returns to the processable queue; the others fail as superseded (R5).
   */
  resolveConflict(conflictId, winnerCommandId) {
    const escalation = this.escalations.get(conflictId);
    if (!escalation || escalation.status !== 'open') {
      throw new Error(`no open escalation: ${conflictId}`);
    }
    if (!escalation.commandIds.has(winnerCommandId)) {
      throw new Error(`command ${winnerCommandId} is not part of ${conflictId}`);
    }
    const now = this.#now();
    for (const id of escalation.commandIds) {
      const command = this.commands.get(id);
      if (id === winnerCommandId) {
        command.blocked = false;
        command.conflictId = null;
        command.updatedAt = now;
        if (command.state === CommandState.QUEUED) this.processable.push(id);
      } else if (!TERMINAL_STATES.has(command.state)) {
        this.fail(id, `superseded_by_supervisor (winner: ${winnerCommandId})`);
      }
    }
    escalation.status = 'resolved';
    escalation.resolvedAt = now;
    escalation.winnerCommandId = winnerCommandId;
    return this.#escalationView(escalation);
  }

  // --- Visibility (R2) --------------------------------------------------------

  commandView(command) {
    return {
      id: command.id,
      operatorId: command.operatorId,
      robotId: command.robotId,
      targetRoute: command.targetRoute,
      direction: command.direction,
      state: command.state,
      blocked: command.blocked,
      conflictId: command.conflictId,
      failureReason: command.failureReason,
      suppressedResubmits: command.suppressedResubmits,
      submittedAt: command.submittedAt,
      updatedAt: command.updatedAt,
    };
  }

  /** A full, operator-facing view of the queue and its health (R2). */
  snapshot() {
    const commands = [...this.commands.values()].map((c) => this.commandView(c));
    const byState = {
      [CommandState.QUEUED]: 0,
      [CommandState.PROCESSING]: 0,
      [CommandState.COMPLETED]: 0,
      [CommandState.FAILED]: 0,
    };
    for (const c of commands) byState[c.state] += 1;
    return {
      generatedAt: this.#now(),
      queueDepth: this.processable.length,
      byState,
      metrics: { ...this.metrics },
      commands,
      escalations: this.listEscalations(),
    };
  }
}

export const _internals = { fingerprint, conflicts };
