// ============================================================================
// Arena Presets — 5 hand-crafted competitive arenas
// ============================================================================
//
// Every match runs on one of these five fixed layouts. There is no procedural
// generation: each arena is authored by hand so bot authors can learn a map,
// tune strategies against it, and trust that a given (preset + seed) pair
// always reproduces the exact same fight.
//
// Each preset has a distinct tactical identity:
//
//   crucible  — Balanced symmetric proving ground. Three control points in a
//               line, mirrored cover. The default and the place to learn.
//   inferno   — Acid arena. A vertical spine of objectives with a ring of
//               hazards guarding the high-value center. Rewards mobility.
//   fortress  — A walled compound. Two defensible side rooms joined by a
//               central chamber. Rewards cover discipline, cloak and flanks.
//   gauntlet  — Three lanes split by long barricades. Funnels combat through
//               a hazard-laced central corridor. Rewards breakthroughs.
//   plains    — Wide open. Four quadrant control points around a single
//               healing oasis. Rewards long range and map control.
//
// Authoring rules (keep every layout fair and legal):
//   * 140×140 playfield. Team spawns sit at (14, 70) and (126, 70); squad
//     members fan out along the spawn lane (y 58..82).
//   * Every layout is mirror-symmetric across the vertical centerline
//     (x = 70) AND the horizontal centerline (y = 70), so neither team — and
//     no lane — has an inherent edge.
//   * No feature's anchor point sits within SPAWN_CLEAR_RADIUS (15 units) of
//     either spawn point.
//
// Cover shape vocabulary (w × h, position is the CENTER of the rectangle):
//   "wall"      — thin + tall, blocks a flank
//   "barricade" — thin + wide, blocks a sightline front/back
//   "block"     — boxy, omnidirectional cover
//   "pillar"    — small point cover
// ============================================================================

import {
  CAPTURE_RADIUS,
  HEAL_ZONE_RADIUS,
  HEAL_ZONE_TICK_RATE,
  HAZARD_ZONE_RADIUS,
  HAZARD_DAMAGE_PER_TICK,
  DEPOT_RADIUS,
} from "../shared/config.js";

// Default preset if none specified
export const DEFAULT_ARENA_ID = "crucible";

// Shorthand cover helper: produces a cover record from (x, y, w, h, destructible).
function cover(x, y, w, h, destructible = false) {
  return { x, y, w, h, destructible };
}

// Shorthand control point / zone / depot helpers
function cp(x, y) { return { x, y, radius: CAPTURE_RADIUS }; }
function heal(x, y, radius = HEAL_ZONE_RADIUS) {
  return { x, y, radius, healPerTick: HEAL_ZONE_TICK_RATE };
}
function hazard(x, y, radius = HAZARD_ZONE_RADIUS) {
  return { x, y, radius, damagePerTick: HAZARD_DAMAGE_PER_TICK };
}
function depot(x, y, radius = DEPOT_RADIUS) { return { x, y, radius }; }

// ============================================================================
// Arena 1: THE CRUCIBLE — Balanced symmetric classic
// ============================================================================
// Three control points on a horizontal line. The two flank points sit inside
// mirrored cover chambers; the center point is framed by barricades and a pair
// of destructible blocks. Clean sightlines, no hazards — pure positioning.
const CRUCIBLE = {
  id: "crucible",
  name: "The Crucible",
  tagline: "Balanced · 3 control points · No hazards",
  description:
    "A fair, symmetric arena with three control points in a line. The flank "
    + "points sit in mirrored cover chambers and the center is framed by "
    + "destructible blocks. No tricks — just positioning, resource management "
    + "and clean combat. The default competitive map and the place to learn.",
  difficulty: "Beginner",
  accent: "#00d4ff",
  recommendedModes: ["duel_1v1", "squad_2v2"],
  covers: [
    // Flank control-point chambers — barricades frame the side points
    cover(37, 57, 16, 3),
    cover(37, 83, 16, 3),
    cover(103, 57, 16, 3),
    cover(103, 83, 16, 3),
    // Center control point — barricades north/south, destructible side blocks
    cover(70, 53, 16, 3),
    cover(70, 87, 16, 3),
    cover(59, 70, 3, 12, true),
    cover(81, 70, 3, 12, true),
    // Mid-field corner pillars — partial sightline breaks on the diagonals
    cover(52, 33, 5, 5),
    cover(88, 33, 5, 5),
    cover(52, 107, 5, 5),
    cover(88, 107, 5, 5),
  ],
  controlPoints: [cp(35, 70), cp(70, 70), cp(105, 70)],
  healingZones: [heal(70, 24), heal(70, 116)],
  hazards: [],
  depots: [depot(47, 70), depot(93, 70)],
};

// ============================================================================
// Arena 2: INFERNO — Hazard ring around a contested center
// ============================================================================
// The three control points run on a vertical spine. A diamond of acid pools
// rings the high-value center point — reachable, but never safely. Outer
// pools punish lazy rotations. Sparse cover keeps everyone exposed.
const INFERNO = {
  id: "inferno",
  name: "Inferno",
  tagline: "Hazardous · 3 control points · Mobility focused",
  description:
    "Acid pools ring the high-value center control point — you can hold it, "
    + "but never safely. The objectives run on a vertical spine and outer "
    + "pools punish careless rotations. Sparse cover rewards bots that manage "
    + "heat well and keep moving.",
  difficulty: "Advanced",
  accent: "#ff8800",
  recommendedModes: ["duel_1v1", "squad_2v2"],
  covers: [
    // Walls flanking the center objective
    cover(52, 70, 3, 14),
    cover(88, 70, 3, 14),
    // Barricades behind the north / south control points
    cover(70, 20, 14, 3),
    cover(70, 120, 14, 3),
    // Corner blocks — the only cover out on the flanks
    cover(32, 50, 5, 5),
    cover(108, 50, 5, 5),
    cover(32, 90, 5, 5),
    cover(108, 90, 5, 5),
  ],
  controlPoints: [cp(70, 70), cp(70, 32), cp(70, 108)],
  healingZones: [heal(34, 70, 4.5), heal(106, 70, 4.5)],
  hazards: [
    // Diamond of acid around the center control point
    hazard(70, 53, 4),
    hazard(70, 87, 4),
    hazard(53, 70, 4),
    hazard(87, 70, 4),
    // Outer pools punishing wide rotations
    hazard(44, 44, 3.5),
    hazard(96, 44, 3.5),
    hazard(44, 96, 3.5),
    hazard(96, 96, 3.5),
  ],
  depots: [depot(70, 44), depot(70, 96)],
};

// ============================================================================
// Arena 3: FORTRESS — Walled compound, two side rooms + central chamber
// ============================================================================
// Two defensible rooms hold the flank control points, each with a single
// doorway toward the middle. A central chamber with a destructible corridor
// connects them. Dense cover, no hazards — stealth, overwatch and flanking.
const FORTRESS = {
  id: "fortress",
  name: "Fortress",
  tagline: "Dense cover · 2 control points · Stealth friendly",
  description:
    "A walled compound: two defensible rooms hold the flank control points, "
    + "each entered through a single doorway, joined by a central chamber and "
    + "a destructible corridor. Overlapping sightlines and tight lanes reward "
    + "patient positioning, cloak and overwatch play.",
  difficulty: "Tactical",
  accent: "#aa55ff",
  recommendedModes: ["duel_1v1", "squad_2v2"],
  covers: [
    // Left room — walls enclose the flank control point, doorway faces center
    cover(44, 52, 26, 3),
    cover(44, 88, 26, 3),
    cover(57, 61, 3, 8),
    cover(57, 79, 3, 8),
    // Right room — mirror image
    cover(96, 52, 26, 3),
    cover(96, 88, 26, 3),
    cover(83, 61, 3, 8),
    cover(83, 79, 3, 8),
    // Central chamber — barricades north/south, destructible corridor pillars
    cover(70, 42, 18, 3),
    cover(70, 98, 18, 3),
    cover(70, 62, 3, 7, true),
    cover(70, 78, 3, 7, true),
    // Outer flank pillars covering the spawn approaches
    cover(30, 36, 5, 5),
    cover(110, 36, 5, 5),
    cover(30, 104, 5, 5),
    cover(110, 104, 5, 5),
  ],
  controlPoints: [cp(40, 70), cp(100, 70)],
  healingZones: [heal(34, 70), heal(106, 70)],
  hazards: [],
  depots: [depot(70, 26), depot(70, 114)],
};

// ============================================================================
// Arena 4: THE GAUNTLET — Three lanes, central hazard corridor
// ============================================================================
// Long barricades split the field into a top lane, a bottom lane and the
// central objective lane. The lanes only connect through the central corridor
// or the map edges. Choke hazards guard the center control point.
const GAUNTLET = {
  id: "gauntlet",
  name: "The Gauntlet",
  tagline: "Linear · 3 control points · Chokepoint hazards",
  description:
    "Long barricades split the field into a top lane, a bottom lane and the "
    + "central objective lane — connected only through the middle corridor or "
    + "the map edges. Choke hazards guard the center point, rewarding "
    + "breakthrough tactics, area denial and well-timed grenades.",
  difficulty: "Tactical",
  accent: "#ffdd00",
  recommendedModes: ["duel_1v1", "squad_2v2"],
  covers: [
    // Long barricades dividing the three lanes (gaps at center + edges)
    cover(44, 50, 32, 3),
    cover(96, 50, 32, 3),
    cover(44, 90, 32, 3),
    cover(96, 90, 32, 3),
    // Center control point — destructible cover on each side
    cover(58, 70, 3, 8, true),
    cover(82, 70, 3, 8, true),
    // Flank control points — framed by short walls in the objective lane
    cover(40, 62, 10, 3),
    cover(40, 78, 10, 3),
    cover(100, 62, 10, 3),
    cover(100, 78, 10, 3),
    // Top + bottom lane pillars
    cover(40, 32, 5, 5),
    cover(100, 32, 5, 5),
    cover(40, 108, 5, 5),
    cover(100, 108, 5, 5),
  ],
  controlPoints: [cp(40, 70), cp(70, 70), cp(100, 70)],
  healingZones: [heal(70, 26), heal(70, 114)],
  hazards: [
    hazard(70, 58, 3.5),
    hazard(70, 82, 3.5),
  ],
  depots: [depot(70, 40), depot(70, 100)],
};

// ============================================================================
// Arena 5: OPEN PLAINS — Wide open, four quadrant objectives
// ============================================================================
// Almost no cover. Four control points anchor the quadrants and a single
// large healing oasis sits at dead center as the contested prize.
const PLAINS = {
  id: "plains",
  name: "Open Plains",
  tagline: "Wide open · 4 control points · Long-range",
  description:
    "A wide open battlefield with four quadrant control points and a single "
    + "central healing oasis as the contested prize. Only four pillars and a "
    + "pair of destructible blocks break line of sight. Rewards long-range "
    + "weapons, vision control and fast mobility.",
  difficulty: "Advanced",
  accent: "#00ff88",
  recommendedModes: ["duel_1v1", "squad_2v2"],
  covers: [
    // Four quadrant pillars
    cover(48, 48, 5, 5),
    cover(92, 48, 5, 5),
    cover(48, 92, 5, 5),
    cover(92, 92, 5, 5),
    // Destructible blocks giving the central oasis minimal cover
    cover(70, 60, 8, 3, true),
    cover(70, 80, 8, 3, true),
  ],
  controlPoints: [cp(38, 38), cp(102, 38), cp(38, 102), cp(102, 102)],
  healingZones: [heal(70, 70, 6)],
  hazards: [],
  depots: [depot(70, 32), depot(70, 108)],
};

// ============================================================================
// Arena 6: THE NEXUS — Open free-for-all arena
// ============================================================================
// Built for battle royale. Four-fold rotationally symmetric so a ring of
// combatants spawned around the perimeter is fair to everyone. An open field
// with a central healing prize, a ring of pillar cover, and four depots —
// also legal for standard 2-team play (spawn lanes are kept clear).
const NEXUS = {
  id: "nexus",
  name: "The Nexus",
  tagline: "Free-for-all · Open · Radial",
  description:
    "A four-fold symmetric free-for-all arena built for battle royale. "
    + "Combatants ring the perimeter and converge on a central healing prize "
    + "past two rings of pillar cover. Open sightlines and four depots reward "
    + "mobility, target priority and never standing still.",
  difficulty: "Free-for-all",
  accent: "#ff4d8d",
  recommendedModes: ["battle_royale", "squad_2v2"],
  covers: [
    // Inner pillar ring — cardinals
    cover(70, 50, 4, 4),
    cover(90, 70, 4, 4),
    cover(70, 90, 4, 4),
    cover(50, 70, 4, 4),
    // Inner pillar ring — diagonals
    cover(56, 56, 4, 4),
    cover(84, 56, 4, 4),
    cover(84, 84, 4, 4),
    cover(56, 84, 4, 4),
    // Outer cover blocks on the diagonals — break perimeter sightlines
    cover(36, 36, 6, 6),
    cover(104, 36, 6, 6),
    cover(104, 104, 6, 6),
    cover(36, 104, 6, 6),
  ],
  controlPoints: [cp(70, 70), cp(46, 46), cp(94, 46), cp(94, 94), cp(46, 94)],
  healingZones: [heal(70, 70, 5.5)],
  hazards: [],
  depots: [depot(32, 70), depot(108, 70), depot(70, 32), depot(70, 108)],
};

// ============================================================================
// Registry + accessors
// ============================================================================

export const ARENA_PRESETS = {
  [CRUCIBLE.id]: CRUCIBLE,
  [INFERNO.id]: INFERNO,
  [FORTRESS.id]: FORTRESS,
  [GAUNTLET.id]: GAUNTLET,
  [PLAINS.id]: PLAINS,
  [NEXUS.id]: NEXUS,
};

/** Ordered list used by UI so the selector is stable and deterministic. */
export const ARENA_PRESET_ORDER = [
  "crucible",
  "inferno",
  "fortress",
  "gauntlet",
  "plains",
  "nexus",
];

/**
 * Returns the preset object for a given id, or the default preset if the
 * id is unknown/missing. Never returns null so callers don't have to
 * null-check.
 */
export function getArenaPreset(id) {
  if (id && Object.prototype.hasOwnProperty.call(ARENA_PRESETS, id)) {
    return ARENA_PRESETS[id];
  }
  return ARENA_PRESETS[DEFAULT_ARENA_ID];
}

/** True if the given id refers to a known arena preset. */
export function isKnownArenaId(id) {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(ARENA_PRESETS, id);
}
