// ============================================================================
// Movement Resolution — Position updates, collision, arena bounds
// ============================================================================

import { add, sub, normalize, scale, distance, clamp, vec2, length } from "../shared/vec2.js";
import { CLASS_STATS, ROBOT_MOVE_SPEED, ROBOT_RADIUS } from "../shared/config.js";

/** Resolve a movement action for a robot */
export function resolveMovement(world, robot, action) {
  if (!action || !robot.alive) {
    robot.velocity = vec2(0, 0);
    return;
  }

  const stats = CLASS_STATS[robot.class];
  let moveSpeed = stats?.moveSpeed ?? ROBOT_MOVE_SPEED;
  // Apply speed pickup effect
  if (robot.activeEffects?.some(e => e.type === "speed")) {
    moveSpeed *= 1.5; // PICKUP_SPEED_MULTIPLIER
  }

  switch (action.type) {
    case "move_to": {
      const target = resolveTargetPosition(world, action);
      if (!target) break;
      const navigationTarget = getNavigationTarget(world, robot, target);
      const diff = sub(navigationTarget, robot.position);
      const dist = length(diff);
      if (dist < 0.1) {
        robot.velocity = vec2(0, 0);
      } else {
        const dir = normalize(diff);
        const speed = Math.min(moveSpeed, dist);
        robot.velocity = scale(dir, speed);
        robot.heading = dir;
      }
      break;
    }

    case "move_toward": {
      const target = resolveTargetPosition(world, action);
      if (!target) break;
      const navigationTarget = getNavigationTarget(world, robot, target);
      const diff = sub(navigationTarget, robot.position);
      const dir = normalize(diff);
      // If already at the target, don't update heading to zero vector
      if (dir.x === 0 && dir.y === 0) {
        robot.velocity = vec2(0, 0);
      } else {
        robot.velocity = scale(dir, moveSpeed);
        robot.heading = dir;
      }
      break;
    }

    case "strafe_left": {
      // Perpendicular to heading, counter-clockwise
      const dir = vec2(-robot.heading.y, robot.heading.x);
      robot.velocity = scale(dir, moveSpeed);
      break;
    }

    case "move_forward": {
      const dir = normalize(robot.heading);
      robot.velocity = scale(dir, moveSpeed);
      break;
    }

    case "move_backward": {
      const dir = normalize(scale(robot.heading, -1));
      robot.velocity = scale(dir, moveSpeed);
      break;
    }

    case "turn_left": {
      const angle = Math.PI / 10;
      const dir = normalize(vec2(
        (robot.heading.x * Math.cos(angle)) - (robot.heading.y * Math.sin(angle)),
        (robot.heading.x * Math.sin(angle)) + (robot.heading.y * Math.cos(angle)),
      ));
      robot.heading = dir;
      robot.velocity = vec2(0, 0);
      break;
    }

    case "turn_right": {
      const angle = -Math.PI / 10;
      const dir = normalize(vec2(
        (robot.heading.x * Math.cos(angle)) - (robot.heading.y * Math.sin(angle)),
        (robot.heading.x * Math.sin(angle)) + (robot.heading.y * Math.cos(angle)),
      ));
      robot.heading = dir;
      robot.velocity = vec2(0, 0);
      break;
    }

    case "strafe_right": {
      // Perpendicular to heading, clockwise
      const dir = vec2(robot.heading.y, -robot.heading.x);
      robot.velocity = scale(dir, moveSpeed);
      break;
    }

    case "retreat": {
      // Move away from nearest enemy
      const enemies = [...world.robots.values()].filter(r => r.alive && r.teamId !== robot.teamId);
      if (enemies.length > 0) {
        let nearest = enemies[0];
        let nearestDist = distance(robot.position, nearest.position);
        for (const e of enemies) {
          const d = distance(robot.position, e.position);
          if (d < nearestDist) {
            nearestDist = d;
            nearest = e;
          }
        }
        const diff = sub(robot.position, nearest.position);
        const dir = normalize(diff);
        // If coincident with enemy, pick an arbitrary retreat direction
        if (dir.x === 0 && dir.y === 0) {
          robot.velocity = scale({ x: 1, y: 0 }, moveSpeed);
        } else {
          robot.velocity = scale(dir, moveSpeed);
          robot.heading = dir;
        }
      } else {
        robot.velocity = vec2(0, 0);
      }
      break;
    }

    case "stop":
    default:
      robot.velocity = vec2(0, 0);
      break;
  }
}

/** Apply velocity to position with arena bounds clamping */
export function applyMovement(world, robot) {
  if (!robot.alive) return;

  const oldPos = robot.position;
  const newPos = add(robot.position, robot.velocity);
  const clamped = clamp(
    newPos,
    ROBOT_RADIUS,
    ROBOT_RADIUS,
    world.config.arenaWidth - ROBOT_RADIUS,
    world.config.arenaHeight - ROBOT_RADIUS,
  );

  if (isInsideCover(world, clamped)) {
    const slideX = clamp(
      vec2(clamped.x, oldPos.y),
      ROBOT_RADIUS,
      ROBOT_RADIUS,
      world.config.arenaWidth - ROBOT_RADIUS,
      world.config.arenaHeight - ROBOT_RADIUS,
    );
    if (!isInsideCover(world, slideX)) {
      robot.position = slideX;
      return;
    }

    const slideY = clamp(
      vec2(oldPos.x, clamped.y),
      ROBOT_RADIUS,
      ROBOT_RADIUS,
      world.config.arenaWidth - ROBOT_RADIUS,
      world.config.arenaHeight - ROBOT_RADIUS,
    );
    if (!isInsideCover(world, slideY)) {
      robot.position = slideY;
      return;
    }

    robot.position = oldPos;
    robot.velocity = vec2(0, 0);
    return;
  }

  robot.position = clamped;
}

/** Resolve simple robot-robot collision (push apart) */
export function resolveCollisions(world) {
  const alive = world.getAliveRobots();
  const minDist = ROBOT_RADIUS * 2;

  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i];
      const b = alive[j];
      const dist = distance(a.position, b.position);
      if (dist < minDist) {
        const overlap = (minDist - dist) / 2;
        // If robots are nearly coincident, push apart along an arbitrary axis
        const dir = dist > 0.001 ? normalize(sub(b.position, a.position)) : { x: 1, y: 0 };
        const newA = sub(a.position, scale(dir, overlap));
        const newB = add(b.position, scale(dir, overlap));

        // Re-clamp to arena
        const clampedA = clamp(newA, ROBOT_RADIUS, ROBOT_RADIUS,
          world.config.arenaWidth - ROBOT_RADIUS, world.config.arenaHeight - ROBOT_RADIUS);
        const clampedB = clamp(newB, ROBOT_RADIUS, ROBOT_RADIUS,
          world.config.arenaWidth - ROBOT_RADIUS, world.config.arenaHeight - ROBOT_RADIUS);

        // Only apply if new position isn't inside cover
        if (!isInsideCover(world, clampedA)) a.position = clampedA;
        if (!isInsideCover(world, clampedB)) b.position = clampedB;
      }
    }
  }
}

function isInsideCover(world, position) {
  for (const cover of world.covers.values()) {
    const halfW = cover.width / 2 + ROBOT_RADIUS;
    const halfH = cover.height / 2 + ROBOT_RADIUS;
    const inX = position.x >= cover.position.x - halfW && position.x <= cover.position.x + halfW;
    const inY = position.y >= cover.position.y - halfH && position.y <= cover.position.y + halfH;
    if (inX && inY) return true;
  }
  return false;
}

/** Resolve target from action intent — could be a position, entity ID, or entity object */
function resolveTargetPosition(world, action) {
  const target = action.target;
  if (target == null) return null;

  if (typeof target === "string") {
    // Entity ID
    const entity = world.getRobot(target);
    if (entity) return entity.position;
    const cp = world.controlPoints.get(target);
    if (cp) return cp.position;
    return null;
  }

  if (typeof target !== "object") return null;

  // Direct position
  if ("x" in target && "y" in target) {
    return target;
  }

  // Sensor objects often include { id, position, ... }.
  if ("position" in target && target.position &&
      typeof target.position === "object" &&
      "x" in target.position && "y" in target.position) {
    return target.position;
  }

  return null;
}

function getNavigationTarget(world, robot, target) {
  const blockingCover = firstBlockingCover(world, robot.position, target);
  if (!blockingCover) return target;
  return chooseCoverDetour(world, robot.position, target, blockingCover);
}

function firstBlockingCover(world, from, to) {
  let blockingCover = null;
  let nearestIntersection = Infinity;
  for (const cover of world.covers.values()) {
    if (!segmentIntersectsExpandedRect(from, to, cover, ROBOT_RADIUS + 0.2)) continue;
    const dx = cover.position.x - from.x;
    const dy = cover.position.y - from.y;
    const distSq = (dx * dx) + (dy * dy);
    if (distSq < nearestIntersection) {
      nearestIntersection = distSq;
      blockingCover = cover;
    }
  }
  return blockingCover;
}

function chooseCoverDetour(world, from, to, cover) {
  const margin = ROBOT_RADIUS + 0.75;
  const minX = ROBOT_RADIUS;
  const minY = ROBOT_RADIUS;
  const maxX = world.config.arenaWidth - ROBOT_RADIUS;
  const maxY = world.config.arenaHeight - ROBOT_RADIUS;

  const candidates = [
    // Above/below
    clamp(vec2(cover.position.x, cover.position.y - (cover.height / 2) - margin), minX, minY, maxX, maxY),
    clamp(vec2(cover.position.x, cover.position.y + (cover.height / 2) + margin), minX, minY, maxX, maxY),
    // Left/right
    clamp(vec2(cover.position.x - (cover.width / 2) - margin, cover.position.y), minX, minY, maxX, maxY),
    clamp(vec2(cover.position.x + (cover.width / 2) + margin, cover.position.y), minX, minY, maxX, maxY),
  ];

  // Filter out candidates that sit inside another cover, or that are blocked
  // from `from` by yet another cover — picking those wedges the bot flush
  // against the next obstacle with no escape route. If every candidate is
  // unreachable, fall back to the cheapest one anyway (better to be wedged
  // briefly than to refuse to move at all).
  const reachable = candidates.filter(pt => {
    for (const other of world.covers.values()) {
      if (other === cover) continue;
      const halfW = other.width / 2;
      const halfH = other.height / 2;
      // Point inside another cover?
      if (pt.x >= other.position.x - halfW && pt.x <= other.position.x + halfW &&
          pt.y >= other.position.y - halfH && pt.y <= other.position.y + halfH) {
        return false;
      }
      // Path from start blocked by another cover?
      if (segmentIntersectsExpandedRect(from, pt, other, ROBOT_RADIUS)) {
        return false;
      }
    }
    return true;
  });

  const pool = reachable.length > 0 ? reachable : candidates;
  let bestCost = Infinity;
  let best = pool[0];
  for (const pt of pool) {
    const cost = distance(from, pt) + distance(pt, to);
    if (cost < bestCost) {
      bestCost = cost;
      best = pt;
    }
  }
  return best;
}

function segmentIntersectsExpandedRect(start, end, cover, padding) {
  const halfW = (cover.width / 2) + padding;
  const halfH = (cover.height / 2) + padding;
  const minX = cover.position.x - halfW;
  const maxX = cover.position.x + halfW;
  const minY = cover.position.y - halfH;
  const maxY = cover.position.y + halfH;

  const startInside = start.x >= minX && start.x <= maxX && start.y >= minY && start.y <= maxY;
  const endInside = end.x >= minX && end.x <= maxX && end.y >= minY && end.y <= maxY;
  if (startInside || endInside) return true;

  const corners = [
    vec2(minX, minY),
    vec2(maxX, minY),
    vec2(maxX, maxY),
    vec2(minX, maxY),
  ];

  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    if (segmentsIntersect(start, end, a, b)) return true;
  }

  return false;
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (o1 !== o2 && o3 !== o4) return true;
  return false;
}

function orientation(p, q, r) {
  const v = ((q.y - p.y) * (r.x - q.x)) - ((q.x - p.x) * (r.y - q.y));
  if (Math.abs(v) < 0.000001) return 0;
  return v > 0 ? 1 : 2;
}
