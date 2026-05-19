// ============================================================================
// Centralized Mode-Specific Validation
// ============================================================================

const VALID_MODES = [
  "1v1_ranked",
  "1v1_unranked",
  "2v2",
  "ffa",
  "duel_1v1",
  "squad_2v2",
  "team_3v3",
  "team_4v4",
  "team_5v5",
  "battle_royale",
  "2v1_unranked",
  "tournament",
  "test",
];

const MODE_PLAYER_COUNTS = {
  "1v1_ranked": { min: 2, max: 2 },
  "1v1_unranked": { min: 2, max: 2 },
  "duel_1v1": { min: 2, max: 2 },
  "2v2": { min: 2, max: 4 },
  "squad_2v2": { min: 2, max: 8 },
  // Ranges are intentionally lenient on the low end so the Team Builder can
  // run uneven battles (e.g. 3v2) under the nearest-size mode label.
  "team_3v3": { min: 2, max: 6 },
  "team_4v4": { min: 2, max: 8 },
  "team_5v5": { min: 2, max: 10 },
  "battle_royale": { min: 3, max: 20 },
  "ffa": { min: 2, max: 20 },
  "2v1_unranked": { min: 2, max: 3 },
  "tournament": { min: 2, max: 2 },
  "test": { min: 1, max: Infinity },
};

/**
 * Validates that a mode string is one of the recognized match modes.
 * @param {string} mode
 * @returns {{valid: boolean, errors?: string[]}}
 */
export function validateMatchMode(mode) {
  if (typeof mode !== "string" || !VALID_MODES.includes(mode)) {
    return {
      valid: false,
      errors: [`Invalid mode "${mode}". Must be one of: ${VALID_MODES.join(", ")}`],
    };
  }
  return { valid: true };
}

/**
 * Validates that the participant count is acceptable for the given mode.
 * @param {string} mode
 * @param {number} count
 * @returns {{valid: boolean, errors?: string[]}}
 */
export function validateParticipantCount(mode, count) {
  const modeResult = validateMatchMode(mode);
  if (!modeResult.valid) return modeResult;

  const range = MODE_PLAYER_COUNTS[mode];
  if (typeof count !== "number" || !Number.isInteger(count) || count < range.min || count > range.max) {
    const maxLabel = range.max === Infinity ? "+" : `-${range.max}`;
    return {
      valid: false,
      errors: [
        `Mode "${mode}" requires ${range.min}${range.min === range.max ? "" : maxLabel} participants, got ${count}`,
      ],
    };
  }
  return { valid: true };
}

/**
 * Validates a match configuration object.
 * @param {object} config
 * @returns {{valid: boolean, errors?: string[]}}
 */
export function validateMatchConfig(config) {
  const errors = [];

  if (config == null || typeof config !== "object") {
    return { valid: false, errors: ["Config must be a non-null object"] };
  }

  // mode
  if (typeof config.mode !== "string") {
    errors.push("config.mode must be a string");
  } else {
    const modeResult = validateMatchMode(config.mode);
    if (!modeResult.valid) errors.push(...modeResult.errors);
  }

  // arenaWidth
  if (typeof config.arenaWidth !== "number" || !Number.isFinite(config.arenaWidth) || config.arenaWidth <= 0) {
    errors.push("config.arenaWidth must be a positive number");
  }

  // arenaHeight
  if (typeof config.arenaHeight !== "number" || !Number.isFinite(config.arenaHeight) || config.arenaHeight <= 0) {
    errors.push("config.arenaHeight must be a positive number");
  }

  // maxTicks
  if (typeof config.maxTicks !== "number" || !Number.isInteger(config.maxTicks) || config.maxTicks <= 0) {
    errors.push("config.maxTicks must be a positive integer");
  }

  // tickRate
  if (typeof config.tickRate !== "number" || !Number.isInteger(config.tickRate) || config.tickRate <= 0) {
    errors.push("config.tickRate must be a positive integer");
  }

  // seed
  if (typeof config.seed !== "number" || !Number.isInteger(config.seed) || config.seed < 0) {
    errors.push("config.seed must be a non-negative integer");
  }

  // arenaId is OPTIONAL. When present, it must be a non-empty string. Unknown
  // ids are not rejected here — getArenaPreset() falls back to the default, so
  // replays with stale preset ids still load cleanly.
  if (config.arenaId !== undefined && config.arenaId !== null) {
    if (typeof config.arenaId !== "string" || config.arenaId.length === 0) {
      errors.push("config.arenaId must be a non-empty string when provided");
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * Validates a single participant object.
 * @param {object} participant
 * @returns {{valid: boolean, errors?: string[]}}
 */
export function validateParticipant(participant) {
  const errors = [];

  if (participant == null || typeof participant !== "object") {
    return { valid: false, errors: ["Participant must be a non-null object"] };
  }

  // program
  if (participant.program == null || typeof participant.program !== "object") {
    errors.push("participant.program must be an object");
  } else {
    const bytecode = participant.program.bytecode;
    const isBytecodeArray = Array.isArray(bytecode)
      || (ArrayBuffer.isView(bytecode) && !(bytecode instanceof DataView));
    if (!isBytecodeArray) {
      errors.push("participant.program.bytecode must be an array or typed array");
    } else if (bytecode.length > 65535) {
      errors.push("participant.program.bytecode exceeds maximum size of 65535 bytes");
    }
    if (!Array.isArray(participant.program.stateSlots)) {
      errors.push("participant.program.stateSlots must be an array");
    }
    if (participant.program.eventHandlers == null || typeof participant.program.eventHandlers !== "object") {
      errors.push("participant.program.eventHandlers must be an object or Map");
    } else if (!(participant.program.eventHandlers instanceof Map) && typeof participant.program.eventHandlers.get !== "function") {
      errors.push("participant.program.eventHandlers must be a Map (with .get() method)");
    }
  }

  // constants
  if (!Array.isArray(participant.constants)) {
    errors.push("participant.constants must be an array");
  }

  // playerId
  if (typeof participant.playerId !== "string" || participant.playerId.length === 0) {
    errors.push("participant.playerId must be a non-empty string");
  }

  // teamId
  if (typeof participant.teamId !== "number" || !Number.isInteger(participant.teamId) || participant.teamId < 0) {
    errors.push("participant.teamId must be a non-negative integer");
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * Validates a full match request (config + participants).
 * @param {object} request
 * @returns {{valid: boolean, errors?: string[]}}
 */
export function validateMatchRequest(request) {
  const errors = [];

  if (request == null || typeof request !== "object") {
    return { valid: false, errors: ["Request must be a non-null object"] };
  }

  // Validate config
  const configResult = validateMatchConfig(request.config);
  if (!configResult.valid) errors.push(...configResult.errors);

  // Validate participants array exists
  if (!Array.isArray(request.participants)) {
    errors.push("request.participants must be an array");
  } else {
    // Validate each participant
    for (let i = 0; i < request.participants.length; i++) {
      const pResult = validateParticipant(request.participants[i]);
      if (!pResult.valid) {
        for (const err of pResult.errors) {
          errors.push(`participants[${i}]: ${err}`);
        }
      }
    }

    // Check for duplicate playerIds
    const playerIds = new Set();
    for (const p of request.participants) {
      if (p && p.playerId) {
        if (playerIds.has(p.playerId)) {
          errors.push(`Duplicate playerId '${p.playerId}'`);
        }
        playerIds.add(p.playerId);
      }
    }

    // Validate participant count against mode
    if (configResult.valid) {
      const countResult = validateParticipantCount(request.config.mode, request.participants.length);
      if (!countResult.valid) errors.push(...countResult.errors);
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}
