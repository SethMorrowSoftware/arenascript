// ============================================================================
// Sensor Gateway — Read-only perception layer for robots
// ============================================================================

import { getVisibleEnemies, getVisibleAllies, hasLineOfSight } from "./los.js";
import { distance } from "../shared/vec2.js";
import {
  ACTIVE_SCAN_MEMORY_TICKS,
  ACTIVE_SCAN_RANGE,
  ATTACK_RANGE,
  CLASS_STATS,
  DEFAULT_VISION_RANGE,
  MINE_VISIBLE_RANGE,
  NOISE_DECAY_TICKS,
  CLOAK_BREAK_DISTANCE,
  HEAT_MAX,
  HEAT_RECOVERY_THRESHOLD,
} from "../shared/config.js";

/** Convert a RobotState to a safe VM-visible object */
function robotToSensorView(robot) {
  return {
    id: robot.id,
    position: { x: robot.position.x, y: robot.position.y },
    health: robot.health,
    heading: { x: robot.heading.x, y: robot.heading.y },
    // Velocity exposure is deliberately coarse — floored to 2 decimals so
    // tiny per-tick jitter doesn't leak determinism fingerprints, but
    // fast enough for bots to lead shots and dodge.
    velocity: {
      x: Math.round((robot.velocity?.x ?? 0) * 100) / 100,
      y: Math.round((robot.velocity?.y ?? 0) * 100) / 100,
    },
    class: robot.class,
  };
}

/** Coerce any VM-visible value to a finite number (0 fallback to avoid NaN leaks). */
function toNum(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return v;
}

/** Readable stringification for log() output — mirrors VM.stringify for consistency. */
function logValueToString(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "0";
    return Number.isInteger(v) ? v.toString() : v.toFixed(2);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `[list x${v.length}]`;
  if (v && typeof v === "object") {
    if ("x" in v && "y" in v) return `(${logValueToString(v.x)}, ${logValueToString(v.y)})`;
    if (v.id) return `<${v.id}>`;
    return "<object>";
  }
  return String(v);
}

/** Extract an {x,y} position from a raw vec, a sensor view, or null. */
function extractPosition(v) {
  if (v == null || typeof v !== "object") return null;
  if ("x" in v && "y" in v && typeof v.x === "number" && typeof v.y === "number") {
    return { x: v.x, y: v.y };
  }
  if ("position" in v && v.position && typeof v.position === "object" &&
      "x" in v.position && "y" in v.position) {
    return { x: v.position.x, y: v.position.y };
  }
  return null;
}

/**
 * Create the sensor gateway for a given world.
 *
 * @param {World} world
 * @param {object} [options]
 * @param {Array} [options.logs] — if provided, log() calls push entries here
 *   as { robotId, robotName, tick, message } tuples. The tick loop surfaces
 *   them to the UI console after the match finishes so bot authors can trace
 *   their state machines without leaving the editor.
 */
export function createSensorGateway(world, options = {}) {
  const logSink = options.logs ?? null;
  const mapRobotView = (targetRobot) => robotToSensorView(targetRobot);
  const scanEnemies = (robot, range) => {
    const detected = [];
    for (const other of world.robots.values()) {
      if (!other.alive) continue;
      if (other.teamId === robot.teamId) continue;
      const d = distance(robot.position, other.position);
      if (d > range) continue;
      // Cloaked enemies don't show up on scan beyond point-blank range
      if (other.cloakActive && d > CLOAK_BREAK_DISTANCE) continue;
      // Scan still requires line of sight (no wallhack)
      if (!hasLineOfSight(world, robot.position, other.position)) continue;
      detected.push(other);
    }
    detected.sort((a, b) => distance(robot.position, a.position) - distance(robot.position, b.position));
    if (detected.length > 0) {
      const nearest = detected[0];
      robot.memory.lastSeenEnemy = {
        id: nearest.id,
        position: { x: nearest.position.x, y: nearest.position.y },
        tick: world.currentTick,
      };
    }
    return detected.map(mapRobotView);
  };

  return (robotId, sensorName, args) => {
    const robot = world.getRobot(robotId);
    if (!robot || !robot.alive) return null;

    switch (sensorName) {
      case "enemy_visible":
        return getVisibleEnemies(world, robot).length > 0;

      case "random": {
        const min = Number(args[0] ?? 0);
        const max = Number(args[1] ?? 100);
        const low = Math.min(min, max);
        const high = Math.max(min, max);
        return Math.floor(world.rng.nextFloat(low, high + 1));
      }

      case "damage_percent":
        return (robot.maxHealth ?? 0) <= 0
          ? 0
          : Math.round(((robot.maxHealth - robot.health) / robot.maxHealth) * 100);

      case "wall_ahead": {
        const lookahead = Math.max(0, Number(args[0] ?? 3));
        const p = {
          x: robot.position.x + (robot.heading.x * lookahead),
          y: robot.position.y + (robot.heading.y * lookahead),
        };
        if (p.x <= 0 || p.x >= world.config.arenaWidth || p.y <= 0 || p.y >= world.config.arenaHeight) {
          return true;
        }
        for (const cover of world.covers.values()) {
          const halfW = cover.width / 2;
          const halfH = cover.height / 2;
          const inX = p.x >= cover.position.x - halfW && p.x <= cover.position.x + halfW;
          const inY = p.y >= cover.position.y - halfH && p.y <= cover.position.y + halfH;
          if (inX && inY) return true;
        }
        return false;
      }

      // --- Self Sensors ---
      case "health":
        return robot.health;

      case "max_health":
        return robot.maxHealth;

      case "energy":
        return robot.energy;

      // --- Resource Economy ---
      case "heat":
        return Math.round(robot.heat ?? 0);
      case "max_heat":
        return HEAT_MAX;
      case "heat_percent":
        return Math.round(((robot.heat ?? 0) / HEAT_MAX) * 100);
      case "overheated":
        return !!robot.overheated;
      case "ammo":
        return robot.ammo ?? 0;
      case "max_ammo":
        return robot.maxAmmo ?? 0;
      case "ammo_percent":
        return (robot.maxAmmo ?? 0) === 0 ? 0 : Math.round(((robot.ammo ?? 0) / robot.maxAmmo) * 100);

      // --- Cloak state ---
      case "is_cloaked":
        return !!robot.cloakActive;
      case "cloak_remaining":
        return robot.cloakActive ? Math.max(0, robot.cloakExpiresTick - world.currentTick) : 0;

      // --- Shield state ---
      case "is_shielded":
        return (robot.shieldExpiresTick ?? 0) > world.currentTick;
      case "shield_remaining":
        return Math.max(0, (robot.shieldExpiresTick ?? 0) - world.currentTick);

      // --- Self-destruct countdown ---
      case "self_destruct_armed":
        return (robot.selfDestructTick ?? 0) > 0;
      case "self_destruct_remaining":
        return (robot.selfDestructTick ?? 0) > 0
          ? Math.max(0, robot.selfDestructTick - world.currentTick)
          : 0;

      // --- Resupply Depot ---
      case "nearest_depot": {
        let nearestDist = Infinity;
        let nearest = null;
        for (const depot of world.depots.values()) {
          const d = distance(robot.position, depot.position);
          if (d < nearestDist) {
            nearestDist = d;
            nearest = {
              id: depot.id,
              position: { x: depot.position.x, y: depot.position.y },
              radius: depot.radius,
              distance: Math.round(d),
            };
          }
        }
        return nearest;
      }
      case "is_on_depot": {
        for (const depot of world.depots.values()) {
          if (distance(robot.position, depot.position) <= depot.radius) return true;
        }
        return false;
      }

      // --- Hive (shared team memory) ---
      case "hive_get": {
        const key = args[0];
        if (typeof key !== "string") return null;
        return world.hiveGet(robot.teamId, key);
      }
      case "hive_set": {
        const key = args[0];
        if (typeof key !== "string") return null;
        const value = args[1] ?? null;
        world.hiveSet(robot.teamId, key, value);
        return value;
      }
      case "hive_has": {
        const key = args[0];
        if (typeof key !== "string") return false;
        return world.hiveHas(robot.teamId, key);
      }

      case "position":
        return { x: robot.position.x, y: robot.position.y };

      case "velocity":
        return { x: robot.velocity.x, y: robot.velocity.y };

      case "heading":
        return { x: robot.heading.x, y: robot.heading.y };

      case "cooldown": {
        const actionName = args[0];
        return robot.cooldowns.get(actionName) ?? 0;
      }

      // --- Enemy Sensors ---
      case "nearest_enemy": {
        // If we're currently taunted, the taunter takes priority over the
        // geometric nearest — provided they're still alive and visible.
        // This is what makes `taunt` a real combat tool instead of a no-op.
        if (robot.tauntedBy && world.currentTick < robot.tauntExpiresTick) {
          const taunter = world.getRobot(robot.tauntedBy);
          if (taunter && taunter.alive) {
            const visible = getVisibleEnemies(world, robot);
            if (visible.find(e => e.id === taunter.id)) {
              return mapRobotView(taunter);
            }
          }
        }
        const visible = getVisibleEnemies(world, robot);
        if (visible.length === 0) return null;
        return mapRobotView(visible[0]);
      }

      case "visible_enemies": {
        const visible = getVisibleEnemies(world, robot);
        return visible.map(robotToSensorView);
      }

      case "enemy_count_in_range": {
        const range = args[0] ?? ATTACK_RANGE;
        const visible = getVisibleEnemies(world, robot);
        return visible.filter(e => distance(robot.position, e.position) <= range).length;
      }

      // --- Ally Sensors ---
      case "nearest_ally": {
        const allies = getVisibleAllies(world, robot);
        if (allies.length === 0) return null;
        return mapRobotView(allies[0]);
      }

      case "visible_allies": {
        const allies = getVisibleAllies(world, robot);
        return allies.map(robotToSensorView);
      }

      // --- Arena Sensors (discovery-based: only returns features the robot has seen) ---
      case "nearest_cover": {
        let nearestDist = Infinity;
        let nearest = null;
        // Only search discovered covers
        for (const cover of robot.memory.discoveredCovers.values()) {
          const d = distance(robot.position, cover.position);
          if (d < nearestDist) {
            nearestDist = d;
            nearest = { x: cover.position.x, y: cover.position.y };
          }
        }
        return nearest;
      }

      // `nearest_resource` used to return entries from world.resources, but
      // no arena preset or random generator ever populates that map, so the
      // sensor was dead weight. Use `nearest_depot` for ammo/heat resupply
      // or `nearest_pickup` for timed buffs instead. The sensor stays
      // registered so old bots compile, but it always returns null.
      case "nearest_resource":
        return null;

      case "nearest_control_point": {
        let nearestDist = Infinity;
        let nearest = null;
        // Only search discovered control points; update owner from live data if still visible
        for (const mem of robot.memory.discoveredControlPoints.values()) {
          const liveCp = world.controlPoints.get(mem.id);
          const owner = liveCp ? liveCp.owner : mem.owner;
          const d = distance(robot.position, mem.position);
          if (d < nearestDist) {
            nearestDist = d;
            nearest = { id: mem.id, position: { x: mem.position.x, y: mem.position.y }, owner };
          }
        }
        return nearest;
      }

      case "nearest_enemy_control_point": {
        let nearestDist = Infinity;
        let nearest = null;
        for (const mem of robot.memory.discoveredControlPoints.values()) {
          const liveCp = world.controlPoints.get(mem.id);
          const owner = liveCp ? liveCp.owner : mem.owner;
          if (owner === robot.teamId) continue;
          const d = distance(robot.position, mem.position);
          if (d < nearestDist) {
            nearestDist = d;
            nearest = { id: mem.id, position: { x: mem.position.x, y: mem.position.y }, owner };
          }
        }
        return nearest;
      }

      case "nearest_heal_zone": {
        let nearestDist = Infinity;
        let nearest = null;
        // Only search discovered healing zones
        for (const zone of robot.memory.discoveredHealZones.values()) {
          const d = distance(robot.position, zone.position);
          if (d < nearestDist) {
            nearestDist = d;
            nearest = { id: zone.id, position: { x: zone.position.x, y: zone.position.y }, radius: zone.radius };
          }
        }
        return nearest;
      }

      case "nearest_hazard": {
        let nearestDist = Infinity;
        let nearest = null;
        for (const hazard of robot.memory.discoveredHazards.values()) {
          const d = distance(robot.position, hazard.position);
          if (d < nearestDist) {
            nearestDist = d;
            nearest = { id: hazard.id, position: { x: hazard.position.x, y: hazard.position.y }, radius: hazard.radius };
          }
        }
        return nearest;
      }

      // --- Proprioceptive Arena Sensors (always work, no discovery needed) ---
      case "is_in_heal_zone": {
        for (const zone of world.healingZones.values()) {
          if (distance(robot.position, zone.position) <= zone.radius) return true;
        }
        return false;
      }

      case "is_in_hazard": {
        for (const hazard of world.hazards.values()) {
          if (distance(robot.position, hazard.position) <= hazard.radius) return true;
        }
        return false;
      }

      case "arena_width":
        return world.config.arenaWidth;

      case "arena_height":
        return world.config.arenaHeight;

      case "spawn_position":
        return { x: robot.memory.spawnPosition.x, y: robot.memory.spawnPosition.y };

      case "discovered_count": {
        const category = args[0] ?? "all";
        if (category === "cover") return robot.memory.discoveredCovers.size;
        if (category === "heal") return robot.memory.discoveredHealZones.size;
        if (category === "hazard") return robot.memory.discoveredHazards.size;
        if (category === "control") return robot.memory.discoveredControlPoints.size;
        return robot.memory.discoveredCovers.size +
               robot.memory.discoveredHealZones.size +
               robot.memory.discoveredHazards.size +
               robot.memory.discoveredControlPoints.size;
      }

      case "distance_to": {
        const target = args[0];
        if (target == null) return 999;
        // Entity ID (string)
        if (typeof target === "string") {
          const other = world.getRobot(target);
          if (other) return distance(robot.position, other.position);
          return 999;
        }
        if (typeof target !== "object") return 999;
        if ("x" in target && "y" in target) {
          return distance(robot.position, target);
        }
        if ("position" in target && target.position &&
            typeof target.position === "object" &&
            "x" in target.position && "y" in target.position) {
          return distance(robot.position, target.position);
        }
        return 999;
      }

      case "line_of_sight": {
        const target = args[0];
        if (target == null || typeof target !== "object") return false;
        let targetPos;
        if ("x" in target && "y" in target) {
          targetPos = target;
        } else if ("position" in target && target.position &&
                   typeof target.position === "object" &&
                   "x" in target.position && "y" in target.position) {
          targetPos = target.position;
        } else {
          return false;
        }
        return hasLineOfSight(world, robot.position, targetPos);
      }

      case "current_tick":
        return world.currentTick;
      case "team_size":
        return world.getAliveRobotsByTeam(robot.teamId).length;
      case "my_index":
        return robot.squadIndex ?? 0;
      case "my_role":
        return robot.squadRole ?? "";

      case "scan": {
        const range = Math.max(0, Math.min(args[0] ?? ACTIVE_SCAN_RANGE, ACTIVE_SCAN_RANGE));
        const detected = scanEnemies(robot, range);
        return detected[0] ?? null;
      }

      case "scan_enemies": {
        const range = Math.max(0, Math.min(args[0] ?? ACTIVE_SCAN_RANGE, ACTIVE_SCAN_RANGE));
        return scanEnemies(robot, range);
      }

      case "last_seen_enemy": {
        const memory = robot.memory.lastSeenEnemy;
        if (!memory) return null;
        const age = world.currentTick - memory.tick;
        return {
          id: memory.id,
          position: { x: memory.position.x, y: memory.position.y },
          last_seen_tick: memory.tick,
          age,
        };
      }

      case "has_recent_enemy_contact": {
        const maxAge = args[0] ?? ACTIVE_SCAN_MEMORY_TICKS;
        const memory = robot.memory.lastSeenEnemy;
        if (!memory) return false;
        return world.currentTick - memory.tick <= maxAge;
      }

      case "can_attack": {
        const target = args[0];
        if (target == null || typeof target !== "object") return false;
        const cd = robot.cooldowns.get("attack") ?? 0;
        if (cd > 0) return false;
        const stats = CLASS_STATS[robot.class];
        const range = stats?.attackRange ?? ATTACK_RANGE;
        let targetPos;
        let targetId = null;
        if ("position" in target && target.position && typeof target.position === "object") {
          targetPos = target.position;
          targetId = target.id ?? null;
        } else if ("x" in target && "y" in target) {
          targetPos = target;
        } else {
          return false;
        }
        if (distance(robot.position, targetPos) > range) return false;
        if (targetId) {
          const visibleIds = new Set(getVisibleEnemies(world, robot).map(enemy => enemy.id));
          if (!visibleIds.has(targetId)) return false;
        }
        return true;
      }

      // --- New Perception Sensors ---
      case "health_percent":
        return (robot.maxHealth ?? 0) <= 0
          ? 0
          : Math.round((robot.health / robot.maxHealth) * 100);

      case "angle_to": {
        const target = args[0];
        if (target == null || typeof target !== "object") return 0;
        let tx, ty;
        if ("x" in target && "y" in target) { tx = target.x; ty = target.y; }
        else if ("position" in target && target.position && typeof target.position === "object") {
          tx = target.position.x; ty = target.position.y;
        }
        else return 0;
        const dx = tx - robot.position.x;
        const dy = ty - robot.position.y;
        const targetAngle = Math.atan2(dy, dx);
        const headingAngle = Math.atan2(robot.heading.y, robot.heading.x);
        let diff = (targetAngle - headingAngle) * (180 / Math.PI);
        if (diff > 180) diff -= 360;
        if (diff < -180) diff += 360;
        return Math.round(diff);
      }

      case "is_facing": {
        const target = args[0];
        const tolerance = args[1] ?? 30;
        if (target == null || typeof target !== "object") return false;
        let tx, ty;
        if ("x" in target && "y" in target) { tx = target.x; ty = target.y; }
        else if ("position" in target && target.position && typeof target.position === "object") {
          tx = target.position.x; ty = target.position.y;
        }
        else return false;
        const dx = tx - robot.position.x;
        const dy = ty - robot.position.y;
        const targetAngle = Math.atan2(dy, dx);
        const headingAngle = Math.atan2(robot.heading.y, robot.heading.x);
        let diff = Math.abs(targetAngle - headingAngle) * (180 / Math.PI);
        if (diff > 180) diff = 360 - diff;
        return diff <= tolerance;
      }

      case "enemy_heading": {
        const target = args[0];
        if (!target) return null;
        const targetId = target.id ?? (typeof target === "string" ? target : null);
        if (!targetId) return null;
        const enemy = world.getRobot(targetId);
        if (!enemy || !enemy.alive) return null;
        // Must be visible
        const visibleIds = new Set(getVisibleEnemies(world, robot).map(e => e.id));
        if (!visibleIds.has(targetId)) return null;
        return { x: enemy.heading.x, y: enemy.heading.y };
      }

      case "is_enemy_facing_me": {
        const target = args[0];
        if (!target) return false;
        const targetId = target.id ?? (typeof target === "string" ? target : null);
        if (!targetId) return false;
        const enemy = world.getRobot(targetId);
        if (!enemy || !enemy.alive) return false;
        const visibleIds = new Set(getVisibleEnemies(world, robot).map(e => e.id));
        if (!visibleIds.has(targetId)) return false;
        const dx = robot.position.x - enemy.position.x;
        const dy = robot.position.y - enemy.position.y;
        const toMe = Math.atan2(dy, dx);
        const theirHeading = Math.atan2(enemy.heading.y, enemy.heading.x);
        let diff = Math.abs(toMe - theirHeading) * (180 / Math.PI);
        if (diff > 180) diff = 360 - diff;
        return diff <= 45;
      }

      case "ally_health": {
        const target = args[0];
        if (!target) return 0;
        const allyId = target.id ?? (typeof target === "string" ? target : null);
        if (!allyId) return 0;
        const ally = world.getRobot(allyId);
        if (!ally || !ally.alive || ally.teamId !== robot.teamId) return 0;
        return ally.health;
      }

      case "kills":
        return robot.kills ?? 0;

      case "time_alive":
        return world.currentTick - (robot.spawnTick ?? 0);

      // --- Noise Sensor ---
      case "nearest_sound": {
        let nearestDist = Infinity;
        let nearest = null;
        const cutoff = world.currentTick - NOISE_DECAY_TICKS;
        for (const noise of world.noiseEvents) {
          if (noise.tick < cutoff) continue;
          const d = distance(robot.position, noise.position);
          if (d > noise.radius) continue;
          // Don't hear your own team's noise
          const source = world.getRobot(noise.sourceName);
          if (source && source.teamId === robot.teamId) continue;
          if (d < nearestDist) {
            nearestDist = d;
            nearest = {
              position: { x: noise.position.x, y: noise.position.y },
              distance: Math.round(d),
              age: world.currentTick - noise.tick,
            };
          }
        }
        return nearest;
      }

      // --- Mine Sensor ---
      case "nearest_mine": {
        let nearestDist = Infinity;
        let nearest = null;
        for (const mine of world.mines.values()) {
          // Can only see enemy mines within close range
          if (mine.teamId === robot.teamId) continue;
          const d = distance(robot.position, mine.position);
          if (d > MINE_VISIBLE_RANGE) continue;
          if (d < nearestDist) {
            nearestDist = d;
            nearest = {
              id: mine.id,
              position: { x: mine.position.x, y: mine.position.y },
              distance: Math.round(d),
            };
          }
        }
        return nearest;
      }

      // --- Pickup Sensor ---
      case "nearest_pickup": {
        let nearestDist = Infinity;
        let nearest = null;
        const visionRange = CLASS_STATS[robot.class]?.visionRange ?? DEFAULT_VISION_RANGE;
        for (const pickup of world.pickups.values()) {
          if (pickup.collected) continue;
          const d = distance(robot.position, pickup.position);
          if (d > visionRange) continue;
          if (d < nearestDist) {
            nearestDist = d;
            nearest = {
              id: pickup.id,
              position: { x: pickup.position.x, y: pickup.position.y },
              type: pickup.type,
              distance: Math.round(d),
            };
          }
        }
        return nearest;
      }

      // --- Waypoint Memory ---
      case "recall_position": {
        const name = args[0];
        if (!name || typeof name !== "string") return null;
        const wp = robot.memory.waypoints.get(name);
        if (!wp) return null;
        return { x: wp.x, y: wp.y };
      }

      // --- State Queries ---
      case "is_taunted":
        return robot.tauntedBy !== null && world.currentTick < robot.tauntExpiresTick;

      case "is_in_overwatch":
        return robot.overwatchActive && world.currentTick < robot.overwatchExpiresTick;

      case "has_effect": {
        const effectType = args[0];
        if (!effectType) return false;
        return robot.activeEffects.some(e => e.type === effectType && world.currentTick < e.expiresTick);
      }

      // --- Math built-ins ---
      case "abs": return Math.abs(toNum(args[0]));
      case "min": return Math.min(toNum(args[0]), toNum(args[1]));
      case "max": return Math.max(toNum(args[0]), toNum(args[1]));
      case "clamp": {
        const x = toNum(args[0]);
        const lo = toNum(args[1]);
        const hi = toNum(args[2]);
        return Math.min(Math.max(x, lo), hi);
      }
      case "floor": return Math.floor(toNum(args[0]));
      case "ceil": return Math.ceil(toNum(args[0]));
      case "round": return Math.round(toNum(args[0]));
      case "sign": {
        const x = toNum(args[0]);
        return x > 0 ? 1 : x < 0 ? -1 : 0;
      }
      case "sqrt": {
        const x = toNum(args[0]);
        return x >= 0 ? Math.sqrt(x) : 0;
      }
      case "pow": return Math.pow(toNum(args[0]), toNum(args[1]));
      case "lerp": {
        const a = toNum(args[0]);
        const b = toNum(args[1]);
        const t = Math.min(Math.max(toNum(args[2]), 0), 1);
        return a + (b - a) * t;
      }
      case "pi": return Math.PI;

      // --- Vector / spatial helpers ---
      case "distance_between": {
        const a = extractPosition(args[0]);
        const b = extractPosition(args[1]);
        if (!a || !b) return 999;
        return distance(a, b);
      }
      case "direction_to": {
        const target = extractPosition(args[0]);
        if (!target) return { x: robot.heading.x, y: robot.heading.y };
        const dx = target.x - robot.position.x;
        const dy = target.y - robot.position.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) return { x: robot.heading.x, y: robot.heading.y };
        return { x: dx / len, y: dy / len };
      }
      case "angle_between": {
        const a = extractPosition(args[0]);
        const b = extractPosition(args[1]);
        if (!a || !b) return 0;
        const deg = Math.atan2(b.y - a.y, b.x - a.x) * (180 / Math.PI);
        return Math.round(deg);
      }
      case "make_position": {
        // Construct a position object the VM + engine can consume. Bounds-check
        // to keep bogus coordinates from leaking into movement/aim logic.
        const x = Math.min(Math.max(toNum(args[0]), 0), world.config.arenaWidth);
        const y = Math.min(Math.max(toNum(args[1]), 0), world.config.arenaHeight);
        return { x, y };
      }

      // --- Team / tactics helpers ---
      case "squad_center": {
        let sx = 0, sy = 0, n = 0;
        for (const other of world.robots.values()) {
          if (!other.alive) continue;
          if (other.teamId !== robot.teamId) continue;
          sx += other.position.x;
          sy += other.position.y;
          n++;
        }
        if (n === 0) return { x: robot.position.x, y: robot.position.y };
        return { x: sx / n, y: sy / n };
      }
      case "lowest_health_ally": {
        let best = null;
        let bestHp = Infinity;
        for (const other of world.robots.values()) {
          if (!other.alive) continue;
          if (other.teamId !== robot.teamId) continue;
          if (other.id === robot.id) continue;
          if (other.health < bestHp) {
            bestHp = other.health;
            best = other;
          }
        }
        return best ? robotToSensorView(best) : null;
      }
      case "weakest_visible_enemy": {
        const visible = getVisibleEnemies(world, robot);
        if (visible.length === 0) return null;
        let best = visible[0];
        for (const e of visible) if (e.health < best.health) best = e;
        return robotToSensorView(best);
      }
      case "count_enemies_near": {
        const center = extractPosition(args[0]) ?? robot.position;
        const range = toNum(args[1] ?? 10);
        let count = 0;
        for (const other of world.robots.values()) {
          if (!other.alive) continue;
          if (other.teamId === robot.teamId) continue;
          if (other.cloakActive && distance(robot.position, other.position) > CLOAK_BREAK_DISTANCE) continue;
          if (distance(center, other.position) <= range) count++;
        }
        return count;
      }
      case "count_allies_near": {
        const center = extractPosition(args[0]) ?? robot.position;
        const range = toNum(args[1] ?? 10);
        let count = 0;
        for (const other of world.robots.values()) {
          if (!other.alive) continue;
          if (other.teamId !== robot.teamId) continue;
          if (other.id === robot.id) continue;
          if (distance(center, other.position) <= range) count++;
        }
        return count;
      }

      // --- Timing helper ---
      case "tick_phase": {
        const period = Math.max(1, Math.floor(toNum(args[0] ?? 30)));
        return world.currentTick % period;
      }

      // --- List helpers (match list[i] indexing) ---
      case "length": {
        const v = args[0];
        if (Array.isArray(v)) return v.length;
        if (typeof v === "string") return v.length;
        return 0;
      }
      case "list_empty": {
        const v = args[0];
        if (Array.isArray(v)) return v.length === 0;
        return true;
      }

      // --- Extended math (trig + angle conversion) ---
      case "sin": return Math.sin(toNum(args[0]));
      case "cos": return Math.cos(toNum(args[0]));
      case "atan2": return Math.atan2(toNum(args[0]), toNum(args[1]));
      case "deg_to_rad": return toNum(args[0]) * (Math.PI / 180);
      case "rad_to_deg": return toNum(args[0]) * (180 / Math.PI);

      // --- Predictive perception (NEW) ---
      // enemy_velocity(enemy) -> vector | null
      //   Velocity is already attached to robotToSensorView, so this is a
      //   convenience helper for authors who pass around entity handles.
      case "enemy_velocity": {
        const e = args[0];
        if (!e || typeof e !== "object") return null;
        // Accept either a live robot view or a bare id
        const targetId = typeof e === "string" ? e : e.id;
        if (!targetId) return null;
        const target = world.robots.get(targetId);
        if (!target || !target.alive) return null;
        return {
          x: Math.round((target.velocity?.x ?? 0) * 100) / 100,
          y: Math.round((target.velocity?.y ?? 0) * 100) / 100,
        };
      }

      // predict_position(enemy, ticks) -> position | null
      //   Linear extrapolation — naive but good enough for lead-shot bots.
      //   Uses the same 0.01-rounded velocity that bots see via
      //   `enemy_velocity()` so a lead computation that matches the sensor
      //   matches the engine's actual movement.
      case "predict_position": {
        const e = args[0];
        const ticks = Math.max(0, Math.floor(toNum(args[1] ?? 5)));
        if (!e || typeof e !== "object") return null;
        const targetId = typeof e === "string" ? e : e.id;
        const target = world.robots.get(targetId);
        if (!target || !target.alive) return null;
        const vx = Math.round((target.velocity?.x ?? 0) * 100) / 100;
        const vy = Math.round((target.velocity?.y ?? 0) * 100) / 100;
        const px = target.position.x + vx * ticks;
        const py = target.position.y + vy * ticks;
        return {
          x: Math.max(0, Math.min(world.config.arenaWidth, px)),
          y: Math.max(0, Math.min(world.config.arenaHeight, py)),
        };
      }

      // incoming_projectile() -> { position, direction, distance, ticks_to_impact } | null
      //   Finds the projectile closest to actually hitting this robot.
      //   Previously this only checked closing-speed > 0, so a projectile
      //   passing 30 units to the side at any closing angle registered as a
      //   threat. Now we also compute the closest-approach distance along
      //   the projectile's path and ignore anything that won't pass within
      //   the robot's hit radius + a small safety margin.
      case "incoming_projectile": {
        const visionRange = CLASS_STATS[robot.class]?.visionRange ?? DEFAULT_VISION_RANGE;
        const MISS_MARGIN = 3.0; // hit radius 1.5 + 1.5 safety
        let best = null;
        let bestTicks = Infinity;
        for (const proj of world.projectiles.values()) {
          const owner = world.getRobot(proj.ownerId);
          if (!owner) continue;
          if (owner.teamId === robot.teamId) continue; // ignore friendly fire
          const dx = robot.position.x - proj.position.x;
          const dy = robot.position.y - proj.position.y;
          const dist = Math.hypot(dx, dy);
          if (dist > visionRange) continue;
          const vlen = Math.hypot(proj.velocity.x, proj.velocity.y);
          if (vlen < 1e-6) continue;
          // Project (robot - proj) onto velocity direction to get how long until
          // the projectile is at its closest approach. Negative = already past.
          const tClose = (proj.velocity.x * dx + proj.velocity.y * dy) / (vlen * vlen);
          if (tClose <= 0) continue;
          // Perpendicular miss distance at closest approach.
          const cx = proj.position.x + proj.velocity.x * tClose;
          const cy = proj.position.y + proj.velocity.y * tClose;
          const missDist = Math.hypot(robot.position.x - cx, robot.position.y - cy);
          if (missDist > MISS_MARGIN) continue;
          const ticksToImpact = tClose;
          if (ticksToImpact < bestTicks) {
            bestTicks = ticksToImpact;
            best = {
              position: { x: proj.position.x, y: proj.position.y },
              direction: { x: proj.velocity.x / vlen, y: proj.velocity.y / vlen },
              distance: Math.round(dist * 10) / 10,
              ticks_to_impact: Math.round(ticksToImpact),
              damage: proj.damage,
            };
          }
        }
        return best;
      }

      // damage_direction() -> vector | null
      //   Unit vector pointing FROM us TOWARD the attacker of our most
      //   recent damage event. Stays valid for DAMAGE_MEMORY_TICKS after
      //   the hit so bots can run "strafe perpendicular" logic for a few
      //   frames without needing to re-check every tick.
      case "damage_direction": {
        const mem = robot.memory.lastDamage;
        if (!mem) return null;
        if (world.currentTick - mem.tick > 30) return null;
        return { x: mem.dirX, y: mem.dirY };
      }

      // last_damage_tick() -> number
      case "last_damage_tick": {
        return robot.memory.lastDamage ? robot.memory.lastDamage.tick : -1;
      }

      // threat_level() -> number (0-100)
      //   "How bad is my situation" heuristic. Returns a single scalar so
      //   bots can gate aggressive/defensive branches without composing
      //   five sensors.
      //
      //   Components (max 100 total):
      //     35 — HP loss (linear)
      //     30 — Enemy pressure (10 per visible enemy, up to 3)
      //     10 — Overheated (binary)
      //     10 — Low ammo (<25%)
      //     10 — Outnumbered by visible allies in 16-unit radius
      //      5 — Hit within the last 10 ticks
      case "threat_level": {
        let threat = 0;
        if (robot.maxHealth > 0) {
          const hpLoss = 1 - (robot.health / robot.maxHealth);
          threat += hpLoss * 35;
        }
        const visEnemies = getVisibleEnemies(world, robot);
        threat += Math.min(visEnemies.length * 10, 30);
        if (robot.overheated) threat += 10;
        if (robot.maxAmmo > 0 && robot.ammo / robot.maxAmmo < 0.25) threat += 10;
        // Local outnumbering: count enemies vs allies within 16 units.
        let nearEnemies = 0;
        let nearAllies = 0;
        for (const other of world.robots.values()) {
          if (!other.alive || other.id === robot.id) continue;
          const dx = other.position.x - robot.position.x;
          const dy = other.position.y - robot.position.y;
          if (dx * dx + dy * dy > 256) continue;  // 16^2
          if (other.teamId === robot.teamId) nearAllies++;
          else nearEnemies++;
        }
        if (nearEnemies > nearAllies + 1) threat += 10;
        if (robot.memory.lastDamage && world.currentTick - robot.memory.lastDamage.tick < 10) threat += 5;
        return Math.max(0, Math.min(100, Math.round(threat)));
      }

      // log(msg, [value]) -> null
      //   Emits a diagnostic line to the shared log sink so bot authors can
      //   trace state-machine transitions from the UI console. When no sink
      //   is attached (e.g. server-side validation runs) the call is a cheap
      //   no-op — we still flatten the args so stringify never throws.
      case "log": {
        if (!logSink || !Array.isArray(logSink)) return null;
        if (logSink.length >= 500) return null; // cap DOM/noise blast radius
        const parts = [];
        for (const a of args) parts.push(logValueToString(a));
        const message = parts.join(" ");
        logSink.push({
          robotId: robot.id,
          robotName: robot.name ?? robot.id,
          teamId: robot.teamId,
          tick: world.currentTick,
          message,
        });
        return null;
      }

      // --- List stdlib ---
      case "list_contains": {
        const list = args[0];
        const needle = args[1];
        if (!Array.isArray(list)) return false;
        for (const item of list) {
          if (item === needle) return true;
          // Handle entity objects (common case): match by id
          if (item && typeof item === "object" && needle && typeof needle === "object"
              && "id" in item && "id" in needle && item.id === needle.id) return true;
        }
        return false;
      }
      case "list_first": {
        const list = args[0];
        return Array.isArray(list) && list.length > 0 ? list[0] : null;
      }
      case "list_last": {
        const list = args[0];
        return Array.isArray(list) && list.length > 0 ? list[list.length - 1] : null;
      }
      case "list_sum": {
        const list = args[0];
        if (!Array.isArray(list)) return 0;
        let sum = 0;
        for (const v of list) sum += toNum(v);
        return sum;
      }
      case "index_of": {
        const list = args[0];
        const needle = args[1];
        if (!Array.isArray(list)) return -1;
        for (let i = 0; i < list.length; i++) {
          const item = list[i];
          if (item === needle) return i;
          if (item && typeof item === "object" && needle && typeof needle === "object"
              && "id" in item && "id" in needle && item.id === needle.id) return i;
        }
        return -1;
      }

      // --- String stdlib (lean — no regex/split to keep the VM simple) ---
      case "string_contains": {
        const hay = typeof args[0] === "string" ? args[0] : "";
        const needle = typeof args[1] === "string" ? args[1] : "";
        return needle.length === 0 ? true : hay.indexOf(needle) !== -1;
      }
      case "starts_with": {
        const hay = typeof args[0] === "string" ? args[0] : "";
        const prefix = typeof args[1] === "string" ? args[1] : "";
        return hay.startsWith(prefix);
      }
      case "ends_with": {
        const hay = typeof args[0] === "string" ? args[0] : "";
        const suffix = typeof args[1] === "string" ? args[1] : "";
        return hay.endsWith(suffix);
      }

      // --- Random (float variant — deterministic via world.rng) ---
      case "rand_float": {
        const min = toNum(args[0] ?? 0);
        const max = toNum(args[1] ?? 1);
        const low = Math.min(min, max);
        const high = Math.max(min, max);
        return world.rng.nextFloat(low, high);
      }
      case "chance": {
        // chance(p) -> true with probability p (0..1). Convenience for
        // stochastic decisions ("fire grenade 20% of ticks").
        const p = Math.min(Math.max(toNum(args[0] ?? 0), 0), 1);
        return world.rng.nextFloat(0, 1) < p;
      }

      // --- Pure vector/math helpers ---
      case "hypot": return Math.hypot(toNum(args[0]), toNum(args[1]));
      case "mod": {
        const a = toNum(args[0]);
        const b = toNum(args[1]);
        if (b === 0) return 0;
        // JS `%` retains the sign of the dividend; we want mathematical mod
        // so negative arguments return a positive result — much less
        // surprising when authors use mod() for tick-phase rotation.
        const r = a % b;
        return r < 0 ? r + Math.abs(b) : r;
      }
      case "dot": {
        const a = extractPosition(args[0]);
        const b = extractPosition(args[1]);
        if (!a || !b) return 0;
        return a.x * b.x + a.y * b.y;
      }
      case "normalize": {
        const v = extractPosition(args[0]);
        if (!v) return { x: 0, y: 0 };
        const len = Math.hypot(v.x, v.y);
        if (len < 1e-6) return { x: 0, y: 0 };
        return { x: v.x / len, y: v.y / len };
      }
      case "vec_add": {
        const a = extractPosition(args[0]);
        const b = extractPosition(args[1]);
        if (!a) return b ?? { x: 0, y: 0 };
        if (!b) return a;
        return { x: a.x + b.x, y: a.y + b.y };
      }
      case "vec_scale": {
        const v = extractPosition(args[0]);
        const s = toNum(args[1]);
        if (!v) return { x: 0, y: 0 };
        return { x: v.x * s, y: v.y * s };
      }

      default:
        // Semantic analysis rejects unknown sensors at compile time, so
        // reaching this branch means compiler + runtime drifted apart.
        // Surface it loudly in dev so new sensors don't get silently broken.
        if (typeof console !== "undefined" && console.warn) {
          console.warn(`[sensor-gateway] Unhandled sensor '${sensorName}' — returning null. Add a case to createSensorGateway.`);
        }
        return null;
    }
  };
}
