// ============================================================================
// World State Model — All entities and simulation state
// ============================================================================

import { SeededRNG } from "../shared/prng.js";
import { vec2 } from "../shared/vec2.js";
import {
  ROBOT_BASE_HEALTH, ROBOT_BASE_ENERGY, CLASS_STATS,
  HAZARD_DAMAGE_PER_TICK, HAZARD_ZONE_RADIUS,
  DESTRUCTIBLE_COVER_HP,
  HEAT_MAX, DEPOT_RADIUS,
} from "../shared/config.js";

let nextId = 0;
export function generateId(prefix) {
  return `${prefix}_${++nextId}`;
}

export function resetIdCounter() {
  nextId = 0;
}

export class World {
  robots = new Map();
  projectiles = new Map();
  controlPoints = new Map();
  resources = new Map();
  healingZones = new Map();
  covers = new Map();
  hazards = new Map();
  mines = new Map();
  pickups = new Map();
  depots = new Map();
  noiseEvents = [];   // { position, radius, sourceName, tick }
  pendingSignals = []; // { senderId, teamId, data, position, range, tick }
  hiveMemory = new Map(); // teamId -> Map<string, value> (shared team memory)
  pendingDetonations = []; // { ownerId, teamId, position, triggerTick, radius, damage, kind }
  currentTick = 0;
  config;
  rng;
  pendingEvents = [];

  constructor(config) {
    this.config = config;
    this.rng = new SeededRNG(config.seed);
  }

  spawnRobot(
    name,
    robotClass,
    teamId,
    programId,
    position,
    squadIndex = 0,
    squadSize = 1,
    squadRole = null,
  ) {
    const id = generateId("robot");
    const stats = CLASS_STATS[robotClass] ?? {
      health: ROBOT_BASE_HEALTH,
      energy: ROBOT_BASE_ENERGY,
      moveSpeed: 2.0,
      attackDamage: 10,
      attackRange: 5.0,
      attackCooldown: 5,
      maxAmmo: 80,
      heatDissipation: 1.0,
    };
    const maxAmmo = stats.maxAmmo ?? 80;

    // Spawn at given position or random position within arena bounds
    // Clone provided position to prevent shared mutable references
    const pos = position
      ? { x: position.x, y: position.y }
      : vec2(
        this.rng.nextFloat(5, this.config.arenaWidth - 5),
        this.rng.nextFloat(5, this.config.arenaHeight - 5),
      );

    const robot = {
      id,
      name,
      class: robotClass,
      position: pos,
      velocity: vec2(0, 0),
      heading: vec2(1, 0),
      health: stats.health,
      maxHealth: stats.health,
      energy: stats.energy,
      maxEnergy: stats.energy,
      cooldowns: new Map(),
      memory: {
        lastSeenEnemy: null,
        discoveredCovers: new Map(),
        discoveredHealZones: new Map(),
        discoveredControlPoints: new Map(),
        discoveredHazards: new Map(),
        spawnPosition: { x: pos.x, y: pos.y },
        waypoints: new Map(),  // named positions: string -> {x, y}
        // Stores the unit vector pointing FROM us TOWARD the last source
        // of damage, plus the tick it happened. Consumed by the
        // `damage_direction` sensor so bots can strafe perpendicular to
        // incoming fire for a short window after being hit.
        lastDamage: null,  // { tick, dirX, dirY, sourceId }
      },
      alive: true,
      teamId,
      programId,
      squadIndex,
      squadSize,
      squadRole,
      // --- Extended state ---
      kills: 0,
      spawnTick: 0,
      minesPlaced: 0,
      tauntedBy: null,      // robotId that taunted this robot
      tauntExpiresTick: 0,
      overwatchActive: false,
      overwatchExpiresTick: 0,
      activeEffects: [],     // pickup effects: { type, expiresTick }
      signalCooldownTick: 0,
      // --- Resource Economy (Heat + Ammo) ---
      heat: 0,
      maxHeat: HEAT_MAX,
      overheated: false,
      ammo: maxAmmo,
      maxAmmo,
      heatDissipation: stats.heatDissipation ?? 1.0,
      // --- Cloak ---
      cloakActive: false,
      cloakExpiresTick: 0,
      // --- Shield: damage reduction window opened by `shield` action ---
      shieldExpiresTick: 0,
      // --- Self-Destruct ---
      selfDestructTick: 0,   // 0 = not armed; >0 = tick it will detonate
    };

    this.robots.set(id, robot);
    return robot;
  }

  spawnProjectile(ownerId, position, velocity, damage, ttl) {
    const id = generateId("proj");
    const proj = { id, ownerId, position: { ...position }, velocity: { ...velocity }, damage, ttl };
    this.projectiles.set(id, proj);
    return proj;
  }

  addControlPoint(position, radius) {
    const id = generateId("cp");
    const cp = { id, position, radius, owner: null, captureProgress: 0 };
    this.controlPoints.set(id, cp);
    return cp;
  }

  addCover(position, width, height, destructible = false) {
    const id = generateId("cover");
    const cover = {
      id, position, width, height,
      destructible,
      health: destructible ? DESTRUCTIBLE_COVER_HP : Infinity,
    };
    this.covers.set(id, cover);
    return cover;
  }

  addHealingZone(position, radius, healPerTick = 2) {
    const id = generateId("heal");
    const zone = { id, position, radius, healPerTick };
    this.healingZones.set(id, zone);
    return zone;
  }

  addHazard(position, radius = HAZARD_ZONE_RADIUS, damagePerTick = HAZARD_DAMAGE_PER_TICK) {
    const id = generateId("hazard");
    const hazard = { id, position, radius, damagePerTick };
    this.hazards.set(id, hazard);
    return hazard;
  }

  addMine(ownerId, teamId, position, damage) {
    const id = generateId("mine");
    const mine = { id, ownerId, teamId, position: { ...position }, damage };
    this.mines.set(id, mine);
    return mine;
  }

  addDepot(position, radius = DEPOT_RADIUS) {
    const id = generateId("depot");
    const depot = { id, position: { x: position.x, y: position.y }, radius };
    this.depots.set(id, depot);
    return depot;
  }

  hiveSet(teamId, key, value) {
    let teamMap = this.hiveMemory.get(teamId);
    if (!teamMap) {
      teamMap = new Map();
      this.hiveMemory.set(teamId, teamMap);
    }
    teamMap.set(key, value);
  }

  hiveGet(teamId, key) {
    const teamMap = this.hiveMemory.get(teamId);
    if (!teamMap) return null;
    return teamMap.has(key) ? teamMap.get(key) : null;
  }

  hiveHas(teamId, key) {
    const teamMap = this.hiveMemory.get(teamId);
    if (!teamMap) return false;
    return teamMap.has(key);
  }

  addPickup(position, type) {
    const id = generateId("pickup");
    const pickup = { id, position: { ...position }, type, collected: false };
    this.pickups.set(id, pickup);
    return pickup;
  }

  addNoise(position, radius, sourceName, tick) {
    this.noiseEvents.push({ position: { ...position }, radius, sourceName, tick });
  }

  getRobot(id) {
    return this.robots.get(id);
  }

  getAliveRobots() {
    return [...this.robots.values()].filter(r => r.alive);
  }

  getAliveRobotsByTeam(teamId) {
    return this.getAliveRobots().filter(r => r.teamId === teamId);
  }

  getTeamIds() {
    const teams = new Set();
    for (const r of this.robots.values()) {
      teams.add(r.teamId);
    }
    return [...teams];
  }

  emitEvent(event) {
    this.pendingEvents.push(event);
  }

  drainEvents() {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }
}
