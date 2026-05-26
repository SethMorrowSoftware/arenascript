// ============================================================================
// Tick Scheduler — The 11-phase deterministic simulation loop
// ============================================================================

import { World, resetIdCounter } from "./world.js";
import { VM } from "../runtime/vm.js";
import { createSensorGateway } from "./sensors.js";
import { validateAction, categorizeActions } from "./actions.js";
import { resolveMovement, applyMovement, resolveCollisions } from "./movement.js";
import { resolveCombat, updateProjectiles, updateCooldowns, applyDamage } from "./combat.js";
import { getVisibleEnemies } from "./los.js";
import { VisibilityTracker, checkCooldownReady } from "./events.js";
import { ReplayWriter } from "./replay.js";
import { getArenaPreset } from "./arena-presets.js";
import {
  CAPTURE_RATE, CAPTURE_WIN_THRESHOLD, CAPTURE_RADIUS,
  HEAL_ZONE_RADIUS, HEAL_ZONE_TICK_RATE,
  HAZARD_ZONE_RADIUS, HAZARD_DAMAGE_PER_TICK,
  CLASS_STATS, DEFAULT_VISION_RANGE,
  MINE_DAMAGE, MINE_TRIGGER_RADIUS, MINE_MAX_PER_ROBOT, MINE_COOLDOWN, MINE_ENERGY_COST,
  PICKUP_SPAWN_INTERVAL, PICKUP_MAX_ACTIVE, PICKUP_COLLECT_RADIUS,
  PICKUP_EFFECT_DURATION, PICKUP_SPEED_MULTIPLIER, PICKUP_DAMAGE_MULTIPLIER,
  PICKUP_VISION_BONUS, PICKUP_ENERGY_RESTORE,
  NOISE_ATTACK_RADIUS, NOISE_MOVE_RADIUS, NOISE_GRENADE_RADIUS, NOISE_DECAY_TICKS,
  SIGNAL_RANGE, SIGNAL_COOLDOWN,
  OVERWATCH_DURATION, OVERWATCH_COOLDOWN, OVERWATCH_ENERGY_COST,
  TAUNT_DURATION, TAUNT_COOLDOWN, TAUNT_RANGE, TAUNT_ENERGY_COST,
  CLOAK_DURATION, CLOAK_COOLDOWN, CLOAK_ENERGY_COST,
  SELF_DESTRUCT_COUNTDOWN, SELF_DESTRUCT_RADIUS, SELF_DESTRUCT_DAMAGE,
  SELF_DESTRUCT_HEALTH_THRESHOLD,
  DEPOT_AMMO_PER_TICK, DEPOT_HEAT_VENT_PER_TICK,
  HEAT_MAX,
} from "../shared/config.js";
import { distance, vec2 } from "../shared/vec2.js";
import { validateMatchRequest } from "../shared/validation.js";

let nextMatchSequence = 0;

/**
 * Run a complete match simulation.
 * This is the core game loop — fully deterministic.
 */
export function runMatch(setup) {
  // Fail fast on malformed setups. Previously runMatch would either throw
  // deep inside world/VM setup or silently produce an undefined result
  // if, e.g., config.seed was NaN or a participant had no bytecode.
  const validation = validateMatchRequest(setup);
  if (!validation.valid) {
    throw new Error(`Invalid match setup: ${validation.errors.join("; ")}`);
  }

  resetIdCounter();

  const { config } = setup;
  const world = new World(config);
  initializeArenaLayout(world);
  const visibilityTracker = new VisibilityTracker();
  // Shared log sink for all VMs in this match. Surfaced back to the caller
  // (and from there to the UI console) so bots can print debug traces via
  // log(...) without any per-match plumbing on the client side.
  const botLogs = [];
  const sensorGateway = createSensorGateway(world, { logs: botLogs });

  // Track stats per robot
  const robotStats = new Map();

  // Spawn robots and create VMs
  const robotVMs = new Map();

  const matchParticipants = [];

  // Determine the team layout up front so spawn placement can choose between
  // opposing lanes (2 teams) and a fair perimeter ring (3+ teams / free-for-all).
  const distinctTeamIds = [...new Set(setup.participants.map(p => p.teamId))].sort((a, b) => a - b);
  const teamLayout = { ids: distinctTeamIds, isFFA: distinctTeamIds.length > 2 };

  const teamSpawnOrder = new Map();

  for (const participant of setup.participants) {
    const requestedSquadSize = participant.program.squad?.size ?? 1;
    const squadSize = Math.max(1, Math.min(5, Number(requestedSquadSize) || 1));
    const roles = participant.program.squad?.roles ?? [];

    for (let squadIndex = 0; squadIndex < squadSize; squadIndex++) {
      const teamIndex = teamSpawnOrder.get(participant.teamId) ?? 0;
      const spawnPosition = getSpawnPositionForTeam(world, participant.teamId, teamIndex, teamLayout);
      teamSpawnOrder.set(participant.teamId, teamIndex + 1);
      const squadRole = roles.length > 0 ? roles[squadIndex % roles.length] : null;

      const robot = world.spawnRobot(
        participant.program.robotName,
        participant.program.robotClass,
        participant.teamId,
        participant.program.programId,
        spawnPosition,
        squadIndex,
        squadSize,
        squadRole,
      );

      const vm = new VM(participant.program, robot.id, sensorGateway);
      vm.setConstants(participant.constants);
      robotVMs.set(robot.id, vm);

      robotStats.set(robot.id, {
        damageDealt: 0,
        damageTaken: 0,
        kills: 0,
        actionsExecuted: 0,
        budgetExceeded: 0,
      });

      matchParticipants.push({
        robotId: robot.id,
        programId: participant.program.programId,
        teamId: participant.teamId,
        playerId: participant.playerId,
        eloAtStart: 0,
      });
    }
  }

  // Create replay writer and capture arena identity + layout for rendering
  const matchId = `match_${config.seed}_${++nextMatchSequence}`;
  const replayWriter = new ReplayWriter(matchId, config.seed, matchParticipants);
  const preset = getArenaPreset(config.arenaId);
  replayWriter.setArenaIdentity(preset.id, preset.name);
  replayWriter.captureArenaLayout(world);

  // Execute spawn handlers
  for (const [robotId, vm] of robotVMs) {
    vm.executeEvent("spawn");
  }

  // Main tick loop
  let winner = null;
  let reason = "max_ticks_reached";
  const suddenDeathStartTick = config.maxTicks;
  const suddenDeathMaxTicks = config.suddenDeathMaxTicks ?? 900;
  const absoluteMaxTicks = suddenDeathStartTick + suddenDeathMaxTicks;

  for (let tick = 0; tick < absoluteMaxTicks; tick++) {
    world.currentTick = tick;
    const inSuddenDeath = tick >= suddenDeathStartTick;

    // Phase 1: Update world timers/cooldowns
    updateCooldowns(world);

    if (inSuddenDeath) {
      for (const robot of world.getAliveRobots()) {
        applyDamage(world, robot, 1, "sudden_death");
      }
    }

    // Phase 1b: Execute VM timers (after/every blocks)
    for (const [robotId, vm] of robotVMs) {
      const robot = world.getRobot(robotId);
      if (!robot || !robot.alive) continue;
      const timerActions = vm.executeTimers(tick);
      // Timer actions get processed as utility actions
      for (const action of timerActions) {
        resolveUtilityAction(world, robot, action, robotStats);
      }
    }

    // Phase 1c: Spawn pickups periodically
    if (tick > 0 && tick % PICKUP_SPAWN_INTERVAL === 0) {
      spawnRandomPickup(world);
    }

    // Phase 1d: Expire taunt/overwatch/effects
    for (const robot of world.getAliveRobots()) {
      if (robot.tauntedBy && tick >= robot.tauntExpiresTick) {
        robot.tauntedBy = null;
      }
      if (robot.overwatchActive && tick >= robot.overwatchExpiresTick) {
        robot.overwatchActive = false;
      }
      robot.activeEffects = robot.activeEffects.filter(e => tick < e.expiresTick);
    }

    // Phase 1e: Decay old noise events
    world.noiseEvents = world.noiseEvents.filter(n => tick - n.tick <= NOISE_DECAY_TICKS);

    // Phase 2: Build sensor views (handled lazily by sensor gateway)
    // Phase 3 & 4: Execute robot programs and collect action intents
    const movementActions = new Map();
    const combatActions = new Map();
    const decisionTraces = new Map();

    for (const [robotId, vm] of robotVMs) {
      const robot = world.getRobot(robotId);
      if (!robot || !robot.alive) continue;

      // Overwatch prevents movement actions
      const inOverwatch = robot.overwatchActive && tick < robot.overwatchExpiresTick;

      // Execute tick handler
      const result = vm.executeEvent("tick", undefined, tick);

      if (result.budgetExceeded) {
        const stats = robotStats.get(robotId);
        stats.budgetExceeded++;
      }

      // Validate and categorize actions
      if (result.actions.length > 0) {
        const { movement, combat, utility } = categorizeActions(result.actions);

        // Build decision trace
        decisionTraces.set(robotId, {
          event: "tick",
          action: movement?.type ?? combat?.type ?? utility?.type ?? null,
          budgetUsed: result.instructionsUsed ?? 0,
        });

        // Process utility actions (place_mine, send_signal, mark_position, taunt, overwatch)
        if (utility) {
          resolveUtilityAction(world, robot, utility, robotStats);
        }

        // Store primary actions
        if (movement && !inOverwatch) {
          const validated = validateAction(movement, robot);
          if (validated.valid) {
            movementActions.set(robotId, movement);
            robotStats.get(robotId).actionsExecuted++;
          }
        }
        if (combat) {
          const validated = validateAction(combat, robot);
          if (validated.valid) {
            combatActions.set(robotId, combat);
            robotStats.get(robotId).actionsExecuted++;
          }
        }
      } else {
        decisionTraces.set(robotId, {
          event: "tick",
          action: null,
          budgetUsed: result.instructionsUsed ?? 0,
        });
      }
    }

    // Phase 5: Resolve movement
    for (const robot of world.getAliveRobots()) {
      resolveMovement(world, robot, movementActions.get(robot.id) ?? null);
    }

    // Phase 6: Apply movement and resolve collisions
    for (const robot of world.getAliveRobots()) {
      applyMovement(world, robot);
    }
    resolveCollisions(world);

    // Phase 7: Resolve attacks and abilities (+ generate noise).
    // The action was already bucketed as combat by categorizeActions; passing
    // anything else here would have been silently dropped before — avoid that
    // class of bug by letting resolveCombat's switch be the single source of
    // truth for what's a combat action.
    for (const robot of world.getAliveRobots()) {
      let combatAction = combatActions.get(robot.id);

      // Overwatch auto-fire: a bot that opened overwatch and didn't queue its
      // own combat action this tick automatically engages the nearest visible
      // enemy in attack range. Without this, `overwatch` was a pure movement
      // restriction with no offensive benefit.
      if (!combatAction && robot.overwatchActive && tick < robot.overwatchExpiresTick) {
        const stats = CLASS_STATS[robot.class] || {};
        const range = stats.attackRange ?? 8;
        const visible = getVisibleEnemies(world, robot);
        let nearest = null;
        let nearestD = Infinity;
        for (const e of visible) {
          const dx = e.position.x - robot.position.x;
          const dy = e.position.y - robot.position.y;
          const d = Math.hypot(dx, dy);
          if (d <= range && d < nearestD) {
            nearest = e;
            nearestD = d;
          }
        }
        if (nearest) {
          combatAction = { robotId: robot.id, type: "fire_at", target: { x: nearest.position.x, y: nearest.position.y } };
        }
      }

      if (combatAction) {
        resolveCombat(world, robot, combatAction);
        // Generate noise from combat
        if (combatAction.type === "grenade") {
          world.addNoise(robot.position, NOISE_GRENADE_RADIUS, robot.id, tick);
        } else if (["attack", "fire_at", "fire_light", "fire_heavy", "burst_fire", "zap"].includes(combatAction.type)) {
          world.addNoise(robot.position, NOISE_ATTACK_RADIUS, robot.id, tick);
        }
      }
      // Generate movement noise
      if (movementActions.has(robot.id)) {
        const moveType = movementActions.get(robot.id).type;
        if (moveType !== "stop" && moveType !== "turn_left" && moveType !== "turn_right") {
          world.addNoise(robot.position, NOISE_MOVE_RADIUS, robot.id, tick);
        }
      }
    }

    // Phase 7b: Detonate mines
    detonateMines(world);

    // Phase 7c: Collect pickups
    collectPickups(world, tick);

    // Phase 8: Apply damage/effects (projectiles, zones, depots, self-destruct)
    updateProjectiles(world);
    applyHealingZones(world);
    applyHazardZones(world);
    applyDepots(world);
    resolveSelfDestructs(world, tick);

    // Phase 8b: Update robot discovery memory for nearby map features
    updateDiscovery(world);

    // Phase 8c: Dispatch signals to allies
    dispatchSignals(world, robotVMs);

    // Update capture points
    for (const cp of world.controlPoints.values()) {
      // Gather which teams have robots in capture range
      const teamsInRange = new Set();
      for (const robot of world.getAliveRobots()) {
        if (distance(robot.position, cp.position) <= CAPTURE_RADIUS) {
          teamsInRange.add(robot.teamId);
        }
      }

      if (teamsInRange.size === 1) {
        // Uncontested — one team capturing
        const capturingTeam = [...teamsInRange][0];
        if (cp.owner !== capturingTeam) {
          // Reset progress if a different team starts capturing
          if (cp.capturingTeam !== undefined && cp.capturingTeam !== capturingTeam) {
            cp.captureProgress = 0;
          }
          cp.capturingTeam = capturingTeam;
          cp.captureProgress += CAPTURE_RATE;
          if (cp.captureProgress >= CAPTURE_WIN_THRESHOLD) {
            cp.owner = capturingTeam;
            cp.captureProgress = 0;
          }
        }
      } else if (teamsInRange.size > 1) {
        // Contested — progress decays toward zero
        cp.captureProgress = Math.max(0, cp.captureProgress - CAPTURE_RATE);
      } else {
        // No one in range — progress decays toward zero
        cp.captureProgress = Math.max(0, cp.captureProgress - CAPTURE_RATE * 0.5);
      }
    }

    // Phase 9: Emit events
    visibilityTracker.update(world);
    checkCooldownReady(world);
    const tickEvents = world.drainEvents();

    // Track damage stats from events
    for (const event of tickEvents) {
      if (event.type === "damaged" && event.data) {
        const sourceId = event.data.sourceId;
        const damage = event.data.damage;
        const sourceStats = robotStats.get(sourceId);
        if (sourceStats) sourceStats.damageDealt += damage;
        const targetStats = robotStats.get(event.robotId);
        if (targetStats) targetStats.damageTaken += damage;
      }
      if (event.type === "destroyed" && event.data) {
        const killedBy = event.data.killedBy;
        const killerStats = robotStats.get(killedBy);
        if (killerStats) killerStats.kills++;
        // Also update the robot's own kill counter for the kills() sensor
        const killerRobot = world.getRobot(killedBy);
        if (killerRobot) killerRobot.kills = (killerRobot.kills ?? 0) + 1;
      }
    }

    // Dispatch emitted events to robot VMs (reactive handlers — no new actions this tick)
    for (const event of tickEvents) {
      if (event.type === "tick" || event.type === "spawn") continue;
      const vm = robotVMs.get(event.robotId);
      if (vm) {
        const robot = world.getRobot(event.robotId);
        if (robot?.alive) {
          vm.executeEvent(event.type, event);
        }
      }
    }

    // Phase 10: Write replay trace — merge movement and combat actions per robot
    const replayActions = new Map();
    for (const [robotId, action] of movementActions) {
      replayActions.set(robotId, { movement: action, combat: combatActions.get(robotId) ?? null });
    }
    for (const [robotId, action] of combatActions) {
      if (!replayActions.has(robotId)) {
        replayActions.set(robotId, { movement: null, combat: action });
      }
    }
    replayWriter.captureFrame(world, tickEvents, replayActions, decisionTraces);

    // Phase 11: Check win conditions
    const winResult = checkWinCondition(world);
    if (winResult.resolved) {
      winner = winResult.winner;
      reason = inSuddenDeath && winResult.reason === "elimination"
        ? "sudden_death_elimination"
        : winResult.reason;
      break;
    }
  }

  if (reason === "max_ticks_reached") {
    const timeoutResolution = determineTimeoutWinner(world, robotStats);
    winner = timeoutResolution.winner;
    reason = timeoutResolution.reason;
  }

  return {
    winner,
    reason,
    tickCount: world.currentTick + 1,
    replay: replayWriter.finalize(),
    robotStats,
    botLogs,
  };
}

function initializeArenaLayout(world) {
  // Every match runs on a hand-crafted, deterministic arena preset. Unknown or
  // missing ids fall back to the default preset via getArenaPreset(), so the
  // layout is always reproducible for a given (preset + seed) pair.
  buildPresetArena(world, getArenaPreset(world.config.arenaId));
}

/**
 * Build the world from a hand-crafted arena preset. Deterministic — no RNG
 * usage at all — so two runs with the same preset + seed are identical and
 * arena selection never destabilizes replays.
 */
function buildPresetArena(world, preset) {
  for (const cp of preset.controlPoints ?? []) {
    world.addControlPoint(vec2(cp.x, cp.y), cp.radius ?? CAPTURE_RADIUS);
  }
  for (const c of preset.covers ?? []) {
    world.addCover(vec2(c.x, c.y), c.w, c.h, !!c.destructible);
  }
  for (const hz of preset.healingZones ?? []) {
    world.addHealingZone(
      vec2(hz.x, hz.y),
      hz.radius ?? HEAL_ZONE_RADIUS,
      hz.healPerTick ?? HEAL_ZONE_TICK_RATE,
    );
  }
  for (const hz of preset.hazards ?? []) {
    world.addHazard(
      vec2(hz.x, hz.y),
      hz.radius ?? HAZARD_ZONE_RADIUS,
      hz.damagePerTick ?? HAZARD_DAMAGE_PER_TICK,
    );
  }
  for (const d of preset.depots ?? []) {
    world.addDepot(vec2(d.x, d.y), d.radius);
  }
}

/** Any robot standing on a resupply depot gets ammo refilled and heat vented. */
function applyDepots(world) {
  for (const depot of world.depots.values()) {
    for (const robot of world.getAliveRobots()) {
      if (distance(robot.position, depot.position) <= depot.radius) {
        robot.ammo = Math.min(robot.maxAmmo ?? 0, (robot.ammo ?? 0) + DEPOT_AMMO_PER_TICK);
        robot.heat = Math.max(0, (robot.heat ?? 0) - DEPOT_HEAT_VENT_PER_TICK);
      }
    }
  }
}

function applyHealingZones(world) {
  for (const zone of world.healingZones.values()) {
    for (const robot of world.getAliveRobots()) {
      if (distance(robot.position, zone.position) <= zone.radius) {
        robot.health = Math.min(robot.maxHealth, robot.health + zone.healPerTick);
      }
    }
  }
}

function applyHazardZones(world) {
  for (const hazard of world.hazards.values()) {
    for (const robot of world.getAliveRobots()) {
      if (distance(robot.position, hazard.position) <= hazard.radius) {
        applyDamage(world, robot, hazard.damagePerTick, "hazard");
      }
    }
  }
}

/** Update each robot's discovery memory with nearby map features */
function updateDiscovery(world) {
  for (const robot of world.getAliveRobots()) {
    const visionRange = CLASS_STATS[robot.class]?.visionRange ?? DEFAULT_VISION_RANGE;

    for (const cover of world.covers.values()) {
      if (distance(robot.position, cover.position) <= visionRange) {
        robot.memory.discoveredCovers.set(cover.id, {
          id: cover.id,
          position: { x: cover.position.x, y: cover.position.y },
          width: cover.width,
          height: cover.height,
        });
      }
    }

    for (const zone of world.healingZones.values()) {
      if (distance(robot.position, zone.position) <= visionRange) {
        robot.memory.discoveredHealZones.set(zone.id, {
          id: zone.id,
          position: { x: zone.position.x, y: zone.position.y },
          radius: zone.radius,
        });
      }
    }

    for (const cp of world.controlPoints.values()) {
      if (distance(robot.position, cp.position) <= visionRange) {
        robot.memory.discoveredControlPoints.set(cp.id, {
          id: cp.id,
          position: { x: cp.position.x, y: cp.position.y },
          owner: cp.owner,
        });
      }
    }

    for (const hazard of world.hazards.values()) {
      if (distance(robot.position, hazard.position) <= visionRange) {
        robot.memory.discoveredHazards.set(hazard.id, {
          id: hazard.id,
          position: { x: hazard.position.x, y: hazard.position.y },
          radius: hazard.radius,
        });
      }
    }
  }
}

function getSpawnPositionForTeam(world, teamId, teamMemberIndex, teamLayout) {
  const { arenaWidth: w, arenaHeight: h } = world.config;
  const cx = w / 2;
  const cy = h / 2;

  // Free-for-all (3+ teams): place every team on a fair ring around the
  // arena centre. Pure trigonometry — no RNG — so replays stay deterministic.
  if (teamLayout && teamLayout.isFFA) {
    const ids = teamLayout.ids;
    const slot = Math.max(0, ids.indexOf(teamId));
    const count = Math.max(1, ids.length);
    const radius = Math.min(w, h) * 0.37;
    // Start at the top and step clockwise; multi-member teams fan slightly.
    const angle = (slot / count) * Math.PI * 2 - Math.PI / 2
      + teamMemberIndex * 0.07;
    return vec2(
      Math.max(6, Math.min(w - 6, cx + Math.cos(angle) * radius)),
      Math.max(6, Math.min(h - 6, cy + Math.sin(angle) * radius)),
    );
  }

  // Standard 2-team match: opposing spawn lanes on the left and right.
  const laneOffsets = [-12, -6, 0, 6, 12];
  const laneOffset = laneOffsets[teamMemberIndex % laneOffsets.length];
  const teamSlot = teamLayout ? Math.max(0, teamLayout.ids.indexOf(teamId)) : (teamId % 2);
  const x = teamSlot === 0 ? w * 0.10 : w * 0.90;
  const y = Math.max(6, Math.min(h - 6, cy + laneOffset));
  return vec2(x, y);
}

/** Resolve utility actions (place_mine, send_signal, mark_position, taunt, overwatch) */
function resolveUtilityAction(world, robot, action, robotStats) {
  switch (action.type) {
    case "place_mine": {
      if (robot.minesPlaced >= MINE_MAX_PER_ROBOT) break;
      const cd = robot.cooldowns.get("mine") ?? 0;
      if (cd > 0) break;
      if (robot.energy < MINE_ENERGY_COST) break;
      world.addMine(robot.id, robot.teamId, robot.position, MINE_DAMAGE);
      robot.minesPlaced++;
      robot.cooldowns.set("mine", MINE_COOLDOWN);
      robot.energy = Math.max(0, robot.energy - MINE_ENERGY_COST);
      break;
    }
    case "send_signal": {
      if (world.currentTick < robot.signalCooldownTick) break;
      world.pendingSignals.push({
        senderId: robot.id,
        teamId: robot.teamId,
        data: action.data ?? null,
        position: { x: robot.position.x, y: robot.position.y },
        range: SIGNAL_RANGE,
        tick: world.currentTick,
      });
      robot.signalCooldownTick = world.currentTick + SIGNAL_COOLDOWN;
      break;
    }
    case "mark_position": {
      const name = action.data;
      if (!name || typeof name !== "string") break;
      robot.memory.waypoints.set(name, { x: robot.position.x, y: robot.position.y });
      break;
    }
    case "taunt": {
      const cd = robot.cooldowns.get("taunt") ?? 0;
      if (cd > 0) break;
      if (robot.energy < TAUNT_ENERGY_COST) break;
      // Taunt nearest visible enemy
      const enemies = [];
      for (const other of world.robots.values()) {
        if (!other.alive || other.teamId === robot.teamId) continue;
        if (distance(robot.position, other.position) <= TAUNT_RANGE) {
          enemies.push(other);
        }
      }
      if (enemies.length > 0) {
        enemies.sort((a, b) => distance(robot.position, a.position) - distance(robot.position, b.position));
        const target = enemies[0];
        target.tauntedBy = robot.id;
        target.tauntExpiresTick = world.currentTick + TAUNT_DURATION;
        robot.cooldowns.set("taunt", TAUNT_COOLDOWN);
        robot.energy = Math.max(0, robot.energy - TAUNT_ENERGY_COST);
      }
      break;
    }
    case "overwatch": {
      const cd = robot.cooldowns.get("overwatch") ?? 0;
      if (cd > 0) break;
      if (robot.energy < OVERWATCH_ENERGY_COST) break;
      robot.overwatchActive = true;
      robot.overwatchExpiresTick = world.currentTick + OVERWATCH_DURATION;
      robot.cooldowns.set("overwatch", OVERWATCH_COOLDOWN);
      robot.energy = Math.max(0, robot.energy - OVERWATCH_ENERGY_COST);
      break;
    }
    case "cloak": {
      // Toggle/start cloak. Hides robot from nearest_enemy/visible_enemies
      // except at very close range. Breaks on any offensive action or damage.
      const cd = robot.cooldowns.get("cloak") ?? 0;
      if (cd > 0) break;
      if (robot.energy < CLOAK_ENERGY_COST) break;
      robot.cloakActive = true;
      robot.cloakExpiresTick = world.currentTick + CLOAK_DURATION;
      robot.cooldowns.set("cloak", CLOAK_COOLDOWN);
      robot.energy = Math.max(0, robot.energy - CLOAK_ENERGY_COST);
      break;
    }
    case "self_destruct": {
      // Arm a detonation countdown. Only available below the HP threshold
      // so it's a desperation tool, not a spam weapon. Once armed it can't
      // be cancelled — this is what makes it dramatic.
      if (robot.selfDestructTick > 0) break;
      if (robot.health / robot.maxHealth > SELF_DESTRUCT_HEALTH_THRESHOLD) break;
      robot.selfDestructTick = world.currentTick + SELF_DESTRUCT_COUNTDOWN;
      break;
    }
  }
}

/** Detonate any armed self-destructs whose countdown has elapsed. */
function resolveSelfDestructs(world, tick) {
  for (const robot of world.getAliveRobots()) {
    // Robot may have been killed earlier in this same phase by another
    // detonation; skip stale entries so we don't detonate corpses.
    if (!robot.alive || robot.health <= 0) continue;
    if (!robot.selfDestructTick || robot.selfDestructTick > tick) continue;
    // Detonate: AoE damage to all robots (friendly fire included — sacrifice play)
    const center = robot.position;
    for (const other of world.getAliveRobots()) {
      if (other.id === robot.id) continue;
      if (distance(other.position, center) <= SELF_DESTRUCT_RADIUS) {
        applyDamage(world, other, SELF_DESTRUCT_DAMAGE, robot.id);
      }
    }
    // Also damage nearby destructible cover
    const coversToRemove = [];
    for (const [coverId, cover] of world.covers) {
      if (!cover.destructible) continue;
      if (distance(cover.position, center) <= SELF_DESTRUCT_RADIUS) {
        cover.health -= SELF_DESTRUCT_DAMAGE;
        if (cover.health <= 0) coversToRemove.push(coverId);
      }
    }
    for (const id of coversToRemove) world.covers.delete(id);
    // Finally destroy the self-destructing robot.
    applyDamage(world, robot, robot.health + 1, robot.id);
    robot.selfDestructTick = 0;
  }
}

/** Detonate mines when enemies step on them */
function detonateMines(world) {
  const toRemove = [];
  for (const [id, mine] of world.mines) {
    for (const robot of world.getAliveRobots()) {
      if (robot.teamId === mine.teamId) continue;
      if (distance(robot.position, mine.position) <= MINE_TRIGGER_RADIUS) {
        applyDamage(world, robot, mine.damage, mine.ownerId);
        toRemove.push(id);
        break;
      }
    }
  }
  for (const id of toRemove) {
    world.mines.delete(id);
  }
}

/** Check if robots are standing on pickups and apply effects */
function collectPickups(world, tick) {
  const toRemove = [];
  for (const [id, pickup] of world.pickups) {
    if (pickup.collected) continue;
    for (const robot of world.getAliveRobots()) {
      if (distance(robot.position, pickup.position) <= PICKUP_COLLECT_RADIUS) {
        pickup.collected = true;
        toRemove.push(id);
        // Apply pickup effect
        switch (pickup.type) {
          case "energy":
            robot.energy = Math.min(robot.maxEnergy, robot.energy + PICKUP_ENERGY_RESTORE);
            break;
          case "speed":
          case "damage":
          case "vision":
            robot.activeEffects.push({ type: pickup.type, expiresTick: tick + PICKUP_EFFECT_DURATION });
            break;
        }
        break;
      }
    }
  }
  for (const id of toRemove) {
    world.pickups.delete(id);
  }
}

/** Spawn a random pickup at a random location */
function spawnRandomPickup(world) {
  if (world.pickups.size >= PICKUP_MAX_ACTIVE) return;
  const { arenaWidth: w, arenaHeight: h } = world.config;
  const types = ["energy", "speed", "damage", "vision"];
  const type = types[world.rng.nextInt(0, types.length - 1)];
  const x = world.rng.nextFloat(10, w - 10);
  const y = world.rng.nextFloat(10, h - 10);
  world.addPickup({ x, y }, type);
}

/** Dispatch pending signals to ally robots as signal_received events */
function dispatchSignals(world, robotVMs) {
  for (const signal of world.pendingSignals) {
    for (const robot of world.getAliveRobots()) {
      if (robot.teamId !== signal.teamId) continue;
      if (robot.id === signal.senderId) continue;
      if (distance(robot.position, signal.position) > signal.range) continue;
      world.emitEvent({
        type: "signal_received",
        tick: world.currentTick,
        robotId: robot.id,
        data: {
          senderId: signal.senderId,
          data: signal.data,
          senderPosition: signal.position,
        },
      });
    }
  }
  world.pendingSignals = [];
}

/** Check if a team has won by eliminating all opponents */
function checkWinCondition(world) {
  const teams = world.getTeamIds();
  const aliveTeams = teams.filter(t => world.getAliveRobotsByTeam(t).length > 0);

  if (aliveTeams.length === 1) {
    return {
      resolved: true,
      winner: aliveTeams[0],
      reason: "elimination",
    };
  }

  if (aliveTeams.length === 0) {
    return {
      resolved: true,
      winner: null,
      reason: "mutual_destruction",
    };
  }

  return {
    resolved: false,
    winner: null,
    reason: "ongoing",
  };
}

function determineTimeoutWinner(world, robotStats) {
  const teams = world.getTeamIds();
  const summary = new Map();

  for (const teamId of teams) {
    summary.set(teamId, {
      aliveCount: 0,
      totalHealth: 0,
      damageDealt: 0,
      controlPointsOwned: 0,
    });
  }

  for (const robot of world.robots.values()) {
    const teamSummary = summary.get(robot.teamId);
    if (!teamSummary) continue;
    if (robot.alive) {
      teamSummary.aliveCount += 1;
      teamSummary.totalHealth += robot.health;
    }
    const stats = robotStats.get(robot.id);
    if (stats) {
      teamSummary.damageDealt += stats.damageDealt;
    }
  }

  for (const cp of world.controlPoints.values()) {
    if (cp.owner !== null && summary.has(cp.owner)) {
      summary.get(cp.owner).controlPointsOwned += 1;
    }
  }

  const rankedTeams = [...summary.entries()].sort((a, b) => {
    const [, aStats] = a;
    const [, bStats] = b;
    if (bStats.aliveCount !== aStats.aliveCount) return bStats.aliveCount - aStats.aliveCount;
    if (bStats.totalHealth !== aStats.totalHealth) return bStats.totalHealth - aStats.totalHealth;
    if (bStats.damageDealt !== aStats.damageDealt) return bStats.damageDealt - aStats.damageDealt;
    if (bStats.controlPointsOwned !== aStats.controlPointsOwned) return bStats.controlPointsOwned - aStats.controlPointsOwned;
    return a[0] - b[0];
  });

  if (rankedTeams.length <= 1) {
    return {
      winner: rankedTeams[0]?.[0] ?? null,
      reason: "max_ticks_reached",
    };
  }

  const [firstTeamId, first] = rankedTeams[0];
  const [, second] = rankedTeams[1];

  if (first.aliveCount !== second.aliveCount) {
    return { winner: firstTeamId, reason: "timeout_alive_tiebreak" };
  }
  if (first.totalHealth !== second.totalHealth) {
    return { winner: firstTeamId, reason: "timeout_health_tiebreak" };
  }
  if (first.damageDealt !== second.damageDealt) {
    return { winner: firstTeamId, reason: "timeout_damage_tiebreak" };
  }
  if (first.controlPointsOwned !== second.controlPointsOwned) {
    return { winner: firstTeamId, reason: "timeout_control_tiebreak" };
  }

  return {
    winner: null,
    reason: "timeout_exact_draw",
  };
}
