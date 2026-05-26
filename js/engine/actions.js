// ============================================================================
// Action Gateway — Intent collection and validation
// ============================================================================

import {
  CLASS_STATS, ATTACK_COOLDOWN, ATTACK_ENERGY_COST,
  BURST_FIRE_ENERGY_COST, GRENADE_ENERGY_COST, SHIELD_ENERGY_COST,
  ZAP_ENERGY_COST, AMMO_FIRE_AT, AMMO_FIRE_LIGHT, AMMO_FIRE_HEAVY,
  AMMO_BURST_FIRE, AMMO_GRENADE,
} from "../shared/config.js";

export function normalizeActionIntent(intent) {
  if (!intent || typeof intent !== "object") return intent;
  return { ...intent };
}

/** Validate and collect action intents from a robot */
export function validateAction(intent, robot) {
  const normalized = normalizeActionIntent(intent);

  if (!robot.alive) {
    return { intent: normalized, valid: false, reason: "Robot is destroyed" };
  }

  switch (normalized.type) {
    case "attack":
    case "fire_at":
    case "fire_light":
    case "fire_heavy":
    case "burst_fire":
    case "grenade": {
      const cd = robot.cooldowns.get("attack") ?? 0;
      if (cd > 0) {
        return { intent: normalized, valid: false, reason: `Attack on cooldown (${cd} ticks remaining)` };
      }
      if (robot.overheated) {
        return { intent: normalized, valid: false, reason: "Overheated — cannot fire" };
      }
      const energyCosts = {
        attack: ATTACK_ENERGY_COST,
        fire_at: ATTACK_ENERGY_COST,
        fire_light: Math.floor(ATTACK_ENERGY_COST / 2),
        fire_heavy: ATTACK_ENERGY_COST * 2,
        burst_fire: BURST_FIRE_ENERGY_COST,
        grenade: GRENADE_ENERGY_COST,
      };
      const ammoCosts = {
        attack: 0,
        fire_at: AMMO_FIRE_AT,
        fire_light: AMMO_FIRE_LIGHT,
        fire_heavy: AMMO_FIRE_HEAVY,
        burst_fire: AMMO_BURST_FIRE,
        grenade: AMMO_GRENADE,
      };
      const requiredEnergy = energyCosts[normalized.type] ?? ATTACK_ENERGY_COST;
      if (robot.energy < requiredEnergy) {
        return { intent: normalized, valid: false, reason: "Insufficient energy" };
      }
      const requiredAmmo = ammoCosts[normalized.type] ?? 0;
      if (requiredAmmo > 0 && (robot.ammo ?? 0) < requiredAmmo) {
        return { intent: normalized, valid: false, reason: "Out of ammo" };
      }
      return { intent: normalized, valid: true };
    }

    case "zap": {
      const cd = robot.cooldowns.get("zap") ?? 0;
      if (cd > 0) {
        return { intent: normalized, valid: false, reason: `Zap on cooldown (${cd} ticks remaining)` };
      }
      if (robot.energy < ZAP_ENERGY_COST) {
        return { intent: normalized, valid: false, reason: "Insufficient energy for zap" };
      }
      if (robot.overheated) {
        return { intent: normalized, valid: false, reason: "Overheated — cannot zap" };
      }
      return { intent: normalized, valid: true };
    }

    case "vent_heat":
      return { intent: normalized, valid: true };

    case "shield": {
      const cd = robot.cooldowns.get("shield") ?? 0;
      if (cd > 0) {
        return { intent: normalized, valid: false, reason: `Shield on cooldown (${cd} ticks remaining)` };
      }
      if (robot.energy < SHIELD_ENERGY_COST) {
        return { intent: normalized, valid: false, reason: "Insufficient energy for shield" };
      }
      return { intent: normalized, valid: true };
    }

    case "move_to":
    case "move_toward":
    case "move_forward":
    case "move_backward":
    case "turn_left":
    case "turn_right":
    case "strafe_left":
    case "strafe_right":
    case "stop":
    case "retreat":
    case "cloak":
    case "self_destruct":
    case "place_mine":
    case "send_signal":
    case "mark_position":
    case "taunt":
    case "overwatch":
      return { intent: normalized, valid: true };

    default:
      return { intent: normalized, valid: false, reason: `Unknown action type: ${normalized.type}` };
  }
}

/** Separate movement and combat actions (per spec: one of each per tick) */
export function categorizeActions(actions) {
  const movementTypes = new Set([
    "move_to", "move_toward", "move_forward", "move_backward",
    "turn_left", "turn_right", "strafe_left", "strafe_right", "stop", "retreat",
  ]);
  const combatTypes = new Set([
    "attack", "fire_at", "fire_light", "fire_heavy", "burst_fire", "grenade",
    "shield", "zap", "vent_heat",
  ]);
  const utilityTypes = new Set([
    "place_mine", "send_signal", "mark_position", "taunt", "overwatch",
    "cloak", "self_destruct",
  ]);

  let movement = null;
  let combat = null;
  let utility = null;

  for (const rawAction of actions) {
    const action = normalizeActionIntent(rawAction);
    if (movementTypes.has(action.type) && !movement) {
      movement = action;
    } else if (combatTypes.has(action.type) && !combat) {
      combat = action;
    } else if (utilityTypes.has(action.type) && !utility) {
      utility = action;
    }
  }

  return { movement, combat, utility };
}
