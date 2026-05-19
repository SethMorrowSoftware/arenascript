// ============================================================================
// Combat Resolution — Attacks, damage, abilities, projectiles
// ============================================================================

import { distance, normalize, sub, scale, add, vec2 } from "../shared/vec2.js";
import { getVisibleEnemies, hasLineOfSight } from "./los.js";
import {
  CLASS_STATS, ATTACK_DAMAGE, ATTACK_RANGE, ATTACK_COOLDOWN, ATTACK_ENERGY_COST,
  FIRE_AT_DAMAGE, FIRE_AT_RANGE, FIRE_AT_COOLDOWN, PROJECTILE_SPEED, PROJECTILE_TTL,
  ROBOT_RADIUS, PROJECTILE_RADIUS, PROJECTILE_SUBSTEP_DISTANCE,
  BURST_FIRE_DAMAGE, BURST_FIRE_RANGE, BURST_FIRE_COOLDOWN, BURST_FIRE_ENERGY_COST,
  GRENADE_DAMAGE, GRENADE_RADIUS, GRENADE_RANGE, GRENADE_COOLDOWN, GRENADE_ENERGY_COST,
  SHIELD_DURATION, SHIELD_COOLDOWN, SHIELD_ENERGY_COST, LOW_HEALTH_THRESHOLD,
  PICKUP_DAMAGE_MULTIPLIER,
  HEAT_MAX, HEAT_RECOVERY_THRESHOLD, HEAT_DECAY_PER_TICK,
  HEAT_ATTACK, HEAT_FIRE_AT, HEAT_FIRE_LIGHT, HEAT_FIRE_HEAVY, HEAT_BURST_FIRE,
  HEAT_GRENADE, HEAT_SHIELD, HEAT_ZAP, HEAT_CLOAK_PER_TICK,
  AMMO_FIRE_AT, AMMO_FIRE_LIGHT, AMMO_FIRE_HEAVY, AMMO_BURST_FIRE, AMMO_GRENADE,
  FIRE_LIGHT_DAMAGE, FIRE_LIGHT_RANGE, FIRE_LIGHT_SPEED, FIRE_LIGHT_COOLDOWN,
  FIRE_HEAVY_DAMAGE, FIRE_HEAVY_RANGE, FIRE_HEAVY_SPEED, FIRE_HEAVY_COOLDOWN,
  ZAP_RADIUS, ZAP_DAMAGE, ZAP_SELF_DAMAGE, ZAP_COOLDOWN, ZAP_ENERGY_COST,
} from "../shared/config.js";

/** Add heat to a robot, clamping to HEAT_MAX and setting overheated flag. */
function addHeat(robot, amount) {
  robot.heat = Math.min(HEAT_MAX, (robot.heat ?? 0) + amount);
  if (robot.heat >= HEAT_MAX) {
    robot.overheated = true;
  }
}

/** Returns true if robot can fire — not overheated and has enough ammo. */
function canFire(robot, ammoCost) {
  if (robot.overheated) return false;
  if ((robot.ammo ?? 0) < ammoCost) return false;
  return true;
}

function consumeAmmo(robot, amount) {
  robot.ammo = Math.max(0, (robot.ammo ?? 0) - amount);
}

/** Break cloak when robot acts offensively or takes damage. */
function breakCloak(robot) {
  if (robot.cloakActive) {
    robot.cloakActive = false;
    robot.cloakExpiresTick = 0;
  }
}

/** Resolve a combat action for a robot */
export function resolveCombat(world, robot, action) {
  if (!action || !robot.alive) return;

  const stats = CLASS_STATS[robot.class];

  switch (action.type) {
    case "attack": {
      const targetId = resolveTargetId(world, action);
      if (!targetId) break;
      const target = world.getRobot(targetId);
      if (!target || !target.alive) break;
      if (robot.overheated) break;
      const visibleEnemyIds = new Set(getVisibleEnemies(world, robot).map(enemy => enemy.id));
      if (!visibleEnemyIds.has(target.id)) break;

      const range = stats?.attackRange ?? ATTACK_RANGE;
      if (distance(robot.position, target.position) > range) break;

      const cd = robot.cooldowns.get("attack") ?? 0;
      if (cd > 0) break;

      let damage = stats?.attackDamage ?? ATTACK_DAMAGE;
      const cooldown = stats?.attackCooldown ?? ATTACK_COOLDOWN;
      // Apply damage pickup effect
      if (robot.activeEffects?.some(e => e.type === "damage")) {
        damage = Math.round(damage * PICKUP_DAMAGE_MULTIPLIER);
      }

      applyDamage(world, target, damage, robot.id);
      robot.cooldowns.set("attack", cooldown);
      robot.energy = Math.max(0, robot.energy - ATTACK_ENERGY_COST);
      addHeat(robot, HEAT_ATTACK);
      breakCloak(robot);

      // Face the target
      const dir = normalize(sub(target.position, robot.position));
      robot.heading = dir;
      break;
    }

    case "fire_at": {
      const targetPos = resolveTargetPosition(world, action);
      if (!targetPos) break;
      if (!canFire(robot, AMMO_FIRE_AT)) break;
      if (!hasLineOfSight(world, robot.position, targetPos)) break;

      if (distance(robot.position, targetPos) > FIRE_AT_RANGE) break;

      const cd = robot.cooldowns.get("attack") ?? 0;
      if (cd > 0) break;

      const dir = normalize(sub(targetPos, robot.position));
      const vel = scale(dir, PROJECTILE_SPEED);
      let fireAtDmg = FIRE_AT_DAMAGE;
      if (robot.activeEffects?.some(e => e.type === "damage")) {
        fireAtDmg = Math.round(fireAtDmg * PICKUP_DAMAGE_MULTIPLIER);
      }
      world.spawnProjectile(robot.id, { ...robot.position }, vel, fireAtDmg, PROJECTILE_TTL);

      robot.cooldowns.set("attack", FIRE_AT_COOLDOWN);
      robot.energy = Math.max(0, robot.energy - ATTACK_ENERGY_COST);
      consumeAmmo(robot, AMMO_FIRE_AT);
      addHeat(robot, HEAT_FIRE_AT);
      breakCloak(robot);
      robot.heading = dir;
      break;
    }

    case "fire_light": {
      // Rapid, low-damage, long-range, fast-travelling projectile
      const targetPos = resolveTargetPosition(world, action);
      if (!targetPos) break;
      if (!canFire(robot, AMMO_FIRE_LIGHT)) break;
      if (!hasLineOfSight(world, robot.position, targetPos)) break;
      if (distance(robot.position, targetPos) > FIRE_LIGHT_RANGE) break;
      const cd = robot.cooldowns.get("attack") ?? 0;
      if (cd > 0) break;

      const dir = normalize(sub(targetPos, robot.position));
      const vel = scale(dir, FIRE_LIGHT_SPEED);
      let dmg = FIRE_LIGHT_DAMAGE;
      if (robot.activeEffects?.some(e => e.type === "damage")) {
        dmg = Math.round(dmg * PICKUP_DAMAGE_MULTIPLIER);
      }
      world.spawnProjectile(robot.id, { ...robot.position }, vel, dmg, PROJECTILE_TTL);
      robot.cooldowns.set("attack", FIRE_LIGHT_COOLDOWN);
      robot.energy = Math.max(0, robot.energy - Math.floor(ATTACK_ENERGY_COST / 2));
      consumeAmmo(robot, AMMO_FIRE_LIGHT);
      addHeat(robot, HEAT_FIRE_LIGHT);
      breakCloak(robot);
      robot.heading = dir;
      break;
    }

    case "fire_heavy": {
      // Slow, high-damage, harder-to-dodge but expensive
      const targetPos = resolveTargetPosition(world, action);
      if (!targetPos) break;
      if (!canFire(robot, AMMO_FIRE_HEAVY)) break;
      if (!hasLineOfSight(world, robot.position, targetPos)) break;
      if (distance(robot.position, targetPos) > FIRE_HEAVY_RANGE) break;
      const cd = robot.cooldowns.get("attack") ?? 0;
      if (cd > 0) break;

      const dir = normalize(sub(targetPos, robot.position));
      const vel = scale(dir, FIRE_HEAVY_SPEED);
      let dmg = FIRE_HEAVY_DAMAGE;
      if (robot.activeEffects?.some(e => e.type === "damage")) {
        dmg = Math.round(dmg * PICKUP_DAMAGE_MULTIPLIER);
      }
      // Heavy rounds live longer so their slower velocity still reaches distant targets.
      world.spawnProjectile(robot.id, { ...robot.position }, vel, dmg, PROJECTILE_TTL * 2);
      robot.cooldowns.set("attack", FIRE_HEAVY_COOLDOWN);
      robot.energy = Math.max(0, robot.energy - ATTACK_ENERGY_COST * 2);
      consumeAmmo(robot, AMMO_FIRE_HEAVY);
      addHeat(robot, HEAT_FIRE_HEAVY);
      breakCloak(robot);
      robot.heading = dir;
      break;
    }

    case "burst_fire": {
      const targetPos = resolveTargetPosition(world, action);
      if (!targetPos) break;
      if (!canFire(robot, AMMO_BURST_FIRE)) break;
      if (!hasLineOfSight(world, robot.position, targetPos)) break;
      if (distance(robot.position, targetPos) > BURST_FIRE_RANGE) break;
      const cd = robot.cooldowns.get("attack") ?? 0;
      if (cd > 0) break;

      const baseDir = normalize(sub(targetPos, robot.position));
      let burstDmg = BURST_FIRE_DAMAGE;
      if (robot.activeEffects?.some(e => e.type === "damage")) {
        burstDmg = Math.round(burstDmg * PICKUP_DAMAGE_MULTIPLIER);
      }
      const spread = [0, -0.12, 0.12];
      for (const s of spread) {
        const dir = normalize({ x: baseDir.x - (baseDir.y * s), y: baseDir.y + (baseDir.x * s) });
        const vel = scale(dir, PROJECTILE_SPEED);
        world.spawnProjectile(robot.id, { ...robot.position }, vel, burstDmg, PROJECTILE_TTL);
      }
      robot.cooldowns.set("attack", BURST_FIRE_COOLDOWN);
      robot.energy = Math.max(0, robot.energy - BURST_FIRE_ENERGY_COST);
      consumeAmmo(robot, AMMO_BURST_FIRE);
      addHeat(robot, HEAT_BURST_FIRE);
      breakCloak(robot);
      robot.heading = baseDir;
      break;
    }

    case "grenade": {
      const targetPos = resolveTargetPosition(world, action);
      if (!targetPos) break;
      if (!canFire(robot, AMMO_GRENADE)) break;
      if (distance(robot.position, targetPos) > GRENADE_RANGE) break;
      const cd = robot.cooldowns.get("attack") ?? 0;
      if (cd > 0) break;
      let grenadeDmg = GRENADE_DAMAGE;
      if (robot.activeEffects?.some(e => e.type === "damage")) {
        grenadeDmg = Math.round(grenadeDmg * PICKUP_DAMAGE_MULTIPLIER);
      }
      for (const other of world.getAliveRobots()) {
        if (other.teamId === robot.teamId) continue;
        if (distance(other.position, targetPos) <= GRENADE_RADIUS) {
          applyDamage(world, other, grenadeDmg, robot.id);
        }
      }
      // Damage destructible cover in blast radius
      const coversToRemove = [];
      for (const [coverId, cover] of world.covers) {
        if (!cover.destructible) continue;
        if (distance(cover.position, targetPos) <= GRENADE_RADIUS) {
          cover.health -= GRENADE_DAMAGE;
          if (cover.health <= 0) {
            coversToRemove.push(coverId);
          }
        }
      }
      for (const id of coversToRemove) {
        world.covers.delete(id);
      }
      robot.cooldowns.set("attack", GRENADE_COOLDOWN);
      robot.energy = Math.max(0, robot.energy - GRENADE_ENERGY_COST);
      consumeAmmo(robot, AMMO_GRENADE);
      addHeat(robot, HEAT_GRENADE);
      breakCloak(robot);
      robot.heading = normalize(sub(targetPos, robot.position));
      break;
    }

    case "zap": {
      // Short-range energy discharge. Hits all enemies in radius, damages self.
      const cd = robot.cooldowns.get("zap") ?? 0;
      if (cd > 0) break;
      if (robot.energy < ZAP_ENERGY_COST) break;
      if (robot.overheated) break;
      let hit = 0;
      for (const other of world.getAliveRobots()) {
        if (other.teamId === robot.teamId) continue;
        if (distance(other.position, robot.position) <= ZAP_RADIUS) {
          applyDamage(world, other, ZAP_DAMAGE, robot.id);
          hit++;
        }
      }
      // Self-damage regardless of whether anyone was hit (prevents spam)
      applyDamage(world, robot, ZAP_SELF_DAMAGE, robot.id);
      robot.cooldowns.set("zap", ZAP_COOLDOWN);
      robot.energy = Math.max(0, robot.energy - ZAP_ENERGY_COST);
      addHeat(robot, HEAT_ZAP);
      breakCloak(robot);
      break;
    }

    case "shield": {
      const cd = robot.cooldowns.get("shield") ?? 0;
      if (cd > 0) break;
      // Apply shield as a health restore capped at maxHealth (roughly 20% of base)
      const shieldHeal = Math.round(robot.maxHealth * 0.2);
      robot.health = Math.min(robot.maxHealth, robot.health + shieldHeal);
      robot.cooldowns.set("shield", SHIELD_COOLDOWN);
      robot.energy = Math.max(0, robot.energy - SHIELD_ENERGY_COST);
      addHeat(robot, HEAT_SHIELD);
      break;
    }

    case "vent_heat": {
      // Spend the combat slot this tick cooling aggressively. Applied in updateCooldowns.
      robot.ventingHeat = true;
      break;
    }

    case "use_ability": {
      // Simplified ability system for PoC
      break;
    }
  }
}

/** Apply damage to a robot, emit events */
export function applyDamage(world, target, damage, sourceId) {
  target.health -= damage;
  // Taking damage breaks cloak.
  if (target.cloakActive) {
    target.cloakActive = false;
    target.cloakExpiresTick = 0;
  }

  // Record direction to attacker so the `damage_direction` sensor can
  // surface a stable vector for a few ticks after the hit. We point
  // FROM the target TOWARD the attacker (so bots can either retreat
  // along -v or strafe perpendicular).
  const source = sourceId ? world.getRobot(sourceId) : null;
  if (source && source.alive) {
    const dx = source.position.x - target.position.x;
    const dy = source.position.y - target.position.y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) {
      target.memory.lastDamage = {
        tick: world.currentTick,
        dirX: dx / len,
        dirY: dy / len,
        sourceId,
      };
    }
  }

  world.emitEvent({
    type: "damaged",
    tick: world.currentTick,
    robotId: target.id,
    data: { damage, sourceId },
  });

  const healthBefore = target.health + damage;
  if (target.health <= LOW_HEALTH_THRESHOLD && target.health > 0 && healthBefore > LOW_HEALTH_THRESHOLD) {
    world.emitEvent({
      type: "low_health",
      tick: world.currentTick,
      robotId: target.id,
      data: { health: target.health },
    });
  }

  if (target.health <= 0) {
    target.health = 0;
    target.alive = false;
    world.emitEvent({
      type: "destroyed",
      tick: world.currentTick,
      robotId: target.id,
      data: { killedBy: sourceId },
    });
  }
}

/** Update projectiles — move and check collisions */
export function updateProjectiles(world) {
  const toRemove = [];
  const hitRadius = ROBOT_RADIUS + PROJECTILE_RADIUS;

  for (const [id, proj] of world.projectiles) {
    const owner = world.getRobot(proj.ownerId);

    // Advance the projectile in steps no larger than PROJECTILE_SUBSTEP_DISTANCE
    // so fast rounds cannot tunnel through a robot or a thin wall between
    // ticks. Collision is checked at every substep.
    const speed = Math.hypot(proj.velocity.x, proj.velocity.y);
    const steps = Math.max(1, Math.ceil(speed / PROJECTILE_SUBSTEP_DISTANCE));
    const stepVel = { x: proj.velocity.x / steps, y: proj.velocity.y / steps };
    let consumed = false;

    for (let s = 0; s < steps && !consumed; s++) {
      proj.position = add(proj.position, stepVel);

      // Out of bounds
      if (
        proj.position.x < 0 || proj.position.x > world.config.arenaWidth ||
        proj.position.y < 0 || proj.position.y > world.config.arenaHeight
      ) {
        toRemove.push(id);
        consumed = true;
        break;
      }

      // Cover (projectiles blocked by walls)
      for (const cover of world.covers.values()) {
        const halfW = cover.width / 2;
        const halfH = cover.height / 2;
        if (proj.position.x >= cover.position.x - halfW && proj.position.x <= cover.position.x + halfW &&
            proj.position.y >= cover.position.y - halfH && proj.position.y <= cover.position.y + halfH) {
          toRemove.push(id);
          consumed = true;
          break;
        }
      }
      if (consumed) break;

      // Robots (friendly fire disabled)
      for (const robot of world.robots.values()) {
        if (!robot.alive) continue;
        if (robot.id === proj.ownerId) continue;
        if (owner && owner.teamId === robot.teamId) continue;
        if (distance(proj.position, robot.position) < hitRadius) {
          applyDamage(world, robot, proj.damage, proj.ownerId);
          toRemove.push(id);
          consumed = true;
          break;
        }
      }
    }

    if (consumed) continue;

    // Survived the move — age it; expire when TTL runs out.
    proj.ttl--;
    if (proj.ttl <= 0) {
      toRemove.push(id);
    }
  }

  for (const id of toRemove) {
    world.projectiles.delete(id);
  }
}

/** Update cooldowns for all robots. Also handles heat decay and cloak upkeep. */
export function updateCooldowns(world) {
  for (const robot of world.robots.values()) {
    if (!robot.alive) continue;
    for (const [action, ticks] of robot.cooldowns) {
      if (ticks > 0) {
        robot.cooldowns.set(action, ticks - 1);
      }
    }
    // Regenerate energy slightly
    robot.energy = Math.min(robot.maxEnergy, robot.energy + 1);

    // --- Heat decay ---
    const dissipation = robot.heatDissipation ?? 1.0;
    let decay = HEAT_DECAY_PER_TICK * dissipation;
    if (robot.ventingHeat) {
      decay += 6; // extra cooling when venting
      robot.ventingHeat = false;
    }
    robot.heat = Math.max(0, (robot.heat ?? 0) - decay);
    // Overheat recovery: must cool below the threshold before re-enabling combat.
    if (robot.overheated && robot.heat <= HEAT_RECOVERY_THRESHOLD) {
      robot.overheated = false;
    }

    // --- Cloak upkeep ---
    if (robot.cloakActive) {
      if (world.currentTick >= robot.cloakExpiresTick || robot.energy <= 0) {
        robot.cloakActive = false;
        robot.cloakExpiresTick = 0;
      } else {
        robot.energy = Math.max(0, robot.energy - 1);
        robot.heat = Math.min(HEAT_MAX, robot.heat + HEAT_CLOAK_PER_TICK);
      }
    }
  }
}

// --- Helpers ---

function resolveTargetId(world, action) {
  if (!action.target) return null;
  if (typeof action.target === "string") return action.target;
  // If target is a position-like object with id
  if (typeof action.target === "object" && "id" in action.target) {
    return action.target.id;
  }
  return null;
}

function resolveTargetPosition(world, action) {
  const target = action.target;
  if (target == null) return null;
  if (typeof target === "string") {
    const robot = world.getRobot(target);
    if (robot) return robot.position;
    return null;
  }
  if (typeof target !== "object") return null;
  if ("x" in target && "y" in target) {
    return target;
  }
  // Sensor objects often include { id, position, ... }
  if ("position" in target && target.position &&
      typeof target.position === "object" &&
      "x" in target.position && "y" in target.position) {
    return target.position;
  }
  return null;
}
