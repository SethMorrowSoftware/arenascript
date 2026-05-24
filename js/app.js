// ============================================================================
// ArenaScript Frontend — Main Application
// ============================================================================

import { compile } from "./lang/pipeline.js";
import { runMatch } from "./engine/tick.js";
import {
  ARENA_WIDTH, ARENA_HEIGHT,
  CLASS_STATS, ENGINE_VERSION,
} from "./shared/config.js";
import { Telemetry } from "./shared/telemetry.js";
import { computeBookmarks } from "./engine/replay.js";
import {
  ARENA_PRESETS,
  ARENA_PRESET_ORDER,
  DEFAULT_ARENA_ID,
  getArenaPreset,
} from "./engine/arena-presets.js";
import * as BotLibrary from "./bot-library.js";
import * as ApiClient from "./api-client.js";
import * as SFX from "./ui/sfx.js";
import * as Achievements from "./ui/achievements.js";
import * as MatchStats from "./ui/match-stats.js";
import { generateShareCard, downloadBlob } from "./ui/share-card.js";
import {
  installShortcutHelp,
  installLangReference,
  installCommandPalette,
  installEditorAutocomplete,
  installOnboarding,
  showMatchLoading,
  updateMatchLoading,
  hideMatchLoading,
  recordMatchHistory,
  getMatchHistory,
  clearMatchHistory,
} from "./ui/enhanced.js";

const telemetry = Telemetry.instance();
let currentUser = null;
let currentEditorRemoteBotId = null;

// ============================================================================
// Example Bot Source Code
// ============================================================================

const BOT_PRESETS = {
  bruiser: {
    name: "Bruiser",
    class: "brawler",
    source: `robot "Bruiser" version "3.0"

meta {
  author: "ArenaLab"
  class: "brawler"
}

const {
  HEAL_THRESHOLD = 50
  TURN_INTERVAL = 20
}

state {
  ticks_moving: number = 0
}

on spawn {
  mark_position "home"
  set ticks_moving = 0
}

on tick {
  if is_in_hazard() {
    turn_right
    move_forward
    return
  }

  let enemy = nearest_enemy()

  if enemy != null {
    if can_attack(enemy) {
      attack enemy
    } else {
      move_toward enemy.position
    }
    return
  }

  let mine = nearest_mine()
  if mine != null and mine.distance < 3 {
    turn_right
    move_forward
    return
  }

  if health() < HEAL_THRESHOLD {
    let heal = nearest_heal_zone()
    if heal != null {
      move_to heal.position
      return
    }
  }

  let pickup = nearest_pickup()
  if pickup != null {
    move_to pickup.position
    return
  }

  set ticks_moving = ticks_moving + 1
  if wall_ahead(3) {
    turn_right
    set ticks_moving = 0
    return
  }
  if ticks_moving > TURN_INTERVAL {
    let dir = random(1, 3)
    if dir == 1 { turn_left } else { turn_right }
    set ticks_moving = 0
    return
  }
  move_forward
}

on damaged(event) {
  if health() < 30 {
    let heal = nearest_heal_zone()
    if heal != null {
      move_to heal.position
    }
  }
}

on signal_received(event) {
  move_toward event.senderPosition
}`,
  },

  kiter: {
    name: "Kiter",
    class: "ranger",
    source: `robot "Kiter" version "3.0"

meta {
  author: "ArenaLab"
  class: "ranger"
}

const {
  SAFE_HEALTH = 40
  KITE_RANGE = 6
}

state {
  retreating: boolean = false
  strafing_dir: number = 1
}

on spawn {
  set retreating = false
  set strafing_dir = 1
  place_mine
  every 60 {
    let sound = nearest_sound()
    if sound != null {
      send_signal sound.position
    }
  }
}

on tick {
  if is_in_hazard() {
    move_forward
    return
  }

  let enemy = nearest_enemy()

  if enemy == null {
    set retreating = false
    let sound = nearest_sound()
    if sound != null {
      move_toward sound.position
      return
    }
    let cp = nearest_control_point()
    if cp != null {
      move_to cp.position
    } else {
      if wall_ahead(4) {
        turn_right
      } else {
        move_forward
      }
    }
    return
  }

  if health() < SAFE_HEALTH {
    set retreating = true
    let heal = nearest_heal_zone()
    if heal != null {
      move_to heal.position
      return
    }
    retreat
    return
  }

  set retreating = false
  let dist = distance_to(enemy.position)

  if dist < KITE_RANGE {
    if can_attack(enemy) {
      fire_at enemy.position
    }
    retreat
    return
  }

  // Stay defensive while the retreating flag is set — keep distance even if
  // we technically have the shot, so a recovering kiter doesn't re-engage
  // before reaching a heal zone.
  if retreating {
    retreat
    return
  }

  if can_attack(enemy) {
    fire_at enemy.position
    if strafing_dir > 0 { strafe_right } else { strafe_left }
  } else {
    move_toward enemy.position
  }
}

on damaged {
  set strafing_dir = strafing_dir * -1
}

on low_health {
  set retreating = true
}`,
  },

  fortress: {
    name: "Fortress",
    class: "tank",
    source: `robot "Fortress" version "3.0"

meta {
  author: "ArenaLab"
  class: "tank"
}

const {
  HOLD_THRESHOLD = 80
  SHIELD_THRESHOLD = 60
}

state {
  has_position: boolean = false
}

on spawn {
  set has_position = false
  mark_position "spawn"
}

on tick {
  if is_in_hazard() {
    move_forward
    return
  }

  if is_taunted() {
    shield
  }

  if not has_position {
    let cp = nearest_control_point()
    if cp != null {
      move_to cp.position
      if distance_to(cp.position) < 4 {
        set has_position = true
        mark_position "hold"
        place_mine
      }
      return
    }
    if wall_ahead(3) { turn_left } else { move_forward }
    return
  }

  if health() < SHIELD_THRESHOLD {
    shield
  }

  let enemy = nearest_enemy()
  if enemy != null {
    taunt
    if can_attack(enemy) {
      attack enemy
    } else {
      let dist = distance_to(enemy.position)
      if dist < 12 {
        move_toward enemy.position
      }
    }
    return
  }

  if health() < HOLD_THRESHOLD {
    let heal = nearest_heal_zone()
    if heal != null {
      set has_position = false
      move_to heal.position
      return
    }
  }

  let cp = nearest_enemy_control_point()
  if cp != null {
    set has_position = false
    move_to cp.position
  }
}

on damaged {
  if health() < 45 {
    shield
  }
  send_signal "under_attack"
}`,
  },

  healer: {
    name: "Survivor",
    class: "support",
    source: `robot "Survivor" version "3.0"

meta {
  author: "ArenaLab"
  class: "support"
}

const {
  FLEE_HEALTH = 45
  SAFE_HEALTH = 70
}

state {
  healing: boolean = false
}

fn find_safety() {
  let heal = nearest_heal_zone()
  if heal != null {
    move_to heal.position
    return
  }
  let cover = nearest_cover()
  if cover != null {
    move_to cover
  } else {
    retreat
  }
}

on spawn {
  mark_position "spawn"
  every 45 {
    let pickup = nearest_pickup()
    if pickup != null {
      if pickup.type == "energy" {
        mark_position "energy_spot"
      }
    }
  }
}

on tick {
  if is_in_hazard() {
    move_forward
    return
  }

  if is_in_heal_zone() and health() < max_health() {
    set healing = true
    mark_position "heal_spot"
    let enemy = nearest_enemy()
    if enemy != null and can_attack(enemy) {
      attack enemy
    }
    stop
    return
  }

  // While recovering from a heal zone but still below safe HP, stay defensive
  // instead of re-engaging on the next tick.
  if healing and health() < SAFE_HEALTH {
    find_safety()
    return
  }
  set healing = false

  if health() < FLEE_HEALTH {
    find_safety()
    return
  }

  let pickup = nearest_pickup()
  if pickup != null and pickup.type == "energy" {
    move_to pickup.position
    return
  }

  let enemy = nearest_enemy()
  if enemy != null {
    if is_enemy_facing_me(enemy) and health() < SAFE_HEALTH {
      find_safety()
      return
    }
    if can_attack(enemy) {
      attack enemy
    } else {
      let dist = distance_to(enemy.position)
      if dist < 10 and health() < SAFE_HEALTH {
        find_safety()
      } else {
        move_toward enemy.position
      }
    }
    return
  }

  let cp = nearest_control_point()
  if cp != null {
    move_to cp.position
  } else {
    if wall_ahead(3) { turn_right } else { move_forward }
  }
}

on low_health {
  find_safety()
}

on damaged {
  if health() < FLEE_HEALTH {
    send_signal "need_help"
    find_safety()
  }
}`,
  },

  flanker: {
    name: "Flanker",
    class: "ranger",
    source: `robot "Flanker" version "3.0"

meta {
  author: "ArenaLab"
  class: "ranger"
}

const {
  ENGAGE_HEALTH = 35
}

state {
  flanking: boolean = true
  sweep_angle: number = 0
}

on spawn {
  set flanking = true
  set sweep_angle = 0
  place_mine
  after 30 {
    place_mine
  }
}

on tick {
  if is_in_hazard() {
    strafe_left
    return
  }

  let enemy = nearest_enemy()

  if enemy == null {
    let sound = nearest_sound()
    if sound != null {
      move_toward sound.position
      return
    }
    set sweep_angle = sweep_angle + 1
    if wall_ahead(4) {
      turn_right
      turn_right
    } else {
      move_forward
    }
    if sweep_angle > 15 {
      turn_right
      set sweep_angle = 0
    }
    return
  }

  if health() < ENGAGE_HEALTH {
    let heal = nearest_heal_zone()
    if heal != null {
      move_to heal.position
      return
    }
    retreat
    return
  }

  let dist = distance_to(enemy.position)

  if dist > 10 and flanking {
    if not is_enemy_facing_me(enemy) {
      move_toward enemy.position
      return
    }
    if wall_ahead(3) { turn_left }
    strafe_right
    return
  }

  set flanking = false

  if can_attack(enemy) {
    let angle = angle_to(enemy.position)
    fire_at enemy.position
    if angle > 0 { strafe_right } else { strafe_left }
  } else {
    move_toward enemy.position
  }
}

on enemy_seen {
  set flanking = true
  set sweep_angle = 0
  send_signal "contact"
}

on damaged {
  set flanking = false
}`,
  },

  sentinel: {
    name: "Sentinel",
    class: "tank",
    source: `robot "Sentinel" version "3.0"

meta {
  author: "ArenaLab"
  class: "tank"
}

const {
  PATROL_WAIT = 30
  ENGAGE_RANGE = 8
}

state {
  wait_timer: number = 0
  patrolling: boolean = true
}

fn patrol() {
  if wall_ahead(3) {
    turn_right
    return
  }
  let cp = nearest_control_point()
  if cp != null {
    if distance_to(cp.position) < 4 {
      set wait_timer = wait_timer + 1
      if wait_timer > PATROL_WAIT {
        set wait_timer = 0
        turn_right
        turn_right
        turn_right
      }
      overwatch
      stop
      return
    }
    move_to cp.position
    return
  }
  move_forward
}

on spawn {
  mark_position "base"
  place_mine
  after 20 {
    place_mine
  }
}

on tick {
  if is_in_hazard() {
    move_backward
    return
  }

  if health() < 40 {
    shield
    let heal = nearest_heal_zone()
    if heal != null {
      move_to heal.position
      return
    }
  }

  let enemy = nearest_enemy()

  if enemy == null {
    set patrolling = true
    patrol()
    return
  }

  set patrolling = false
  set wait_timer = 0

  if is_in_overwatch() {
    if can_attack(enemy) {
      attack enemy
    }
    return
  }

  if can_attack(enemy) {
    attack enemy
    taunt
  } else {
    let dist = distance_to(enemy.position)
    if dist < ENGAGE_RANGE {
      move_toward enemy.position
    } else {
      if health() < 65 {
        shield
        stop
      } else {
        move_toward enemy.position
      }
    }
  }
}

on damaged {
  if health() < 50 {
    shield
  }
  set patrolling = false
  send_signal "engaged"
}

on signal_received(event) {
  if patrolling {
    move_toward event.senderPosition
  }
}`,
  },

  hivemind: {
    name: "Hivemind",
    class: "brawler",
    source: `robot "Hivemind" version "1.0"

// Squad-aware brawler that uses hive memory to coordinate focus fire.
// The robot with the lowest squad index calls the target; others confirm
// and converge. Breaks off for healing only when dying alone.

meta {
  author: "ArenaLab"
  class: "brawler"
}

const {
  HEAL_THRESHOLD = 40
  PANIC_HEALTH = 22
}

state {
  role: string = "striker"
  wander_ticks: number = 0
}

on spawn {
  mark_position "home"
  set role = "striker"
  if my_index() == 0 {
    set role = "caller"
  }
}

fn call_focus_target() {
  let e = weakest_visible_enemy()
  if e != null {
    hive_set("focus_id", e.id)
    hive_set("focus_x", e.position.x)
    hive_set("focus_y", e.position.y)
    hive_set("focus_tick", current_tick())
  }
}

fn resolve_focus() {
  if not hive_has("focus_tick") { return null }
  let set_tick = hive_get("focus_tick")
  if current_tick() - set_tick > 60 { return null }
  let fx = hive_get("focus_x")
  let fy = hive_get("focus_y")
  if fx == null or fy == null { return null }
  return make_position(fx, fy)
}

on tick {
  if is_in_hazard() { move_forward return }

  // Panic: bail out to heal zone regardless of squad state.
  if health() < PANIC_HEALTH {
    let h = nearest_heal_zone()
    if h != null { move_to h.position return }
    retreat
    return
  }

  // Caller keeps the shared focus fresh each tick it can see the enemy.
  if role == "caller" {
    call_focus_target()
  }

  let enemy = nearest_enemy()
  if enemy != null {
    // If I'm overheating and a target is close, vent heat instead of missing.
    if heat_percent() > 80 and distance_to(enemy.position) > 4 {
      vent_heat
      return
    }
    if can_attack(enemy) {
      attack enemy
      return
    }
    move_toward enemy.position
    return
  }

  // No enemy in sight — converge on the squad focus if fresh.
  let focus = resolve_focus()
  if focus != null {
    if distance_to(focus) > 2 {
      move_toward focus
      return
    }
  }

  // Rally on squad center so we stay a mutual-support blob.
  let center = squad_center()
  if distance_between(position(), center) > 12 {
    move_toward center
    return
  }

  // Mild patrol so we don't stall.
  set wander_ticks = wander_ticks + 1
  if wall_ahead(3) or wander_ticks > 25 {
    set wander_ticks = 0
    if tick_phase(2) == 0 { turn_left } else { turn_right }
  }
  move_forward
}

on damaged(event) {
  if health() < HEAL_THRESHOLD {
    send_signal "hurt"
  }
}

on low_health {
  hive_set("fallback_needed", 1)
}

on signal_received(event) {
  // Push toward ally in distress if we're healthy.
  if health() > HEAL_THRESHOLD {
    move_toward event.senderPosition
  }
}`,
  },

  phantom: {
    name: "Phantom",
    class: "ranger",
    source: `robot "Phantom" version "1.0"

// Stealth assassin. Scouts cloaked, waits for a wounded target, strikes with
// fire_heavy from oblique angles, then disengages before the cloak breaks.
// Arms self-destruct as a last resort when pinned at low HP.

meta {
  author: "ArenaLab"
  class: "ranger"
}

const {
  STRIKE_HP = 45
  CLOAK_TRIGGER_DIST = 14
  DISENGAGE_HP = 35
}

state {
  mode: string = "stalk"
}

on spawn {
  mark_position "den"
  set mode = "stalk"
}

fn choose_target() {
  // Prefer a wounded enemy the whole squad knows about, else the nearest.
  let weak = weakest_visible_enemy()
  if weak != null and weak.health < STRIKE_HP {
    return weak
  }
  return nearest_enemy()
}

on tick {
  if is_in_hazard() { move_forward return }

  let enemy = choose_target()

  // Disengage mode: always move away from the nearest enemy and seek a depot
  // before returning to hunt. Set by damage + low-health handlers.
  if mode == "disengage" {
    let depot = nearest_depot()
    if depot != null and not is_on_depot() {
      move_to depot.position
      return
    }
    if is_on_depot() { vent_heat return }
    if health() > 70 { set mode = "stalk" }
    retreat
    return
  }

  // No threat nearby → use cloak+movement to close distance toward last known.
  if enemy == null {
    let last = last_seen_enemy()
    if last != null and last.age < 60 {
      move_toward last.position
      return
    }
    let cp = nearest_control_point()
    if cp != null { move_to cp.position return }
    if wall_ahead(3) { turn_right } else { move_forward }
    return
  }

  let d = distance_to(enemy.position)

  // Ambush setup: cloak while approaching a juicy target at medium range.
  if not is_cloaked() and d > CLOAK_TRIGGER_DIST and d < 30 and enemy.health < STRIKE_HP {
    cloak
    move_toward enemy.position
    return
  }

  // In strike window: heavy shot if ammo allows, else light fire.
  if can_attack(enemy) {
    if ammo() >= 4 and heat_percent() < 70 {
      fire_heavy enemy.position
    } else if ammo() >= 1 {
      fire_light enemy.position
    } else {
      // Out of ammo — bleed heat and close for melee.
      if d < 5 { attack enemy } else { move_toward enemy.position }
    }
    // Lateral break so we don't get line-checked.
    if tick_phase(2) == 0 { strafe_left } else { strafe_right }
    return
  }

  // Low HP + still visible: consider arming self-destruct.
  if health() < DISENGAGE_HP and d < 8 and not self_destruct_armed() {
    self_destruct
    return
  }

  // Default: keep ranged pressure
  fire_at enemy.position
}

on damaged(event) {
  // Getting hit while cloaked means we're already revealed — break contact.
  if health() < DISENGAGE_HP {
    set mode = "disengage"
  }
}

on low_health {
  set mode = "disengage"
}`,
  },

  warden: {
    name: "Warden",
    class: "support",
    source: `robot "Warden" version "1.0"

// Objective-anchored support. Holds the control point, mines chokepoints,
// publishes danger callouts to the hive, and falls back to the depot when
// heat or ammo drops too low to defend.

meta {
  author: "ArenaLab"
  class: "support"
}

const {
  DEPOT_AMMO_THRESHOLD = 20
  VENT_THRESHOLD = 70
  LOW_HP = 45
  DEFEND_RADIUS = 6
  MINE_INTERVAL = 80
}

state {
  next_mine_tick: number = 40
}

on spawn {
  mark_position "post"
  place_mine
}

fn dangerous_here() {
  // "Danger" = at least one enemy within 10 units, or hive already flagged it.
  if count_enemies_near(position(), 10) > 0 { return true }
  if hive_get("enemy_rush") == 1 and current_tick() - hive_get("enemy_rush_tick") < 60 {
    return true
  }
  return false
}

fn defend_point() {
  let cp = nearest_control_point()
  if cp != null { return cp.position }
  return recall_position("post")
}

on tick {
  if is_in_hazard() { move_forward return }

  // Resource management first — a Warden without ammo is useless.
  if (ammo() < DEPOT_AMMO_THRESHOLD or heat_percent() > VENT_THRESHOLD) and not dangerous_here() {
    let depot = nearest_depot()
    if depot != null and distance_to(depot.position) > 1 {
      move_to depot.position
      return
    }
    if is_on_depot() {
      vent_heat
      return
    }
  }

  let post = defend_point()

  let enemy = nearest_enemy()
  if enemy != null {
    // Broadcast enemy rush so aggressive allies rotate in.
    if count_enemies_near(position(), 14) >= 2 {
      hive_set("enemy_rush", 1)
      hive_set("enemy_rush_tick", current_tick())
    }

    if health() < LOW_HP {
      shield
      let heal = nearest_heal_zone()
      if heal != null { move_to heal.position return }
    }

    if can_attack(enemy) {
      fire_at enemy.position
      return
    }

    // Don't chase off the point — kite around it.
    if post != null and distance_to(post) > DEFEND_RADIUS {
      move_to post
      return
    }

    move_toward enemy.position
    return
  }

  // Idle maintenance: seed the approach with mines at a fixed cadence.
  if current_tick() >= next_mine_tick {
    place_mine
    set next_mine_tick = current_tick() + MINE_INTERVAL
  }

  if post != null and distance_to(post) > 1 {
    move_to post
    return
  }

  overwatch
  stop
}

on damaged(event) {
  if health() < LOW_HP {
    shield
    send_signal "warden_down"
  }
}`,
  },

  overclock: {
    name: "Overclock",
    class: "tank",
    source: `robot "Overclock" version "1.0"

// Adaptive tank that cycles between defensive and offensive modes based on
// outnumbering ratio and heat budget. Uses grenade + zap combos when flanked,
// shield+taunt when isolated.

meta {
  author: "ArenaLab"
  class: "tank"
}

const {
  AGGRO_RATIO = 1
  SHIELD_HP = 85
  PANIC_HP = 40
  GRENADE_MIN_TARGETS = 2
}

state {
  mode: string = "hold"
}

on spawn {
  mark_position "anchor"
  set mode = "hold"
}

fn pick_mode() {
  let enemies = count_enemies_near(position(), 16)
  let allies = count_allies_near(position(), 16) + 1
  if enemies == 0 { return "hold" }
  if enemies >= allies + AGGRO_RATIO { return "defend" }
  return "press"
}

on tick {
  if is_in_hazard() { move_forward return }

  set mode = pick_mode()

  let enemy = nearest_enemy()

  // Overheat relief — trade a tick instead of misfiring.
  if heat_percent() > 88 {
    vent_heat
    return
  }

  if enemy == null {
    let anchor = recall_position("anchor")
    if anchor != null and distance_to(anchor) > 6 {
      move_to anchor
      return
    }
    overwatch
    stop
    return
  }

  let d = distance_to(enemy.position)

  // Panic: shield+retreat toward heal zone.
  if health() < PANIC_HP {
    shield
    let heal = nearest_heal_zone()
    if heal != null { move_to heal.position return }
    retreat
    return
  }

  // Grenade cluster: when 2+ enemies bunched close, explode them.
  if count_enemies_near(enemy.position, 4) >= GRENADE_MIN_TARGETS and d < 14 {
    if ammo() >= 8 and heat_percent() < 60 {
      grenade enemy.position
      return
    }
  }

  // Point-blank zap beats melee DPS per tick.
  if d < 4 and energy() > 25 and heat_percent() < 70 {
    zap
    return
  }

  if mode == "defend" {
    // Pre-shield on incoming shots, hold ground, taunt to absorb aggro.
    if health() < SHIELD_HP { shield }
    taunt
    if can_attack(enemy) { attack enemy return }
    move_toward enemy.position
    return
  }

  // press / hold
  if can_attack(enemy) {
    attack enemy
    return
  }
  move_toward enemy.position
}

on damaged(event) {
  if health() < SHIELD_HP {
    shield
  }
}

on low_health {
  send_signal "anchor_down"
}`,
  },

  oracle: {
    name: "Oracle",
    class: "ranger",
    source: `robot "Oracle" version "1.1"

// Showcase bot for the v1.1 predictive sensors: leads shots with
// predict_position(), dodges with incoming_projectile(), and uses
// threat_level() as a single-scalar mode switch. A good reference for
// anyone writing a kiter against fast-moving targets.

meta {
  author: "ArenaLab"
  class: "ranger"
}

const {
  LEAD_TICKS = 6
  DODGE_WINDOW = 8
  SAFE_THREAT = 55
  CLOSE_RANGE = 4
}

state {
  last_strafe: number = 1
  dodge_until: number = 0
}

on spawn {
  mark_position "spawn_home"
}

// Turn perpendicular to an incoming projectile for a few ticks.
fn start_dodge(dir_x: number, dir_y: number) {
  set dodge_until = current_tick() + DODGE_WINDOW
  // Perpendicular strafe direction: flip signs each hit so we zig-zag.
  set last_strafe = last_strafe * -1
}

on tick {
  if is_in_hazard() { move_forward return }

  // Dodge incoming fire for a short window before re-engaging.
  let incoming = incoming_projectile()
  if incoming != null and incoming.ticks_to_impact <= 4 {
    start_dodge(incoming.direction.x, incoming.direction.y)
    if last_strafe > 0 { strafe_right } else { strafe_left }
    return
  }
  if current_tick() < dodge_until {
    if last_strafe > 0 { strafe_right } else { strafe_left }
    return
  }

  // Resource economy: fall back to the nearest depot when we are low on
  // ammo OR overheated. Oracle never brawls — range is her entire kit.
  if ammo_percent() < 25 or heat_percent() > 85 {
    let depot = nearest_depot()
    if depot != null {
      move_to depot.position
      return
    }
    vent_heat
    return
  }

  let enemy = nearest_enemy()
  if enemy == null {
    let cp = nearest_enemy_control_point()
    if cp != null { move_to cp.position return }
    overwatch
    stop
    return
  }

  let threat = threat_level()

  // Panic retreat on compound threat (low HP + multiple enemies visible).
  if threat > SAFE_THREAT {
    let heal = nearest_heal_zone()
    if heal != null { move_to heal.position return }
    retreat
    return
  }

  let d = distance_to(enemy.position)

  // Close-quarters fallback: zap is cheap and bypasses ammo.
  if d < CLOSE_RANGE {
    if energy() > 25 { zap return }
    retreat
    return
  }

  // Lead-shot: predict where the target will be after LEAD_TICKS and fire there.
  let predicted = predict_position(enemy, LEAD_TICKS)
  if predicted != null and can_attack(enemy) {
    fire_at predicted
    // Sidestep after firing to avoid return-fire telegraphed by the enemy.
    if last_strafe > 0 { strafe_right } else { strafe_left }
    set last_strafe = last_strafe * -1
    return
  }
  move_toward enemy.position
}

on damaged(event) {
  // Use damage_direction to dodge AWAY from the attacker perpendicular.
  let d = damage_direction()
  if d != null {
    set last_strafe = last_strafe * -1
  }
}

on low_health {
  hive_set("oracle_retreating", 1)
}`,
  },

  zealot: {
    name: "Zealot",
    class: "brawler",
    source: `robot "Zealot" version "1.1"

// Aggressive brawler that uses v1.1 reactive sensors: damage_direction()
// to chase the last attacker, threat_level() to commit or disengage, and
// while-loop + array indexing to pick the weakest of multiple visible
// targets. Pair this with Oracle as an "anchor + pressure" squad.

meta {
  author: "ArenaLab"
  class: "brawler"
}

const {
  COMMIT_THREAT = 70
  MIN_TARGET_HP = 1
}

state {
  target_id: string = ""
  chase_until: number = 0
}

// Walk the visible-enemy list with a while loop + [] indexing to pick the
// lowest-HP target, skipping cloaked targets at range (they're already
// filtered by the sensor gateway but we keep the guard for clarity).
fn pick_weakest() -> id {
  let visible = visible_enemies()
  let n = length(visible)
  if n == 0 { return "" }
  let i = 0
  let best_id = visible[0].id
  let best_hp = visible[0].health
  while i < n {
    let e = visible[i]
    if e.health < best_hp and e.health >= MIN_TARGET_HP {
      set best_hp = e.health
      set best_id = e.id
    }
    set i = i + 1
  }
  return best_id
}

on spawn {
  set target_id = ""
}

on tick {
  if is_in_hazard() { turn_right move_forward return }

  // If we were recently damaged, chase the attacker for a few ticks.
  if current_tick() < chase_until {
    let dir = damage_direction()
    if dir != null {
      let me = position()
      let goto = make_position(me.x + dir.x * 10, me.y + dir.y * 10)
      move_to goto
      return
    }
  }

  // Too much heat — swap to a free melee swing instead of forcing a fire.
  if heat_percent() > 80 {
    let close = nearest_enemy()
    if close != null and distance_to(close.position) < 3 {
      attack close
      return
    }
    vent_heat
    return
  }

  let threat = threat_level()

  // If we're committed and still healthy, tunnel-vision onto the weakest.
  if threat < COMMIT_THREAT {
    set target_id = pick_weakest()
  }

  let enemy = nearest_enemy()
  if enemy == null {
    // If we have a remembered target, post-up on the last signal we have.
    if target_id != "" {
      hive_set("zealot_target", target_id)
    }
    let cp = nearest_enemy_control_point()
    if cp != null { move_to cp.position return }
    move_forward
    return
  }

  let d = distance_to(enemy.position)
  if d < 4 {
    if can_attack(enemy) { attack enemy return }
    move_toward enemy.position
    return
  }

  // Gap close with burst if ammo allows, otherwise run it down.
  if d < 10 and ammo() >= 6 and heat_percent() < 60 {
    burst_fire enemy.position
    return
  }
  move_toward enemy.position
}

on damaged(event) {
  set chase_until = current_tick() + 20
}

on low_health {
  let heal = nearest_heal_zone()
  if heal != null { move_to heal.position }
}`,
  },

  // ==========================================================================
  // BETA TUTORIAL BOTS
  //
  // These three bots were added for the beta release. They're deliberately
  // short, heavily commented, and ordered by difficulty so new authors can
  // open them in sequence and see a concept per file:
  //   rookie  — simplest possible bot (first `on tick` + one action)
  //   scout   — introduces state, log(), and a memory waypoint
  //   predator— advanced: predictive aim, incoming-projectile dodge,
  //             threat-aware mode switching using every new beta helper.
  // ==========================================================================

  rookie: {
    name: "Rookie",
    class: "brawler",
    source: `robot "Rookie" version "1.0"

// ----------------------------------------------------------------------------
// Your very first bot.
//
// Every arenascript program has three pieces you'll see in almost every file:
//   1. A 'robot' header declaring the bot's display name and version.
//   2. A 'meta' block tagging author + class (brawler/ranger/tank/support).
//   3. An 'on tick' handler — the main decision loop that runs every tick.
//
// This bot's logic fits in four lines:
//   * see an enemy?    -> attack when in range, otherwise close the gap
//   * see no enemy?    -> wander forward so we explore the arena
//
// Open the Scout preset next to learn how to remember things between ticks.
// ----------------------------------------------------------------------------

meta {
  author: "ArenaLab"
  class: "brawler"
}

on tick {
  let enemy = nearest_enemy()

  // No visible target — walk forward. move_forward is the simplest movement.
  if enemy == null {
    move_forward
    return
  }

  // In range + cooldown ready? Strike. can_attack() encapsulates both checks.
  if can_attack(enemy) {
    attack enemy
    return
  }

  // Otherwise close the distance. move_toward accepts a position or entity.
  move_toward enemy.position
}`,
  },

  scout: {
    name: "Scout",
    class: "ranger",
    source: `robot "Scout" version "1.0"

// ----------------------------------------------------------------------------
// Second-tier tutorial. Introduces three ideas you'll use all the time:
//
//   * state { ... }        — variables that persist across ticks. Mutate
//                            them with 'set'. Constants (const { ... }) are
//                            immutable numbers/strings evaluated at compile.
//
//   * log(...)             — prints to the UI console after the match runs,
//                            prefixed with the bot name and tick index.
//                            Capped at 500 lines per match so use 'every N'
//                            or guard blocks to keep output readable.
//
//   * mark_position / recall_position — save a position by name so you can
//                            return to it later (here: our spawn point).
//
// The bot wanders between its spawn and whichever control point it finds,
// and falls back to the spawn if it gets lost or takes damage.
// ----------------------------------------------------------------------------

meta {
  author: "ArenaLab"
  class: "ranger"
}

const {
  ENGAGE_RANGE = 10
  FALLBACK_HP = 35
}

state {
  mode: string = "explore"
}

on spawn {
  mark_position "home"
  log("Scout deployed, home saved")
}

on tick {
  // Emergency: low HP -> hide in a heal zone if we know one, otherwise
  // fall back to the remembered home waypoint.
  if health_percent() < FALLBACK_HP {
    if mode != "fallback" {
      log("falling back, hp=", health_percent())
      set mode = "fallback"
    }
    let heal = nearest_heal_zone()
    if heal != null { move_to heal.position return }
    let home = recall_position("home")
    if home != null { move_to home return }
  }

  // Primary: shoot visible enemies from stand-off range.
  let enemy = nearest_enemy()
  if enemy != null and distance_to(enemy.position) < ENGAGE_RANGE {
    if mode != "engage" {
      log("engaging ", enemy.id)
      set mode = "engage"
    }
    fire_at enemy.position
    return
  }

  // Secondary: press the nearest control point we've discovered.
  let cp = nearest_control_point()
  if cp != null {
    if mode != "capture" {
      log("moving to cp")
      set mode = "capture"
    }
    move_to cp.position
    return
  }

  // Nothing interesting — keep exploring.
  move_forward
}

on damaged(event) {
  // event.data.damage tells you how hard you were hit; handy for triage.
  log("took damage ", event.data.damage)
}`,
  },

  predator: {
    name: "Predator",
    class: "ranger",
    source: `robot "Predator" version "1.0"

// ----------------------------------------------------------------------------
// Advanced beta showcase. Pulls every major perception + stdlib feature
// together into one predictive, reactive bot:
//
//   * incoming_projectile() + normalize() -> perpendicular dodge
//   * predict_position()    -> lead-shot firing solution
//   * threat_level()        -> single-scalar mode gate
//   * list_first(), index_of(), list_contains() -> target memory
//   * chance(), rand_float() -> non-deterministic feints within a seed
//   * hive_set/get          -> coordinate with allies on focus-fire
//   * log() + starts_with() -> self-diagnostics surfaced to the console
//
// Open this AFTER reading Scout. It's long, but the comments explain every
// non-obvious branch, and nothing here is magic — every sensor is listed in
// the Language Reference drawer (Ctrl+/).
// ----------------------------------------------------------------------------

meta {
  author: "ArenaLab"
  class: "ranger"
}

const {
  PANIC_THREAT = 70
  LEAD_TICKS = 6
  DODGE_MIN_TICKS = 4
  FEINT_CHANCE = 0.15
}

state {
  last_target: string = ""
  dodge_until: number = 0
}

// Perpendicular dodge: given a projectile direction vector, pick a side-step
// target that moves us 8 units away from the projectile path.
fn dodge_vector(dir_x: number, dir_y: number) -> position {
  // Rotate (dx, dy) by 90 degrees to get a perpendicular unit vector, then
  // normalize so the step size is predictable.
  let perp = normalize(make_position(-dir_y, dir_x))
  let me = position()
  return make_position(me.x + perp.x * 8, me.y + perp.y * 8)
}

on spawn {
  log("predator online")
  set dodge_until = 0
}

on tick {
  // --- Stage 1: honor an in-progress dodge before taking any other action.
  // Committing for DODGE_MIN_TICKS keeps us from thrashing between dodge and
  // fire-aim when a new projectile appears on the very next tick.
  if current_tick() < dodge_until {
    let side = mod(current_tick(), 2)
    if side == 0 { strafe_left } else { strafe_right }
    return
  }

  // --- Stage 2: dodge incoming fire; avoiding damage beats dealing it.
  let inc = incoming_projectile()
  if inc != null and inc.ticks_to_impact <= LEAD_TICKS {
    set dodge_until = current_tick() + DODGE_MIN_TICKS
    let goto = dodge_vector(inc.direction.x, inc.direction.y)
    move_to goto
    if chance(0.5) {
      // Take a snap shot on the way out the door if we're not venting heat.
      let close = nearest_enemy()
      if close != null and heat_percent() < 70 {
        fire_at close.position
      }
    }
    log("dodging, impact in ", inc.ticks_to_impact)
    return
  }

  // --- Stage 3: threat gate. If we're in real trouble, break contact.
  let threat = threat_level()
  if threat > PANIC_THREAT {
    let heal = nearest_heal_zone()
    if heal != null { move_to heal.position return }
    let home = recall_position("home")
    if home != null { move_to home return }
    retreat
    return
  }

  // --- Stage 4: target selection. Prefer the hive's focus-fire target; fall
  // back to the lowest-HP visible enemy, then the nearest enemy.
  let focus_id = hive_get("focus")
  let visible = visible_enemies()
  let target = null

  if focus_id != null {
    // focus_id is a string; find its view in visible_enemies if still visible.
    let idx = 0
    while idx < length(visible) {
      let e = visible[idx]
      if e.id == focus_id { set target = e break }
      set idx = idx + 1
    }
  }

  if target == null {
    let weakest = weakest_visible_enemy()
    if weakest != null { set target = weakest }
  }
  if target == null { set target = list_first(visible) }

  if target == null {
    // Nothing to shoot at. Occasionally fire a scan ping to refresh memory.
    if chance(0.10) { scan(12) }
    let cp = nearest_enemy_control_point()
    if cp != null { move_to cp.position return }
    move_forward
    return
  }

  // Broadcast our pick to the squad so allies can pile on.
  hive_set("focus", target.id)
  if target.id != last_target {
    log("new target ", target.id)
    set last_target = target.id
  }

  // --- Stage 5: lead the shot. Predict where the target will be and fire
  // there instead of where they currently are — ignoring lead is what lets
  // low-skill bots miss stationary kites.
  let aim = predict_position(target, LEAD_TICKS)
  let d = distance_to(target.position)

  if d > 14 {
    move_toward target.position
    return
  }

  if can_attack(target) and d < 3 {
    attack target
    return
  }

  // Occasional feint: 15% of eligible ticks, strafe instead of firing to
  // break the enemy's aim solution. rand_float is deterministic per seed so
  // matches stay reproducible even with the randomness.
  if chance(FEINT_CHANCE) {
    if rand_float(0, 1) < 0.5 { strafe_left } else { strafe_right }
    return
  }

  if heat_percent() < 75 and ammo() > 2 {
    fire_at aim
  } else if heat_percent() >= 75 {
    vent_heat
  } else {
    move_toward target.position
  }
}

on damaged(event) {
  // If we took a big hit, log the attacker id for post-match analysis.
  if event.data.damage > 12 {
    log("heavy hit from ", event.data.sourceId)
  }
}

on destroyed {
  // Announce our death so allies can shift focus; clears the stale hive key.
  send_signal "predator_down"
  hive_set("focus", null)
}`,
  },
};

const TEAM_PRESETS = {
  skirmish_pair: {
    name: "Scout & Survive",
    allies: ["bruiser", "healer"],
    opponents: ["kiter", "fortress"],
  },
  pressure_line: {
    name: "Patrol & Flank",
    allies: ["sentinel", "flanker"],
    opponents: ["fortress", "kiter"],
  },
};

// ============================================================================
// DOM References
// ============================================================================

const editorEl = document.getElementById("code-editor");
const highlightEl = document.getElementById("highlight-layer");
const lineNumbersEl = document.getElementById("line-numbers");
const errorBarEl = document.getElementById("error-bar");
const btnCompile = document.getElementById("btn-compile");
const btnRun = document.getElementById("btn-run");
const btnCompileRun = document.getElementById("btn-compile-run");
const btnClear = document.getElementById("btn-clear");
const diagnosticSummaryEl = document.getElementById("diagnostic-summary");
const consoleEl = document.getElementById("console-output");
const canvasEl = document.getElementById("arena-canvas");
const arenaStatus = document.getElementById("arena-status");
const matchResultsEl = document.getElementById("match-results");
const resultsContentEl = document.getElementById("results-content");
const opponentSelect = document.getElementById("opponent-select");
const matchModeSelect = document.getElementById("match-mode");
const teamPresetSelect = document.getElementById("team-preset-select");
const btnRunTeamSim = document.getElementById("btn-run-team-sim");
const seedInput = document.getElementById("seed-input");
const arenaSelect = document.getElementById("arena-select");
const arenaInfoEl = document.getElementById("arena-info");
const arenaInfoTaglineEl = document.getElementById("arena-info-tagline");
const arenaInfoDescEl = document.getElementById("arena-info-desc");
const arenaInfoDifficultyEl = document.getElementById("arena-info-difficulty");
const presetButtons = document.querySelectorAll(".bot-preset");

// Replay controls
const replayControlsEl = document.getElementById("replay-controls");
const btnReplayToggle = document.getElementById("btn-replay-toggle");
const btnReplayStep = document.getElementById("btn-replay-step");
const btnReplayStepBack = document.getElementById("btn-replay-step-back");
const replayScrubber = document.getElementById("replay-scrubber");
const replayTickLabel = document.getElementById("replay-tick-label");
const replaySpeedSelect = document.getElementById("replay-speed");
const resultsRobotDetailEl = document.getElementById("results-robot-detail");

const btnBookmarkDamage = document.getElementById("btn-bookmark-damage");
const btnBookmarkKill = document.getElementById("btn-bookmark-kill");
const btnToggleTraces = document.getElementById("btn-toggle-traces");
const btnToggleVision = document.getElementById("btn-toggle-vision");
const btnShareMatch = document.getElementById("btn-share-match");
const btnToggleFullpage = document.getElementById("btn-toggle-fullpage");
const btnOpenTeamBuilder = document.getElementById("btn-open-team-builder");
const teamBuilderModal = document.getElementById("team-builder-modal");
const btnCloseTeamBuilder = document.getElementById("btn-close-team-builder");
const btnTbCancel = document.getElementById("btn-tb-cancel");
const btnTbRun = document.getElementById("btn-tb-run");
const tbAllySlots = document.getElementById("tb-ally-slots");
const tbEnemySlots = document.getElementById("tb-enemy-slots");
const tbRoyaleSlots = document.getElementById("tb-royale-slots");
const tbMatchInfo = document.getElementById("tb-match-info");

// Match-live mode elements
const btnExitMatchLive = document.getElementById("btn-exit-match-live");
const matchScoreboard = document.getElementById("match-scoreboard");
const scoreboardTeam0 = document.getElementById("scoreboard-team0");
const scoreboardTeam1 = document.getElementById("scoreboard-team1");
const scoreboardTick = document.getElementById("scoreboard-tick");
const scoreboardArena = document.getElementById("scoreboard-arena");
const matchHudTeam0 = document.getElementById("match-hud-team0");
const matchHudTeam1 = document.getElementById("match-hud-team1");
const matchIntroEl = document.getElementById("match-intro");
const matchIntroTeam0 = document.getElementById("match-intro-team0");
const matchIntroTeam1 = document.getElementById("match-intro-team1");
const matchIntroArena = document.getElementById("match-intro-arena");

if (!canvasEl) {
  throw new Error("Missing required #arena-canvas element in HTML");
}
const ctx = canvasEl.getContext("2d");
if (!ctx) {
  throw new Error("Failed to acquire 2D canvas context — arena rendering unavailable");
}

// ============================================================================
// State
// ============================================================================

let compiledPlayer = null;
let currentPreset = "bruiser";
let currentEditorBotName = "Bruiser";
let currentEditorUserBotId = null;   // if the editor currently holds a user library bot, its id
let currentView = "builder";         // "builder" | "arena" | "library"
let lastMatchResult = null;
let lastCompileErrors = [];
let showDecisionTraces = false;
let showVisionOverlay = false;
let fullPageBattle = false;
// Bundle describing the last completed match so the Share button can emit a
// URL-safe payload that other players can paste back into their editor to
// reproduce the exact fight. Shape: { v:1, seed, arenaId, mode, participants:[
// { source, teamId } | { preset, teamId } ] }. Null until the first match.
let lastMatchBundle = null;

// Replay state
let replayData = null;
let replayPlaying = false;
let replayFrameIndex = 0;
let replayAnimId = null;
let replayLabels = {};
let replaySpeed = 0.24;
let lastReplayTimestamp = 0;
let lastReplayBookmarks = null;
let matchLiveMode = false;
let matchLiveParticipants = null;
let matchHudRows = new Map();   // robotId -> { row, fill, text } for live HP bars
let matchIntroTimer = null;     // pending timeout that dismisses the intro splash
let matchIsFFA = false;         // true for battle royale (3+ teams)
let matchFieldSize = 0;         // total combatant count of the current match
let matchEliminations = [];     // [{frameIndex,tick,name,teamId,isPlayer}] in death order
let matchParticipantMeta = new Map(); // robotId -> {name,teamId,cls,isPlayer}
let ffaHudRefs = null;          // cached battle-royale HUD element references

// Currently selected arena preset id (used for next match)
let currentArenaId = DEFAULT_ARENA_ID;

/** Get seed from UI input, or generate a random one */
function getMatchSeed() {
  const val = seedInput?.value?.trim();
  if (val !== "" && val !== undefined) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed >= 0) return parsed;
  }
  return Math.floor(Math.random() * 2147483647);
}

/** Currently selected arena id (falls back to default if UI not ready). */
function getMatchArenaId() {
  if (arenaSelect?.value) return arenaSelect.value;
  return currentArenaId || DEFAULT_ARENA_ID;
}

/** Populate the arena selector dropdown and info panel. */
function initArenaSelect() {
  if (!arenaSelect) return;
  arenaSelect.innerHTML = "";
  for (const id of ARENA_PRESET_ORDER) {
    const preset = ARENA_PRESETS[id];
    const opt = document.createElement("option");
    opt.value = preset.id;
    opt.textContent = preset.name;
    if (preset.id === DEFAULT_ARENA_ID) opt.selected = true;
    arenaSelect.appendChild(opt);
  }

  arenaSelect.addEventListener("change", () => {
    currentArenaId = arenaSelect.value;
    updateArenaInfo();
    // Re-draw the idle arena to reflect the new preset preview. If a replay
    // is currently active, we leave the replay frame rendering alone.
    if (!replayData) drawIdle();
  });
  updateArenaInfo();
}

/** Update the info panel text below the arena selector. */
function updateArenaInfo() {
  if (!arenaInfoTaglineEl || !arenaInfoDescEl) return;
  const preset = getArenaPreset(getMatchArenaId());
  arenaInfoTaglineEl.textContent = preset.tagline ?? "";
  arenaInfoDescEl.textContent = preset.description ?? "";
  if (arenaInfoEl) {
    arenaInfoEl.style.setProperty("--arena-accent", preset.accent || "#00d4ff");
  }
  if (arenaInfoDifficultyEl) {
    arenaInfoDifficultyEl.textContent = preset.difficulty ?? "";
  }
}

// Preview of the selected arena preset happens inside drawIdle() so a
// dedicated preview function is not needed — whenever the canvas is idle, it
// now renders the currently-selected preset's terrain with a name banner.

// ============================================================================
// Syntax Highlighting
// ============================================================================

const KEYWORDS = new Set([
  "robot", "version", "meta", "const", "state", "on", "fn",
  "let", "set", "if", "else", "for", "in", "return",
  "and", "or", "not",
]);

const ACTIONS = new Set([
  "move_to", "move_toward", "strafe_left", "strafe_right", "stop",
  "attack", "fire_at", "use_ability", "shield", "retreat",
  "mark_target", "capture", "ping",
  "burst_fire", "grenade",
  "move_forward", "move_backward", "turn_left", "turn_right",
  "place_mine", "send_signal", "mark_position", "taunt", "overwatch",
  // Resource economy + advanced combat
  "fire_light", "fire_heavy", "zap", "vent_heat",
  "cloak", "self_destruct",
]);

const BUILTINS = new Set([
  "health", "max_health", "energy", "position", "velocity", "heading", "cooldown",
  "nearest_enemy", "visible_enemies", "enemy_count_in_range",
  "nearest_ally", "visible_allies",
  "nearest_cover", "nearest_resource", "nearest_control_point",
  "nearest_enemy_control_point", "nearest_heal_zone", "nearest_hazard",
  "distance_to", "line_of_sight", "current_tick",
  "can_attack", "scan", "scan_enemies", "last_seen_enemy", "has_recent_enemy_contact",
  "enemy_visible", "random", "wall_ahead", "damage_percent",
  "team_size", "my_index", "my_role",
  "is_in_heal_zone", "is_in_hazard",
  "arena_width", "arena_height", "spawn_position",
  "discovered_count",
  "health_percent", "angle_to", "is_facing", "enemy_heading",
  "is_enemy_facing_me", "ally_health", "kills", "time_alive",
  "nearest_sound", "nearest_mine", "nearest_pickup",
  "recall_position", "is_taunted", "is_in_overwatch", "has_effect",
  // Resource economy
  "heat", "max_heat", "heat_percent", "overheated",
  "ammo", "max_ammo", "ammo_percent",
  // Cloak + self-destruct state
  "is_cloaked", "cloak_remaining",
  "self_destruct_armed", "self_destruct_remaining",
  // Resupply depots
  "nearest_depot", "is_on_depot",
  // Hive memory
  "hive_get", "hive_set", "hive_has",
]);

const TYPES = new Set([
  "number", "boolean", "string", "id", "vector", "direction",
  "robot_ref", "enemy", "ally", "projectile", "resource_node",
  "control_point", "event", "position", "list",
]);

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function highlightCode(source) {
  // Tokenize with regex for robust highlighting (works on incomplete code)
  const patterns = [
    { regex: /\/\/[^\n]*/g, cls: "comment" },
    { regex: /"(?:[^"\\]|\\.)*"/g, cls: "string" },
    { regex: /\b\d+(?:\.\d+)?\b/g, cls: "number" },
    { regex: /\b(?:true|false)\b/g, cls: "bool" },
    { regex: /\bnull\b/g, cls: "null" },
    // identifiers — classified in replacer
    { regex: /\b[a-zA-Z_]\w*\b/g, cls: "ident" },
    { regex: /[{}(),:.\->?=!<>+\-*/%]+/g, cls: "punct" },
  ];

  // Build a combined sorted list of matches
  const matches = [];
  for (const { regex, cls } of patterns) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(source)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, text: m[0], cls });
    }
  }

  // Sort by start position, then longest first to handle overlaps
  matches.sort((a, b) => a.start - b.start || b.end - a.end);

  // Remove overlapping matches (keep first)
  const filtered = [];
  let lastEnd = 0;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      filtered.push(m);
      lastEnd = m.end;
    }
  }

  // Build highlighted HTML
  let html = "";
  let pos = 0;
  for (const m of filtered) {
    if (m.start > pos) {
      html += escapeHtml(source.slice(pos, m.start));
    }
    let cls = m.cls;
    // Classify identifiers
    if (cls === "ident") {
      const word = m.text;
      if (KEYWORDS.has(word)) cls = "keyword";
      else if (ACTIONS.has(word)) cls = "action";
      else if (BUILTINS.has(word)) cls = "builtin";
      else if (TYPES.has(word)) cls = "type";
      else cls = "ident";
    }
    html += `<span class="hl-${cls}">${escapeHtml(m.text)}</span>`;
    pos = m.end;
  }
  if (pos < source.length) {
    html += escapeHtml(source.slice(pos));
  }

  // Ensure trailing newline so heights match
  if (!html.endsWith("\n")) html += "\n";

  return html;
}

function updateHighlighting() {
  const source = editorEl.value;
  highlightEl.innerHTML = highlightCode(source);
}

// ============================================================================
// Line Numbers
// ============================================================================

function updateLineNumbers() {
  const source = editorEl.value;
  const lineCount = source.split("\n").length;
  const errorLines = new Set(lastCompileErrors.map(e => e.line));

  let html = "";
  for (let i = 1; i <= lineCount; i++) {
    if (errorLines.has(i)) {
      html += `<div class="error-line">${i}</div>`;
    } else {
      html += `<div>${i}</div>`;
    }
  }
  lineNumbersEl.innerHTML = html;
}

// ============================================================================
// Scroll Sync
// ============================================================================

function syncScroll() {
  highlightEl.scrollTop = editorEl.scrollTop;
  highlightEl.scrollLeft = editorEl.scrollLeft;
  lineNumbersEl.scrollTop = editorEl.scrollTop;
}

// ============================================================================
// Error Display
// ============================================================================

function updateDiagnosticSummary(errors = [], warnings = []) {
  if (!diagnosticSummaryEl) return;
  const errCount = errors.length;
  const warnCount = warnings.length;

  if (errCount === 0 && warnCount === 0) {
    diagnosticSummaryEl.textContent = "No diagnostics";
    diagnosticSummaryEl.className = "diagnostic-summary";
    return;
  }

  const parts = [];
  if (errCount > 0) parts.push(`${errCount} error${errCount === 1 ? "" : "s"}`);
  if (warnCount > 0) parts.push(`${warnCount} warning${warnCount === 1 ? "" : "s"}`);
  diagnosticSummaryEl.textContent = parts.join(" • ");
  diagnosticSummaryEl.className = `diagnostic-summary ${errCount > 0 ? "has-errors" : "has-warnings"}`;
}

function jumpToLine(line) {
  if (!line || line < 1) return;
  const lines = editorEl.value.split("\n");
  let cursor = 0;
  const target = Math.min(line, lines.length);
  for (let i = 1; i < target; i++) {
    cursor += lines[i - 1].length + 1;
  }

  editorEl.focus();
  editorEl.setSelectionRange(cursor, cursor);

  const lineHeight = parseFloat(getComputedStyle(editorEl).lineHeight) || 20;
  const topPad = parseFloat(getComputedStyle(editorEl).paddingTop) || 0;
  editorEl.scrollTop = Math.max(0, (target - 1) * lineHeight - topPad - lineHeight * 2);
  syncScroll();
}

/**
 * Extract a "Did you mean?" quick-fix from a diagnostic message. The semantic
 * analyzer emits messages shaped like `Unknown identifier 'fooo'. Did you
 * mean 'foo'?`. We pull the (wrong, right) pair so the UI can offer a
 * one-click replacement.
 */
function extractQuickFix(message) {
  if (typeof message !== "string") return null;
  const m = message.match(/'([^']+)'[^']*Did you mean '([^']+)'/);
  if (!m) return null;
  return { wrong: m[1], right: m[2] };
}

/**
 * Apply a quick-fix: replace the first occurrence of `wrong` at or after
 * (line, col) in the editor with `right`. If we can't find the identifier
 * there (e.g. the user has since edited the file), fall back to a simple
 * string replace on the whole line. Returns true on success.
 */
function applyQuickFix(line, col, wrong, right) {
  const src = editorEl.value;
  const lines = src.split("\n");
  const idx = Math.max(0, Math.min(lines.length - 1, (line || 1) - 1));
  const target = lines[idx];
  if (!target) return false;
  // Match whole-word wrong, otherwise we might replace a substring inside
  // another identifier. Use a char class for identifier boundary because
  // JS \b treats "_" as a word char anyway.
  const safe = wrong.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^A-Za-z0-9_])${safe}(?![A-Za-z0-9_])`);
  const updated = target.replace(re, `$1${right}`);
  if (updated === target) return false;
  lines[idx] = updated;
  editorEl.value = lines.join("\n");
  onEditorInput();
  // Position the caret at the replacement for convenience.
  let cursor = 0;
  for (let i = 0; i < idx; i++) cursor += lines[i].length + 1;
  cursor += Math.max(0, updated.indexOf(right));
  editorEl.focus();
  editorEl.setSelectionRange(cursor, cursor + right.length);
  return true;
}

function showErrors(errors) {
  if (!errors || errors.length === 0) {
    errorBarEl.classList.remove("visible");
    errorBarEl.innerHTML = "";
    lastCompileErrors = [];
    return;
  }
  lastCompileErrors = errors;
  errorBarEl.classList.add("visible");
  errorBarEl.innerHTML = errors.map((e, i) => {
    const safeLine = Number.isFinite(Number(e.line)) ? Number(e.line) : 0;
    const safeCol = Number.isFinite(Number(e.column)) ? Number(e.column) : 0;
    const lineNum = safeLine > 0
      ? `<button type="button" class="error-line-num" data-line="${safeLine}">Ln ${safeLine}</button>`
      : "";
    const fix = extractQuickFix(e.message || "");
    const fixBtn = fix
      ? `<button type="button" class="error-quickfix" data-idx="${i}" data-line="${safeLine}" data-col="${safeCol}" data-wrong="${escapeHtml(fix.wrong)}" data-right="${escapeHtml(fix.right)}" title="Replace '${escapeHtml(fix.wrong)}' with '${escapeHtml(fix.right)}'">Apply fix: ${escapeHtml(fix.right)}</button>`
      : "";
    return `<div class="error-line-entry">${lineNum}${escapeHtml(e.message || String(e))}${fixBtn}</div>`;
  }).join("");

  errorBarEl.querySelectorAll(".error-line-num[data-line]").forEach((el) => {
    el.addEventListener("click", () => {
      const line = Number.parseInt(el.getAttribute("data-line"), 10);
      jumpToLine(line);
    });
  });
  errorBarEl.querySelectorAll(".error-quickfix").forEach((el) => {
    el.addEventListener("click", () => {
      const line  = Number.parseInt(el.dataset.line, 10) || 0;
      const col   = Number.parseInt(el.dataset.col,  10) || 0;
      const wrong = el.dataset.wrong;
      const right = el.dataset.right;
      const ok = applyQuickFix(line, col, wrong, right);
      if (ok) {
        toast(`Applied fix: ${wrong} → ${right}`, "success");
        // Re-compile so the error disappears immediately.
        doCompile();
      } else {
        toast(`Could not locate '${wrong}' near line ${line}. You may have edited it already.`, "warn");
      }
    });
  });
  updateLineNumbers();
}

function clearErrors() {
  showErrors([]);
  updateLineNumbers();
  updateDiagnosticSummary([], []);
}

// ============================================================================
// Console Logging
// ============================================================================

function logToConsole(message, type = "info") {
  const line = document.createElement("div");
  line.className = `log-${type}`;
  line.textContent = message;
  consoleEl.appendChild(line);
  // Cap console entries to prevent unbounded DOM growth
  while (consoleEl.children.length > 500) {
    consoleEl.removeChild(consoleEl.firstChild);
  }
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

/**
 * Flush the bot log sink collected during a match to the UI console.
 * Each entry gets a `[tick][BotName]` prefix so authors can correlate log
 * output with the replay scrubber. Capped so a runaway every {} timer can't
 * freeze the DOM — the rest are summarised as an omitted count.
 */
function flushBotLogs(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return;
  const max = 120;
  const shown = logs.slice(0, max);
  logToConsole(`--- Bot logs (${shown.length}${logs.length > max ? ` of ${logs.length}, truncated` : ""}) ---`, "event");
  for (const entry of shown) {
    const tick = String(entry.tick ?? 0).padStart(4, " ");
    const name = entry.robotName ?? entry.robotId ?? "?";
    logToConsole(`  [t=${tick}] ${name}: ${entry.message}`, "info");
  }
}

function clearConsole() {
  consoleEl.innerHTML = "";
}

// ============================================================================
// Match share bundle (export / import)
// ============================================================================
//
// Shares are self-contained: the player receives base64-encoded JSON that the
// app can rehydrate on any machine because match replays are deterministic for
// a given seed + participant set. We prefix the payload with "asv1:" so we
// can rev the format later without breaking old links.

const SHARE_PREFIX = "asv1:";
const SHARE_HASH_KEY = "match";

function encodeShareBundle(bundle) {
  const json = JSON.stringify(bundle);
  // btoa() only accepts latin-1; encode UTF-8 first so non-ASCII bot sources
  // round-trip safely. encodeURIComponent handles the conversion cleanly.
  const utf8 = unescape(encodeURIComponent(json));
  return SHARE_PREFIX + btoa(utf8);
}

function decodeShareBundle(token) {
  if (typeof token !== "string") return null;
  const clean = token.trim();
  if (!clean.startsWith(SHARE_PREFIX)) return null;
  try {
    const raw = atob(clean.slice(SHARE_PREFIX.length));
    const json = decodeURIComponent(escape(raw));
    const parsed = JSON.parse(json);
    if (parsed && parsed.v === 1 && Array.isArray(parsed.participants)) return parsed;
  } catch (e) {
    // Malformed payload — fall through to null so the caller can warn.
  }
  return null;
}

/** Build a share bundle from a running match request. */
function buildMatchBundle(setup, participantSources) {
  return {
    v: 1,
    seed: setup.config.seed,
    arenaId: setup.config.arenaId,
    mode: setup.config.mode,
    participants: participantSources,
  };
}

async function doShareMatch() {
  if (!lastMatchBundle) {
    toast("Run a match first so there is something to share.", "warn");
    return;
  }
  const token = encodeShareBundle(lastMatchBundle);
  // Prefer a shareable URL that re-hydrates on open; fall back to the raw
  // token so users can paste it anywhere (issue comment, pastebin, etc.).
  const url = `${location.origin}${location.pathname}#${SHARE_HASH_KEY}=${token}`;
  const payload = url.length < 6000 ? url : token;
  try {
    await navigator.clipboard.writeText(payload);
    toast(url.length < 6000 ? "Match URL copied to clipboard." : "Match bundle copied — paste anywhere.", "success");
  } catch (e) {
    // Clipboard may be blocked (no https, sandbox, denied permission). Fall
    // back to prompt() so users can still copy manually.
    prompt("Copy this match bundle:", payload);
  }
}

/** Inspect location.hash for #match=... on load and offer to restore it. */
/**
 * Inspect location.hash for a share token and, if present, rehydrate the
 * editor + sidebar selectors so pressing Compile & Run reproduces the
 * encoded match. Returns true when a share was applied (so bootstrap code
 * knows not to clobber the editor with the default preset).
 *
 * Fields hydrated from the bundle:
 *   - participants[0].{source|preset}  -> editor value
 *   - seed                              -> #seed-input
 *   - mode                              -> #match-mode (duel_1v1 | squad_2v2)
 *   - arenaId                           -> #arena-select
 *   - first non-team-0 participant.preset -> #opponent-select
 *
 * For squad_2v2 we best-effort pick the second team-1 participant's preset
 * as the opponent; the default ally/enemy pair that doRunMatch injects is
 * implicit in the mode and reconstructs automatically.
 */
function tryRestoreSharedMatch() {
  const hash = location.hash;
  if (!hash || !hash.startsWith(`#${SHARE_HASH_KEY}=`)) return false;
  const token = hash.slice(SHARE_HASH_KEY.length + 2);
  const bundle = decodeShareBundle(token);
  if (!bundle) {
    toast("The shared match link is malformed or from an older format.", "error");
    return false;
  }
  // Clear the hash so reloading after edits doesn't keep re-applying the share.
  try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}

  // 1) Editor gets participant 0's source (user-authored code).
  const first = bundle.participants[0];
  let editorPopulated = false;
  if (first) {
    const src = resolveBundleParticipantSource(first);
    if (src) {
      editorEl.value = src;
      onEditorInput();
      editorPopulated = true;
    }
  }

  // 2) Seed.
  if (typeof bundle.seed === "number" && seedInput) {
    seedInput.value = String(bundle.seed);
  }

  // 3) Match mode + arena selectors so the next Run Match round-trips.
  //    Applied via a deferred assignment because the selects may populate
  //    their <option> lists later in bootstrap (initArenaSelect, etc.).
  const applySelectors = () => {
    if (bundle.mode && matchModeSelect
        && [...matchModeSelect.options].some(o => o.value === bundle.mode)) {
      matchModeSelect.value = bundle.mode;
    }
    if (bundle.arenaId && arenaSelect
        && [...arenaSelect.options].some(o => o.value === bundle.arenaId)) {
      arenaSelect.value = bundle.arenaId;
      // Fire the change handler if it's wired, so the info panel refreshes.
      arenaSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
    // Opponent: find the first participant on team 1 that has a preset key
    // matching the opponent dropdown. Participant 0 is the editor author.
    const oppParticipant = bundle.participants.find(p => p.teamId === 1 && p.preset);
    if (oppParticipant && opponentSelect
        && [...opponentSelect.options].some(o => o.value === oppParticipant.preset)) {
      opponentSelect.value = oppParticipant.preset;
    }
  };
  // Run once now and once after the current microtask so we catch late
  // option population without depending on a specific init order.
  applySelectors();
  setTimeout(applySelectors, 0);

  lastMatchBundle = bundle;
  if (btnShareMatch) btnShareMatch.disabled = false;
  const modeLabel = bundle.mode ? ` · ${bundle.mode}` : "";
  toast(`Shared match loaded (seed ${bundle.seed}${modeLabel}). Hit Compile & Run to replay.`, "success");
  return editorPopulated;
}

function resolveBundleParticipantSource(p) {
  if (p.source) return p.source;
  if (p.preset && BOT_PRESETS[p.preset]) return BOT_PRESETS[p.preset].source;
  return null;
}

// ============================================================================
// Compilation
// ============================================================================

function doCompile() {
  const source = editorEl.value.trim();
  if (!source) {
    logToConsole("No source code to compile.", "warn");
    return false;
  }

  clearErrors();
  logToConsole("--- Compiling ---", "event");

  const stopTimer = telemetry.startTimer(Telemetry.COMPILE_TIME_MS);
  try {
    const result = compile(source);
    stopTimer();

    if (result.success) {
      telemetry.increment(Telemetry.COMPILE_SUCCESS);
      compiledPlayer = { program: result.program, constants: result.constants };
      btnRun.disabled = false;
      if (typeof updateArenaLoadedBotLabel === "function") updateArenaLoadedBotLabel();

      logToConsole(`Compiled OK  |  ${result.program.robotClass}  |  ${result.program.bytecode.length} bytes  |  events: ${[...result.program.eventHandlers.keys()].join(", ")}`, "success");

      const warnings = result.diagnostics.filter(d => d.severity === "warning");
      updateDiagnosticSummary([], warnings);

      if (result.diagnostics.length > 0) {
        for (const d of result.diagnostics) {
          const t = d.severity === "error" ? "error" : "warn";
          logToConsole(`  ${d.severity.toUpperCase()}: ${d.message}`, t);
        }
        if (warnings.length > 0) {
          showErrors(warnings.map(d => ({ line: d.line, message: `Warning: ${d.message}` })));
        }
      }
      return true;
    } else {
      telemetry.increment(Telemetry.COMPILE_FAILURE);
      compiledPlayer = null;
      btnRun.disabled = true;

      logToConsole("[FAIL] Compilation failed", "error");

      const allDiag = result.diagnostics || [];
      const errorDiag = allDiag.filter(d => d.severity === "error");
      const warningDiag = allDiag.filter(d => d.severity === "warning");
      updateDiagnosticSummary(errorDiag, warningDiag);

      for (const err of result.errors) {
        logToConsole(`  ${err}`, "error");
      }
      for (const d of allDiag) {
        if (d.severity === "warning") {
          logToConsole(`  WARNING: ${d.message}`, "warn");
        }
      }

      // Show errors in error bar with line info
      if (errorDiag.length > 0) {
        showErrors(errorDiag);
      } else {
        showErrors(result.errors.map(e => ({ line: 0, message: e })));
      }
      return false;
    }
  } catch (e) {
    compiledPlayer = null;
    btnRun.disabled = true;
    logToConsole(`[EXCEPTION] ${e.message}`, "error");
    showErrors([{ line: 0, message: e.message }]);
    updateDiagnosticSummary([{ line: 0, message: e.message }], []);
    return false;
  }
}

// ============================================================================
// Match Execution
// ============================================================================

// Match mode definitions. `perTeam` drives the 2-team modes; `ffa` + `fieldSize`
// drive battle royale. The mode key is also passed through to the engine config.
const MATCH_MODES = {
  duel_1v1:      { label: "1v1 Duel",      perTeam: 1 },
  squad_2v2:     { label: "2v2 Squad",     perTeam: 2 },
  team_3v3:      { label: "3v3 Team",      perTeam: 3 },
  team_4v4:      { label: "4v4 Team",      perTeam: 4 },
  team_5v5:      { label: "5v5 Team",      perTeam: 5 },
  battle_royale: { label: "Battle Royale", ffa: true, fieldSize: 12 },
};

// Curated preset pool for auto-filling rosters — skips the tutorial-trivial
// bots so auto-filled opponents actually put up a fight.
const AUTOFILL_POOL = [
  "bruiser", "kiter", "fortress", "healer", "flanker", "sentinel",
  "hivemind", "phantom", "warden", "overclock", "oracle", "zealot", "predator",
];

// Display metadata for the visual bot picker: tagline + role + difficulty.
// Difficulty 1 = great first pick, 3 = advanced behavior worth studying.
const BOT_META = {
  rookie:    { tagline: "Walks forward and swings. Learn the basics.",       role: "Tutorial",  difficulty: 1 },
  scout:     { tagline: "Patrols waypoints and logs what it sees.",          role: "Tutorial",  difficulty: 1 },
  bruiser:   { tagline: "Closes the gap and brawls until something dies.",   role: "Aggressor", difficulty: 1 },
  kiter:     { tagline: "Stays at range, peppers from a safe distance.",     role: "Skirmisher",difficulty: 1 },
  fortress:  { tagline: "Anchors objectives, eats damage, returns fire.",    role: "Anchor",    difficulty: 1 },
  healer:    { tagline: "Sticks to allies and keeps them topped up.",        role: "Support",   difficulty: 1 },
  flanker:   { tagline: "Skirts the edges and picks off stragglers.",        role: "Flanker",   difficulty: 2 },
  sentinel:  { tagline: "Overwatches a lane, punishes anyone who crosses.",  role: "Defender",  difficulty: 2 },
  hivemind:  { tagline: "Coordinates with teammates to focus-fire targets.", role: "Squad",     difficulty: 2 },
  phantom:   { tagline: "Cloaks in, executes a kill, fades out.",            role: "Assassin",  difficulty: 3 },
  warden:    { tagline: "Mines chokepoints and locks down the objective.",   role: "Zoner",     difficulty: 2 },
  overclock: { tagline: "Switches modes mid-fight to counter the threat.",   role: "Adaptive",  difficulty: 3 },
  oracle:    { tagline: "Predicts movement, leads shots, dodges incoming.",  role: "Predictor", difficulty: 3 },
  zealot:    { tagline: "Hunts attackers, prioritizes weakened targets.",    role: "Reactive",  difficulty: 2 },
  predator:  { tagline: "Showcase apex predator using the full sensor kit.", role: "Apex",      difficulty: 3 },
};

const BOT_PICKER_ORDER = [
  "rookie", "scout",
  "bruiser", "kiter", "fortress", "healer", "flanker", "sentinel",
  "hivemind", "phantom", "warden", "overclock",
  "oracle", "zealot", "predator",
];

/** The currently-selected quick-match mode (falls back to a duel). */
function getMatchMode() {
  const v = matchModeSelect?.value;
  return MATCH_MODES[v] ? v : "duel_1v1";
}

async function doRunMatch() {
  if (!compiledPlayer) {
    logToConsole("Compile your bot first.", "warn");
    return;
  }

  const mode = getMatchMode();
  const spec = MATCH_MODES[mode];
  const seed = getMatchSeed();

  // --- Assemble the roster -------------------------------------------------
  const participants = [];
  const shareParticipants = [];
  const usedNames = new Set(["you"]);

  // Allocate a unique, display-friendly name (the engine rejects duplicates).
  const uniqueName = (base) => {
    let name = base, n = 2;
    while (usedNames.has(name.toLowerCase())) name = `${base} ${n++}`;
    usedNames.add(name.toLowerCase());
    return name;
  };

  // The player's compiled editor bot always anchors team 0.
  participants.push({
    program: compiledPlayer.program, constants: compiledPlayer.constants,
    playerId: "player", teamId: 0,
  });
  shareParticipants.push({ source: editorEl.value, teamId: 0 });

  // Compile a preset onto a team; logs + returns false on failure.
  const addPreset = (botKey, teamId) => {
    const entry = getBotEntry(botKey);
    if (!entry) { logToConsole(`Unknown bot "${botKey}".`, "error"); return false; }
    let res;
    try { res = compile(entry.source); }
    catch (e) { logToConsole(`${entry.name} failed: ${e.message}`, "error"); return false; }
    if (!res.success) { logToConsole(`${entry.name} failed to compile.`, "error"); return false; }
    participants.push({
      program: res.program, constants: res.constants,
      playerId: uniqueName(entry.name), teamId,
    });
    shareParticipants.push({ preset: botKey, teamId });
    return true;
  };

  const oppKey = opponentSelect?.value || "kiter";

  if (spec.ffa) {
    // Battle royale: player + (fieldSize - 1) rivals, each its own team.
    for (let i = 1; i < spec.fieldSize; i++) {
      const key = AUTOFILL_POOL[(seed + i * 7) % AUTOFILL_POOL.length];
      if (!addPreset(key, i)) { arenaStatus.textContent = "Error"; return; }
    }
  } else {
    const n = spec.perTeam;
    // Enemy team (1): the dropdown pick leads, the rest auto-fill.
    if (!addPreset(oppKey, 1)) { arenaStatus.textContent = "Error"; return; }
    for (let i = 1; i < n; i++) {
      const key = AUTOFILL_POOL[(seed + i * 5) % AUTOFILL_POOL.length];
      if (!addPreset(key, 1)) { arenaStatus.textContent = "Error"; return; }
    }
    // Ally team (0): auto-fill alongside the player.
    for (let i = 1; i < n; i++) {
      const key = AUTOFILL_POOL[(seed + i * 11 + 3) % AUTOFILL_POOL.length];
      if (!addPreset(key, 0)) { arenaStatus.textContent = "Error"; return; }
    }
  }

  const arenaId = getMatchArenaId();
  const matchLabel = spec.ffa
    ? `Battle Royale · ${participants.length} bots`
    : (spec.perTeam === 1 ? `You vs ${getBotEntry(oppKey)?.name ?? "opponent"}`
                          : `${spec.perTeam}v${spec.perTeam} on ${getArenaPreset(arenaId).name}`);

  logToConsole(`\n--- ${spec.label}: ${matchLabel} ---`, "event");
  arenaStatus.textContent = "Running...";

  const setup = {
    config: {
      mode,
      arenaWidth: ARENA_WIDTH,
      arenaHeight: ARENA_HEIGHT,
      maxTicks: 3000,
      tickRate: 30,
      seed,
      arenaId,
    },
    participants,
  };

  // Show the loading overlay, yield to the browser so it paints, then run
  // the (synchronous) match. This keeps long simulations feeling responsive.
  showMatchLoading("Simulating match…", matchLabel);
  await nextFrame();

  let result;
  try {
    telemetry.increment(Telemetry.MATCH_RUN);
    result = runMatch(setup);
  } catch (e) {
    telemetry.increment(Telemetry.MATCH_ERROR);
    logToConsole(`Match error: ${e.message}`, "error");
    arenaStatus.textContent = "Error";
    hideMatchLoading();
    return;
  } finally {
    hideMatchLoading();
  }

  telemetry.record(Telemetry.MATCH_DURATION_TICKS, result.tickCount);
  lastMatchResult = result;
  recordMatchAchievements(result);
  // Track per-opponent W/L for the quick-match flow (1v1 only; team battles
  // are recorded by tbRunBattle for every enemy roster slot).
  if (spec.perTeam === 1 && oppKey && oppKey !== "__editor__") {
    const playerWon = result.winner === 0;
    const isDraw = result.winner === null;
    MatchStats.recordVersus(oppKey, {
      won: isDraw ? null : playerWon,
      opponentClass: getBotEntry(oppKey)?.class || null,
    });
  }

  // Capture the share bundle so players can reproduce the exact fight via a
  // `#match=asv1:...` link. The editor source rides on team 0; every
  // auto-filled bot is reconstructable by its preset key.
  lastMatchBundle = buildMatchBundle(setup, shareParticipants);
  if (btnShareMatch) btnShareMatch.disabled = false;

  const arenaLabel = result.replay?.metadata?.arenaName ?? arenaId ?? "unknown";
  const winnerLabel =
    result.winner === null ? "DRAW" :
    result.winner === 0 ? "You" : "Opponents";
  logToConsole(`Winner: ${winnerLabel}  |  ${result.reason}  |  ${result.tickCount} ticks  |  arena: ${arenaLabel}  |  seed: ${seed}`, "success");
  flushBotLogs(result.botLogs);

  // Record to the local match history.
  try {
    recordMatchHistory({
      you: compiledPlayer.program?.robotName ?? "Your Bot",
      opponent: matchLabel,
      arena: arenaLabel,
      mode,
      seed,
      ticks: result.tickCount,
      winnerTeam: result.winner,
      youWon: result.winner === 0,
      reason: result.reason,
    });
  } catch (e) { /* non-fatal */ }

  const oppName = spec.perTeam === 1 ? (getBotEntry(oppKey)?.name ?? null) : null;
  showMatchResults(result, oppName);
  startReplay(result, oppName);
  refreshMatchHistoryPanel();
}

/** Yield one animation frame so the browser can paint pending UI. */
function nextFrame() {
  return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

// ============================================================================
// Bot gauntlet: pit the current compiled bot against a slate of opponents
// ============================================================================
//
// Pure wrapper around runMatch(): no language/engine changes. Ensures the UI
// stays responsive by yielding a frame between simulations and short-circuits
// when the user already has a match running. Records a single summary entry
// in the match history (kind: "gauntlet") rather than flooding it with every
// leg of the run.

const GAUNTLET_SLATES = {
  tutorial: ["rookie", "bruiser", "kiter"],
  mixed: ["bruiser", "kiter", "fortress", "healer"],
  advanced: ["phantom", "overclock", "oracle", "zealot"],
  all: null, // sentinel — expanded at run time to every BOT_PRESETS key
};

let gauntletRunning = false;

async function doRunGauntlet() {
  if (gauntletRunning) {
    toast("Gauntlet already running.", "warn");
    return;
  }
  if (!compiledPlayer) {
    logToConsole("Compile your bot before running the gauntlet.", "warn");
    toast("Compile first (Ctrl+Enter).", "warn");
    return;
  }

  const slateSel = document.getElementById("gauntlet-slate");
  const seedsInput = document.getElementById("gauntlet-seeds");
  const slateKey = slateSel?.value ?? "tutorial";
  const baseSlate = GAUNTLET_SLATES[slateKey] ?? GAUNTLET_SLATES.tutorial;
  const slate = (baseSlate === null ? Object.keys(BOT_PRESETS) : baseSlate)
    .filter(k => BOT_PRESETS[k]);
  // Exclude self so the user can't trivially draw against themselves when
  // they've loaded a preset into the editor — the matchup is usually
  // uninteresting and it frees time for a real opponent.
  const editorName = compiledPlayer.program?.robotName ?? null;
  const uniqueSlate = slate.filter(k => BOT_PRESETS[k].name !== editorName);
  const seeds = Math.max(1, Math.min(10, Number.parseInt(seedsInput?.value ?? "3", 10) || 3));
  const totalMatches = uniqueSlate.length * seeds;
  if (totalMatches === 0) {
    toast("Empty slate — pick a different gauntlet option.", "warn");
    return;
  }

  // Pre-compile all opponents once so we don't pay the compile cost per match.
  const opponents = [];
  for (const key of uniqueSlate) {
    try {
      const c = compile(BOT_PRESETS[key].source);
      if (!c.success) {
        logToConsole(`Gauntlet: skipping ${key} (compile failed: ${c.errors.join(", ")})`, "warn");
        continue;
      }
      opponents.push({ key, name: BOT_PRESETS[key].name, program: c.program, constants: c.constants });
    } catch (e) {
      logToConsole(`Gauntlet: skipping ${key} (${e.message})`, "warn");
    }
  }
  if (opponents.length === 0) {
    toast("No opponents compiled cleanly.", "error");
    return;
  }

  gauntletRunning = true;
  const btnGauntlet = document.getElementById("btn-run-gauntlet");
  if (btnGauntlet) btnGauntlet.disabled = true;
  showMatchLoading("Running gauntlet…", `0 / ${opponents.length * seeds}`);
  logToConsole(`\n--- Gauntlet: ${opponents.length} opponents × ${seeds} seeds = ${opponents.length * seeds} matches ---`, "event");

  const perOpponent = new Map(); // key -> { wins, losses, draws, errors, name }
  for (const o of opponents) perOpponent.set(o.key, { name: o.name, wins: 0, losses: 0, draws: 0, errors: 0 });
  let totals = { wins: 0, losses: 0, draws: 0, errors: 0 };
  let matchIdx = 0;
  const startedAt = Date.now();

  // Using a fixed seed family (hash of opponent + seed index) so each slate
  // run is reproducible given the same starting time slice.
  const baseSeed = (Date.now() & 0x7fffffff) >>> 0;
  let lastResult = null;

  try {
    for (const opp of opponents) {
      for (let s = 0; s < seeds; s++) {
        const seed = (baseSeed + matchIdx * 31 + s * 7) >>> 0;
        const setup = {
          config: {
            mode: "duel_1v1",
            arenaWidth: ARENA_WIDTH,
            arenaHeight: ARENA_HEIGHT,
            maxTicks: 3000,
            tickRate: 30,
            seed,
            arenaId: getMatchArenaId(),
          },
          participants: [
            { program: compiledPlayer.program, constants: compiledPlayer.constants, playerId: "player", teamId: 0 },
            { program: opp.program, constants: opp.constants, playerId: opp.key, teamId: 1 },
          ],
        };
        matchIdx++;
        updateMatchLoading(`${matchIdx} / ${opponents.length * seeds} — vs ${opp.name}`);
        // Yield so the loading overlay repaints. Running this many matches
        // without yielding would freeze the browser.
        await nextFrame();

        let result;
        try {
          result = runMatch(setup);
        } catch (e) {
          perOpponent.get(opp.key).errors++;
          totals.errors++;
          logToConsole(`  [${matchIdx}] ${opp.name} seed=${seed}: ERROR ${e.message}`, "error");
          continue;
        }
        lastResult = result;

        const bucket = perOpponent.get(opp.key);
        if (result.winner === null) { bucket.draws++; totals.draws++; }
        else if (result.winner === 0) { bucket.wins++; totals.wins++; }
        else { bucket.losses++; totals.losses++; }
      }
    }
  } finally {
    gauntletRunning = false;
    if (btnGauntlet) btnGauntlet.disabled = false;
    hideMatchLoading();
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const pct = (n, d) => d === 0 ? "0%" : `${Math.round((n / d) * 100)}%`;
  const grandTotal = totals.wins + totals.losses + totals.draws;
  logToConsole(`Gauntlet complete in ${elapsed}s — ${totals.wins}W / ${totals.losses}L / ${totals.draws}D (${pct(totals.wins, grandTotal || 1)} winrate)`, "success");
  for (const [key, row] of perOpponent) {
    const n = row.wins + row.losses + row.draws;
    const err = row.errors > 0 ? ` · ${row.errors} errors` : "";
    logToConsole(`  vs ${row.name.padEnd(12)} ${row.wins}W / ${row.losses}L / ${row.draws}D  (${pct(row.wins, n || 1)})${err}`, "stat");
  }

  // Persist a single aggregate entry so the history view shows gauntlets as
  // their own distinct rows instead of 18+ noise entries.
  try {
    recordMatchHistory({
      kind: "gauntlet",
      you: compiledPlayer.program?.robotName ?? "Your Bot",
      opponent: `Gauntlet: ${slateKey} (${opponents.length} foes × ${seeds})`,
      arena: getMatchArenaId(),
      mode: "gauntlet",
      seed: baseSeed,
      ticks: lastResult?.tickCount ?? 0,
      winnerTeam: totals.wins > totals.losses ? 0 : (totals.losses > totals.wins ? 1 : null),
      youWon: totals.wins > totals.losses,
      reason: `${totals.wins}W/${totals.losses}L/${totals.draws}D`,
    });
  } catch (e) { /* non-fatal */ }
  refreshMatchHistoryPanel();

  toast(`Gauntlet: ${totals.wins}/${grandTotal} wins · see console for breakdown.`, totals.wins > totals.losses ? "success" : "info");
}

async function doRunTeamSimulation() {
  const teamPreset = TEAM_PRESETS[teamPresetSelect?.value ?? ""];
  if (!teamPreset) {
    logToConsole("Invalid team preset selection.", "error");
    return;
  }

  const compileBot = (key) => {
    const preset = BOT_PRESETS[key];
    const compiled = compile(preset.source);
    if (!compiled.success) throw new Error(`Preset ${preset.name} failed to compile.`);
    return { preset, compiled };
  };

  let allies;
  let opponents;
  try {
    allies = teamPreset.allies.map(compileBot);
    opponents = teamPreset.opponents.map(compileBot);
  } catch (e) {
    logToConsole(e.message, "error");
    arenaStatus.textContent = "Error";
    return;
  }

  const participants = [
    ...allies.map(({ preset, compiled }) => ({
      program: compiled.program,
      constants: compiled.constants,
      playerId: `ally_${preset.name.toLowerCase()}`,
      teamId: 0,
    })),
    ...opponents.map(({ preset, compiled }) => ({
      program: compiled.program,
      constants: compiled.constants,
      playerId: `opp_${preset.name.toLowerCase()}`,
      teamId: 1,
    })),
  ];

  const setup = {
    config: {
      mode: "squad_2v2",
      arenaWidth: ARENA_WIDTH,
      arenaHeight: ARENA_HEIGHT,
      maxTicks: 3000,
      tickRate: 30,
      seed: getMatchSeed(),
      arenaId: getMatchArenaId(),
    },
    participants,
  };

  showMatchLoading("Simulating team match…", `${teamPreset.name}`);
  await nextFrame();

  let result;
  try {
    telemetry.increment(Telemetry.MATCH_RUN);
    result = runMatch(setup);
  } catch (e) {
    telemetry.increment(Telemetry.MATCH_ERROR);
    logToConsole(`Match error: ${e.message}`, "error");
    arenaStatus.textContent = "Error";
    hideMatchLoading();
    return;
  }
  hideMatchLoading();
  telemetry.record(Telemetry.MATCH_DURATION_TICKS, result.tickCount);
  lastMatchResult = result;
  recordMatchAchievements(result);
  const opponentName = teamPreset.name;
  logToConsole(`\n--- Team Simulation: ${teamPreset.name} ---`, "event");
  logToConsole(`Winner: ${result.winner === null ? "DRAW" : `Team ${result.winner}`} | ${result.reason}`, "success");
  flushBotLogs(result.botLogs);
  showMatchResults(result, opponentName);
  startReplay(result, opponentName);
}

function doCompileAndRun() {
  if (doCompile()) {
    doRunMatch();
  }
}

// ============================================================================
// Match Results Display
// ============================================================================

/**
 * Scan replay frames for the first frame each robot drops, returning death
 * order earliest-first. Drives the kill feed and battle-royale placement.
 */
function computeEliminationOrder(frames) {
  const deathFrame = new Map();
  for (let fi = 0; fi < frames.length; fi++) {
    for (const r of frames[fi].robots) {
      if (!deathFrame.has(r.id) && r.health <= 0) deathFrame.set(r.id, fi);
    }
  }
  return [...deathFrame.entries()]
    .map(([robotId, fi]) => ({ robotId, frameIndex: fi, tick: frames[fi]?.tick ?? 0 }))
    .sort((a, b) => a.frameIndex - b.frameIndex);
}

function showMatchResults(result, opponentName) {
  // The scorecard is built here but stays hidden until the replay finishes —
  // revealMatchResults() / syncResultsToFrame() control when it appears.
  const participants = result.replay.metadata?.participants ?? [];

  // Battle royale gets a placement-based scorecard instead of a team comparison.
  if (new Set(participants.map(p => p.teamId)).size > 2) {
    showFfaResults(result, participants);
    return;
  }

  const isDraw = result.winner === null;
  const robotToTeam = new Map(participants.map((p) => [p.robotId, p.teamId]));
  const teamTotals = new Map([[0, { hp: 0, dmg: 0, kills: 0 }], [1, { hp: 0, dmg: 0, kills: 0 }]]);

  const lastFrame = result.replay.frames[result.replay.frames.length - 1];
  if (lastFrame) {
    for (const robot of lastFrame.robots) {
      const teamId = robotToTeam.get(robot.id);
      if (teamId === undefined) continue;
      teamTotals.get(teamId).hp += Math.max(0, Math.round(robot.health));
    }
  }
  for (const [robotId, stats] of result.robotStats.entries()) {
    const teamId = robotToTeam.get(robotId);
    if (teamId === undefined) continue;
    const bucket = teamTotals.get(teamId);
    bucket.dmg += stats.damageDealt;
    bucket.kills += stats.kills;
  }

  const team0Name = participants.filter(p => p.teamId === 0)
    .map(p => prettyParticipantName(p.playerId)).join(" & ") || "Blue Team";
  const team1Name = (opponentName && opponentName !== "Enemy Team" && opponentName !== "Team Battle")
    ? opponentName
    : (participants.filter(p => p.teamId === 1)
        .map(p => prettyParticipantName(p.playerId)).join(" & ") || "Red Team");

  const arenaName = result.replay?.metadata?.arenaName ?? "Unknown Arena";
  const reason = result.reason.replace(/_/g, " ");
  const outcome = isDraw ? "draw" : result.winner === 0 ? "win" : "loss";
  const outcomeLabel = isDraw ? "Draw" : result.winner === 0 ? "Victory" : "Defeat";
  const winnerLine = isDraw
    ? "No decisive winner"
    : `${result.winner === 0 ? team0Name : team1Name} wins`;

  const t0 = teamTotals.get(0);
  const t1 = teamTotals.get(1);

  const statRow = (label, v0, v1) => {
    const total = Math.max(v0 + v1, 1);
    const tie = v0 === v1;
    return `<div class="result-stat">
      <span class="result-stat-label">${escapeHtml(label)}</span>
      <div class="result-stat-row">
        <span class="result-stat-v result-stat-v0 ${!tie && v0 > v1 ? "lead" : ""}">${v0}</span>
        <span class="result-stat-bar">
          <span class="result-stat-fill result-stat-fill-0" style="width:${(v0 / total) * 100}%"></span>
          <span class="result-stat-fill result-stat-fill-1" style="width:${(v1 / total) * 100}%"></span>
        </span>
        <span class="result-stat-v result-stat-v1 ${!tie && v1 > v0 ? "lead" : ""}">${v1}</span>
      </div>
    </div>`;
  };

  resultsContentEl.innerHTML = `
    <div class="result-banner result-banner-${outcome}">
      <span class="result-banner-outcome">${escapeHtml(outcomeLabel)}</span>
      <span class="result-banner-detail">${escapeHtml(winnerLine)} · ${escapeHtml(reason)}</span>
    </div>
    <div class="result-meta">
      <span class="result-meta-arena">${escapeHtml(arenaName)}</span>
      <span class="result-meta-sep">&middot;</span>
      <span>${result.tickCount} ticks</span>
    </div>
    <div class="result-teams">
      <span class="result-team-name result-team-0">${escapeHtml(team0Name)}</span>
      <span class="result-team-name result-team-1">${escapeHtml(team1Name)}</span>
    </div>
    <div class="result-compare">
      ${statRow("Health", t0.hp, t1.hp)}
      ${statRow("Damage", t0.dmg, t1.dmg)}
      ${statRow("Kills", t0.kills, t1.kills)}
    </div>
  `;

  // Per-robot detail breakdown
  if (resultsRobotDetailEl) {
    let robotHtml = '<div class="result-robot-header">Combatant breakdown</div>';
    for (const p of participants) {
      const stats = result.robotStats.get(p.robotId);
      if (!stats) continue;
      const finalRobot = lastFrame?.robots.find(r => r.id === p.robotId);
      const hp = finalRobot ? Math.max(0, Math.round(finalRobot.health)) : 0;
      const down = hp <= 0;
      robotHtml += `<div class="result-robot-row team-${p.teamId}${down ? " is-down" : ""}">
        <span class="result-robot-dot"></span>
        <span class="result-robot-name">${escapeHtml(prettyParticipantName(p.playerId))}</span>
        <span class="result-robot-stat">${down ? "DOWN" : "HP " + hp}</span>
        <span class="result-robot-stat">DMG ${stats.damageDealt}</span>
        <span class="result-robot-stat">K ${stats.kills}</span>
      </div>`;
    }
    resultsRobotDetailEl.innerHTML = robotHtml;
  }
}

/** Battle-royale scorecard: the player's placement, run stats, and a podium. */
function showFfaResults(result, participants) {
  const frames = result.replay.frames;
  const lastFrame = frames[frames.length - 1];
  const order = computeEliminationOrder(frames);
  const fieldSize = participants.length;

  const nameByRobot = new Map(
    participants.map(p => [p.robotId, prettyParticipantName(p.playerId)]),
  );
  const player = participants.find(p => p.teamId === 0 && p.playerId === "player");
  const playerRobotId = player?.robotId ?? null;

  // Placement: 1st = survivor, last = first eliminated.
  const playerElimIdx = order.findIndex(e => e.robotId === playerRobotId);
  const won = result.winner === 0;
  const placement = playerElimIdx === -1
    ? (won ? 1 : 2)
    : fieldSize - playerElimIdx;

  // Survivor + runners-up form a small podium (winner, then last to fall).
  const winnerRobotId = participants.find(p => p.teamId === result.winner)?.robotId ?? null;
  const podium = [];
  if (winnerRobotId) podium.push({ rank: 1, robotId: winnerRobotId });
  for (let i = order.length - 1, rank = 2; i >= 0 && rank <= 3; i--, rank++) {
    podium.push({ rank, robotId: order[i].robotId });
  }

  const playerStats = playerRobotId ? result.robotStats.get(playerRobotId) : null;
  const kills = playerStats?.kills ?? 0;
  const dmg = playerStats?.damageDealt ?? 0;
  const survivedTick = playerElimIdx === -1
    ? (lastFrame?.tick ?? result.tickCount)
    : order[playerElimIdx].tick;

  const arenaName = result.replay?.metadata?.arenaName ?? "Arena";
  const outcome = won ? "win" : "loss";
  const ordinal = (n) => {
    const s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  const outcomeLabel = won ? "Victory Royale" : `${ordinal(placement)} place`;
  const detail = won
    ? `Last bot standing of ${fieldSize}`
    : `Eliminated · outlasted ${fieldSize - placement} of ${fieldSize - 1} rivals`;

  resultsContentEl.innerHTML = `
    <div class="result-banner result-banner-${outcome}">
      <span class="result-banner-outcome">${escapeHtml(outcomeLabel)}</span>
      <span class="result-banner-detail">${escapeHtml(detail)}</span>
    </div>
    <div class="result-meta">
      <span class="result-meta-arena">${escapeHtml(arenaName)}</span>
      <span class="result-meta-sep">&middot;</span>
      <span>Battle Royale</span>
      <span class="result-meta-sep">&middot;</span>
      <span>${result.tickCount} ticks</span>
    </div>
    <div class="result-br-stats">
      <div class="result-br-stat"><span class="result-br-stat-v">${ordinal(placement)}</span><span class="result-br-stat-l">Placement</span></div>
      <div class="result-br-stat"><span class="result-br-stat-v">${kills}</span><span class="result-br-stat-l">Kills</span></div>
      <div class="result-br-stat"><span class="result-br-stat-v">${dmg}</span><span class="result-br-stat-l">Damage</span></div>
      <div class="result-br-stat"><span class="result-br-stat-v">${survivedTick}</span><span class="result-br-stat-l">Survived</span></div>
    </div>
  `;

  if (resultsRobotDetailEl) {
    let html = '<div class="result-robot-header">Podium</div>';
    for (const slot of podium) {
      const isYou = slot.robotId === playerRobotId;
      html += `<div class="result-robot-row${isYou ? " is-you" : ""}">
        <span class="result-podium-rank rank-${slot.rank}">${slot.rank}</span>
        <span class="result-robot-name">${escapeHtml(nameByRobot.get(slot.robotId) ?? "Bot")}</span>
        <span class="result-robot-stat">${isYou ? "That's you" : ""}</span>
      </div>`;
    }
    resultsRobotDetailEl.innerHTML = html;
  }
}

// ============================================================================
// Canvas Rendering
// ============================================================================

const TEAM_COLORS = ["#00d4ff", "#ff3355"];
const TEAM_GLOW = ["rgba(0,212,255,0.25)", "rgba(255,51,85,0.25)"];
const GRID_COLOR = "rgba(42,42,74,0.3)";

/** Convert a #rrggbb hex color to an rgba() string with the given alpha. */
function hexToRgba(hex, alpha = 1) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return `rgba(0,212,255,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
// Dynamic arena layout — populated from replay metadata after each match,
// or from a selected preset when previewing pre-match.
let currentArenaLayout = {
  covers: [],
  controlPoints: [],
  healingZones: [],
  hazards: [],
  depots: [],
};

function canvasScale() {
  // Fit the entire arena within the canvas by using the smaller of the two
  // axis scales. Previously this returned canvasEl.width / ARENA_WIDTH, which
  // caused non-square canvases (match-live, fullpage, arena-view) to crop the
  // bottom of the arena because y * s overflowed canvasEl.height.
  return Math.min(canvasEl.width / ARENA_WIDTH, canvasEl.height / ARENA_HEIGHT);
}

function canvasOffset() {
  // World origin in canvas pixel space. Centers the arena inside the canvas
  // so non-square canvases letterbox/pillarbox cleanly.
  const s = canvasScale();
  return {
    ox: (canvasEl.width - ARENA_WIDTH * s) / 2,
    oy: (canvasEl.height - ARENA_HEIGHT * s) / 2,
  };
}

function drawArenaBackground() {
  const w = canvasEl.width;
  const h = canvasEl.height;
  const s = canvasScale();
  const { ox, oy } = canvasOffset();
  const aw = ARENA_WIDTH * s;
  const ah = ARENA_HEIGHT * s;

  // Deep dark background covers the whole canvas (including letterbox bars)
  ctx.fillStyle = "#050510";
  ctx.fillRect(0, 0, w, h);

  // Radial gradient center glow
  const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
  grad.addColorStop(0, "rgba(0, 212, 255, 0.03)");
  grad.addColorStop(0.5, "rgba(0, 100, 180, 0.015)");
  grad.addColorStop(1, "transparent");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Translate into arena-local pixel space for the rest of the background
  ctx.save();
  ctx.translate(ox, oy);

  // Arena floor fill (slightly lighter so letterbox bars are visibly distinct)
  ctx.fillStyle = "#06060e";
  ctx.fillRect(0, 0, aw, ah);

  // Grid - finer, more subtle
  const step = 10 * s;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.025)";
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= aw + 0.01; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ah);
    ctx.stroke();
  }
  for (let y = 0; y <= ah + 0.01; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(aw, y);
    ctx.stroke();
  }

  // Major grid lines every 50 units
  const majorStep = 50 * s;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= aw + 0.01; x += majorStep) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ah);
    ctx.stroke();
  }
  for (let y = 0; y <= ah + 0.01; y += majorStep) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(aw, y);
    ctx.stroke();
  }

  // Border with subtle glow
  ctx.strokeStyle = "rgba(0, 212, 255, 0.08)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, aw - 2, ah - 2);

  // Corner accents
  const cornerLen = 20 * s;
  ctx.strokeStyle = "rgba(0, 212, 255, 0.15)";
  ctx.lineWidth = 2;
  // Top-left
  ctx.beginPath(); ctx.moveTo(1, cornerLen); ctx.lineTo(1, 1); ctx.lineTo(cornerLen, 1); ctx.stroke();
  // Top-right
  ctx.beginPath(); ctx.moveTo(aw - cornerLen, 1); ctx.lineTo(aw - 1, 1); ctx.lineTo(aw - 1, cornerLen); ctx.stroke();
  // Bottom-left
  ctx.beginPath(); ctx.moveTo(1, ah - cornerLen); ctx.lineTo(1, ah - 1); ctx.lineTo(cornerLen, ah - 1); ctx.stroke();
  // Bottom-right
  ctx.beginPath(); ctx.moveTo(aw - cornerLen, ah - 1); ctx.lineTo(aw - 1, ah - 1); ctx.lineTo(aw - 1, ah - cornerLen); ctx.stroke();

  // Hazard zones (draw first, behind everything)
  for (const hz of currentArenaLayout.hazards) {
    const cx = hz.x * s;
    const cy = hz.y * s;
    const r = hz.radius * s;
    // Radial gradient for hazard
    const hzGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    hzGrad.addColorStop(0, "rgba(255,51,51,0.12)");
    hzGrad.addColorStop(0.7, "rgba(255,51,51,0.05)");
    hzGrad.addColorStop(1, "rgba(255,51,51,0)");
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = hzGrad;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,51,51,0.2)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255,51,51,0.3)";
    ctx.font = `bold ${Math.max(7, 1.8 * s)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("HAZARD", cx, cy + 1.5 * s);
  }

  // Healing zones
  for (const zone of currentArenaLayout.healingZones) {
    const cx = zone.x * s;
    const cy = zone.y * s;
    const r = zone.radius * s;
    const hlGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    hlGrad.addColorStop(0, "rgba(0,255,136,0.1)");
    hlGrad.addColorStop(0.7, "rgba(0,255,136,0.04)");
    hlGrad.addColorStop(1, "rgba(0,255,136,0)");
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = hlGrad;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,255,136,0.2)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(0,255,136,0.35)";
    ctx.font = `bold ${Math.max(7, 1.8 * s)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("+HP", cx, cy + 1.5 * s);
  }

  // Cover walls / obstacles
  ctx.lineWidth = 1;
  for (const cover of currentArenaLayout.covers) {
    const cw = cover.w * s;
    const ch = cover.h * s;
    const cx = (cover.x * s) - (cw / 2);
    const cy = (cover.y * s) - (ch / 2);
    if (cover.destructible) {
      ctx.fillStyle = "rgba(180, 120, 80, 0.2)";
      ctx.strokeStyle = "rgba(200, 140, 100, 0.35)";
    } else {
      ctx.fillStyle = "rgba(80, 120, 200, 0.12)";
      ctx.strokeStyle = "rgba(100, 150, 230, 0.3)";
    }
    // Rounded corners for cover
    const cr = 2 * s;
    ctx.beginPath();
    ctx.moveTo(cx + cr, cy);
    ctx.lineTo(cx + cw - cr, cy);
    ctx.quadraticCurveTo(cx + cw, cy, cx + cw, cy + cr);
    ctx.lineTo(cx + cw, cy + ch - cr);
    ctx.quadraticCurveTo(cx + cw, cy + ch, cx + cw - cr, cy + ch);
    ctx.lineTo(cx + cr, cy + ch);
    ctx.quadraticCurveTo(cx, cy + ch, cx, cy + ch - cr);
    ctx.lineTo(cx, cy + cr);
    ctx.quadraticCurveTo(cx, cy, cx + cr, cy);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // Control points
  ctx.font = `bold ${Math.max(8, 2 * s)}px sans-serif`;
  ctx.textAlign = "center";
  for (const cp of currentArenaLayout.controlPoints) {
    const cx = cp.x * s;
    const cy = cp.y * s;
    const cpGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 4 * s);
    cpGrad.addColorStop(0, "rgba(255,221,0,0.12)");
    cpGrad.addColorStop(1, "rgba(255,221,0,0)");
    ctx.beginPath();
    ctx.arc(cx, cy, 4 * s, 0, Math.PI * 2);
    ctx.fillStyle = cpGrad;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,221,0,0.2)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255,221,0,0.35)";
    ctx.fillText("CP", cx, cy + 6 * s);
  }

  // Resupply depots — ammo/vent stations (previously missing from rendering)
  for (const depot of (currentArenaLayout.depots ?? [])) {
    const cx = depot.x * s;
    const cy = depot.y * s;
    const r = (depot.radius ?? 3) * s;

    // Soft purple glow
    const depotGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    depotGrad.addColorStop(0, "rgba(180, 120, 255, 0.16)");
    depotGrad.addColorStop(0.7, "rgba(180, 120, 255, 0.05)");
    depotGrad.addColorStop(1, "rgba(180, 120, 255, 0)");
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = depotGrad;
    ctx.fill();

    // Dashed ring
    ctx.strokeStyle = "rgba(200, 150, 255, 0.35)";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 2]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Crosshair/ammo icon in the center
    ctx.strokeStyle = "rgba(220, 180, 255, 0.55)";
    ctx.lineWidth = 1.2;
    const ix = Math.max(2, r * 0.5);
    ctx.beginPath();
    ctx.moveTo(cx - ix, cy);
    ctx.lineTo(cx + ix, cy);
    ctx.moveTo(cx, cy - ix);
    ctx.lineTo(cx, cy + ix);
    ctx.stroke();

    ctx.fillStyle = "rgba(220, 180, 255, 0.6)";
    ctx.font = `bold ${Math.max(6, 1.5 * s)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("DEPOT", cx, cy + r + 1.6 * s);
  }

  ctx.restore();
}

/**
 * Draw a class-specific robot silhouette. Each class has a distinctive shape
 * that reads at a glance:
 *   brawler — bulky hexagon (heavy aggressor)
 *   ranger  — kite / arrowhead aligned to heading (sleek skirmisher)
 *   tank    — octagon with armor plates (fortified)
 *   support — rounded square with cross emblem (utility)
 */
function drawClassBody(ctx2d, cx, cy, radius, robotClass, color, fill, heading) {
  ctx2d.lineJoin = "round";
  ctx2d.strokeStyle = color;
  ctx2d.lineWidth = 1.5;

  // Angle aligned to heading so silhouettes feel directional.
  const ang = heading && (heading.x !== 0 || heading.y !== 0)
    ? Math.atan2(heading.y, heading.x)
    : 0;

  const polygon = (n, rOuter, rInner, rotateOffset = 0) => {
    ctx2d.beginPath();
    for (let i = 0; i < n; i++) {
      const a = ang + rotateOffset + (i / n) * Math.PI * 2;
      const r = rInner != null && i % 2 === 1 ? rInner : rOuter;
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r;
      if (i === 0) ctx2d.moveTo(px, py);
      else ctx2d.lineTo(px, py);
    }
    ctx2d.closePath();
  };

  if (robotClass === "tank") {
    // Octagonal armored plate
    polygon(8, radius * 1.15, null, Math.PI / 8);
    ctx2d.fillStyle = fill;
    ctx2d.fill();
    ctx2d.stroke();
    // Inner core ring for a "turret" feel.
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, radius * 0.55, 0, Math.PI * 2);
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = 1;
    ctx2d.stroke();
  } else if (robotClass === "ranger") {
    // Forward-pointing kite (longer along heading axis).
    const tip   = radius * 1.55;
    const back  = radius * 0.95;
    const sideR = radius * 0.85;
    const sx = Math.cos(ang), sy = Math.sin(ang);
    const nx = -sy, ny = sx;
    ctx2d.beginPath();
    ctx2d.moveTo(cx + sx * tip,            cy + sy * tip);
    ctx2d.lineTo(cx + nx * sideR,          cy + ny * sideR);
    ctx2d.lineTo(cx - sx * back,           cy - sy * back);
    ctx2d.lineTo(cx - nx * sideR,          cy - ny * sideR);
    ctx2d.closePath();
    ctx2d.fillStyle = fill;
    ctx2d.fill();
    ctx2d.stroke();
  } else if (robotClass === "support") {
    // Rounded square + cross emblem.
    const half = radius * 0.95;
    const r = radius * 0.3;
    ctx2d.beginPath();
    ctx2d.moveTo(cx - half + r, cy - half);
    ctx2d.lineTo(cx + half - r, cy - half);
    ctx2d.quadraticCurveTo(cx + half, cy - half, cx + half, cy - half + r);
    ctx2d.lineTo(cx + half, cy + half - r);
    ctx2d.quadraticCurveTo(cx + half, cy + half, cx + half - r, cy + half);
    ctx2d.lineTo(cx - half + r, cy + half);
    ctx2d.quadraticCurveTo(cx - half, cy + half, cx - half, cy + half - r);
    ctx2d.lineTo(cx - half, cy - half + r);
    ctx2d.quadraticCurveTo(cx - half, cy - half, cx - half + r, cy - half);
    ctx2d.closePath();
    ctx2d.fillStyle = fill;
    ctx2d.fill();
    ctx2d.stroke();
    // Cross emblem
    const armW = radius * 0.22;
    const armL = radius * 0.55;
    ctx2d.fillStyle = "rgba(0,0,0,0.45)";
    ctx2d.fillRect(cx - armW, cy - armL, armW * 2, armL * 2);
    ctx2d.fillRect(cx - armL, cy - armW, armL * 2, armW * 2);
  } else {
    // brawler — beefy hexagon
    polygon(6, radius * 1.2, null, Math.PI / 6);
    ctx2d.fillStyle = fill;
    ctx2d.fill();
    ctx2d.stroke();
    // Inner "knuckle" stripe
    ctx2d.beginPath();
    ctx2d.moveTo(cx - radius * 0.7, cy);
    ctx2d.lineTo(cx + radius * 0.7, cy);
    ctx2d.strokeStyle = "rgba(0,0,0,0.35)";
    ctx2d.lineWidth = 1.5;
    ctx2d.stroke();
  }
}

function drawRobot(x, y, health, maxHealth, energy, maxEnergy, teamId, label, isAlive, action, robotClass, extras = {}) {
  const s = canvasScale();
  const cx = x * s;
  const cy = y * s;
  const radius = 3 * s;
  const color = TEAM_COLORS[teamId] || "#ffffff";
  const glow = TEAM_GLOW[teamId] || "rgba(255,255,255,0.2)";

  if (!isAlive) {
    // Draw destroyed marker
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(100,100,100,0.3)";
    ctx.fill();
    ctx.fillStyle = "#555";
    ctx.font = `${Math.max(8, 2 * s)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("X", cx, cy + 3);
    return;
  }

  // Normalize extras used by several indicators below.
  const heat = Math.max(0, Math.min(100, extras.heat ?? 0));
  const ammo = extras.ammo ?? null;
  const maxAmmo = extras.maxAmmo ?? 0;
  const overheated = !!extras.overheated;
  const cloaked = !!extras.cloaked;
  const selfDestructing = !!extras.selfDestructing;
  const heading = extras.heading;

  // Cloak styling — soft pulse + translucency cue teammates can still see.
  let bodyAlpha = 1;
  if (cloaked) {
    const t = (extras.frameTick ?? 0) * 0.2;
    bodyAlpha = 0.28 + 0.12 * Math.sin(t);
  }

  // Self-destruct: dramatic red pulse ring that grows over the countdown.
  if (selfDestructing) {
    const pulse = 1 + 0.25 * Math.sin((extras.frameTick ?? 0) * 0.4);
    ctx.beginPath();
    ctx.arc(cx, cy, (radius + 10) * pulse, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,60,60,0.85)";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, (radius + 14) * pulse, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,120,60,0.25)";
    ctx.lineWidth = 4;
    ctx.stroke();
  }

  // Shield indicator (glowing ring)
  const actionType = action?.combat?.type ?? action?.movement?.type ?? null;
  if (actionType === "shield") {
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 7, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,200,255,0.6)";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // Overwatch indicator (dotted ring)
  if (actionType === "overwatch") {
    ctx.beginPath();
    ctx.setLineDash([3, 3]);
    ctx.arc(cx, cy, radius + 6, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(170,85,255,0.6)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Overheated: orange flame halo so players notice resource pressure.
  if (overheated) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 5, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,140,40,0.9)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Outer glow (larger, more dramatic)
  const glowGrad = ctx.createRadialGradient(cx, cy, radius, cx, cy, radius + 8);
  glowGrad.addColorStop(0, glow);
  glowGrad.addColorStop(1, "transparent");
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 8, 0, Math.PI * 2);
  ctx.fillStyle = glowGrad;
  ctx.fill();

  // Heat arc — fraction of a ring in top-right that fills as heat rises.
  // Rendered before the body so it reads as a shoulder-of-the-chassis gauge.
  if (heat > 0) {
    const ringR = radius + 2.5;
    const heatFrac = heat / 100;
    const heatColor = overheated ? "rgba(255,60,30,0.95)"
      : heat > 80 ? "rgba(255,120,30,0.9)"
      : heat > 50 ? "rgba(255,200,60,0.8)"
      : "rgba(255,230,120,0.5)";
    ctx.beginPath();
    // Start at -90deg (top), sweep clockwise.
    ctx.arc(cx, cy, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * heatFrac);
    ctx.strokeStyle = heatColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Body with gradient — silhouette depends on class so a glance reveals role.
  ctx.save();
  ctx.globalAlpha = bodyAlpha;
  const bodyGrad = ctx.createRadialGradient(cx - radius * 0.3, cy - radius * 0.3, 0, cx, cy, radius);
  bodyGrad.addColorStop(0, color);
  bodyGrad.addColorStop(1, teamId === 0 ? "#006688" : "#881122");
  drawClassBody(ctx, cx, cy, radius, robotClass, color, bodyGrad, heading);

  // Heading arrow — small triangle at the front so it's obvious which way
  // the robot is facing. Only meaningful when heading is non-zero.
  if (heading && (heading.x !== 0 || heading.y !== 0)) {
    const hx = heading.x;
    const hy = heading.y;
    const tipLen = radius + 3;
    const baseLen = radius + 0.2;
    const halfWidth = radius * 0.55;
    // Perpendicular for triangle base.
    const px = -hy;
    const py = hx;
    ctx.beginPath();
    ctx.moveTo(cx + hx * tipLen, cy + hy * tipLen);
    ctx.lineTo(cx + hx * baseLen + px * halfWidth, cy + hy * baseLen + py * halfWidth);
    ctx.lineTo(cx + hx * baseLen - px * halfWidth, cy + hy * baseLen - py * halfWidth);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  // Class letter inside robot body
  const classLetter = { brawler: "B", ranger: "R", tank: "T", support: "S" };
  ctx.fillStyle = "#000";
  ctx.font = `bold ${Math.max(7, 1.8 * s)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(classLetter[robotClass] || "", cx, cy);
  ctx.textBaseline = "alphabetic";
  ctx.restore();

  // Health bar
  const barW = radius * 2.8;
  const barH = 3;
  const barX = cx - barW / 2;
  const barY = cy - radius - 14;
  const hpRatio = Math.max(0, health / maxHealth);

  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(barX - 0.5, barY - 0.5, barW + 1, barH + 1);

  const hpColor = hpRatio > 0.5 ? "#00ff88" : hpRatio > 0.25 ? "#ff8800" : "#ff3355";
  ctx.fillStyle = hpColor;
  ctx.fillRect(barX, barY, barW * hpRatio, barH);

  // Energy bar (below health bar)
  const eBarY = barY + barH + 2;
  const eBarH = 2;
  const eRatio = maxEnergy > 0 ? Math.max(0, (energy ?? 0) / maxEnergy) : 0;

  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(barX - 0.5, eBarY - 0.5, barW + 1, eBarH + 1);
  ctx.fillStyle = "#4488ff";
  ctx.fillRect(barX, eBarY, barW * eRatio, eBarH);

  // Ammo pip strip below energy — shows roughly how many shots remain.
  if (maxAmmo > 0 && ammo !== null) {
    const aBarY = eBarY + eBarH + 2;
    const aBarH = 2;
    const aRatio = Math.max(0, ammo / maxAmmo);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(barX - 0.5, aBarY - 0.5, barW + 1, aBarH + 1);
    // Shift to red when ammo is critical to cue players to resupply.
    ctx.fillStyle = aRatio > 0.5 ? "#b5b59c" : aRatio > 0.2 ? "#d0a040" : "#e86050";
    ctx.fillRect(barX, aBarY, barW * aRatio, aBarH);
  }

  // HP text
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.max(8, 2 * s)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(Math.round(health), cx, barY - 3);

  // Label
  ctx.fillStyle = color;
  ctx.font = `bold ${Math.max(9, 2.5 * s)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(label, cx, cy + radius + 14);
}

function drawProjectile(x, y, prev) {
  const s = canvasScale();
  const cx = x * s;
  const cy = y * s;
  const radius = 1.5 * s;

  // Motion trail: short streak from previous position if available.
  if (prev && (prev.x !== x || prev.y !== y)) {
    const px = prev.x * s;
    const py = prev.y * s;
    const grad = ctx.createLinearGradient(px, py, cx, cy);
    grad.addColorStop(0, "rgba(255,221,0,0)");
    grad.addColorStop(1, "rgba(255,221,0,0.8)");
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(cx, cy);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Outer glow
  const projGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius + 6);
  projGlow.addColorStop(0, "rgba(255,221,0,0.4)");
  projGlow.addColorStop(0.5, "rgba(255,180,0,0.15)");
  projGlow.addColorStop(1, "transparent");
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 6, 0, Math.PI * 2);
  ctx.fillStyle = projGlow;
  ctx.fill();

  // Core
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = "#ffdd00";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = 0.5;
  ctx.stroke();
}

function drawFrame(frame, labels, prevFrame) {
  if (!frame || !frame.robots) {
    drawArenaBackground();
    return;
  }

  // Update cover data from frame if available (destructible cover may change)
  if (frame.covers) {
    currentArenaLayout.covers = frame.covers.map(c => ({
      x: c.x, y: c.y, w: c.w, h: c.h, destructible: c.destructible,
    }));
  }

  // Index the previous frame's projectile positions by id so we can render a
  // motion trail for each live projectile without doing an O(n²) search.
  const prevProjMap = prevFrame && prevFrame.projectiles
    ? new Map(prevFrame.projectiles.map(p => [p.id, p.position]))
    : null;

  drawArenaBackground();

  const s = canvasScale();
  const { ox, oy } = canvasOffset();

  // Translate into arena-local pixel space so every entity uses (x*s, y*s)
  // in the centered arena region. Unbalanced ctx.save() is restored at the
  // end of drawFrame.
  ctx.save();
  ctx.translate(ox, oy);

  // Draw mines
  if (frame.mines) {
    for (const m of frame.mines) {
      const mx = m.position.x * s;
      const my = m.position.y * s;
      ctx.beginPath();
      ctx.arc(mx, my, 1.5 * s, 0, Math.PI * 2);
      ctx.fillStyle = m.teamId === 0 ? "rgba(0,212,255,0.4)" : "rgba(255,51,85,0.4)";
      ctx.fill();
      ctx.strokeStyle = m.teamId === 0 ? "rgba(0,212,255,0.7)" : "rgba(255,51,85,0.7)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Draw pickups
  if (frame.pickups) {
    const pickupColors = {
      energy: "rgb(0,170,255)", speed: "rgb(255,255,0)", damage: "rgb(255,68,68)", vision: "rgb(170,68,255)",
    };
    const pickupLabels = {
      energy: "E", speed: "S", damage: "D", vision: "V",
    };
    for (const p of frame.pickups) {
      const px = p.position.x * s;
      const py = p.position.y * s;
      const color = pickupColors[p.type] || "#ffffff";
      // Pulsing glow
      ctx.beginPath();
      ctx.arc(px, py, 2.5 * s, 0, Math.PI * 2);
      ctx.fillStyle = color.replace(")", ",0.15)").replace("rgb", "rgba");
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, py, 1.5 * s, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = "#000";
      ctx.font = `bold ${Math.max(7, 1.5 * s)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(pickupLabels[p.type] || "?", px, py + 0.5 * s);
    }
  }

  // Draw projectiles first (behind robots)
  if (frame.projectiles) {
    for (const p of frame.projectiles) {
      const prev = prevProjMap ? prevProjMap.get(p.id) : null;
      drawProjectile(p.position.x, p.position.y, prev);
    }
  }

  for (let i = 0; i < frame.robots.length; i++) {
    const r = frame.robots[i];
    const classStats = CLASS_STATS[r.robotClass];
    const maxHP = classStats?.health || 100;
    const maxEnergy = classStats?.energy || 100;
    const maxAmmo = classStats?.maxAmmo || 0;
    const isAlive = r.health > 0;
    // In a free-for-all every bot is its own team; render the player in the
    // friendly colour and the whole field as hostiles, and only label the
    // player so 20-bot fights stay readable.
    const colorTeam = matchIsFFA ? (r.teamId === 0 ? 0 : 1) : r.teamId;
    const label = matchIsFFA && r.teamId !== 0 ? "" : (labels[r.id] || r.id);
    drawRobot(
      r.position.x, r.position.y, r.health, maxHP, r.energy, maxEnergy,
      colorTeam, label, isAlive, r.action, r.robotClass,
      {
        heat: r.heat,
        ammo: r.ammo,
        maxAmmo,
        overheated: r.overheated,
        cloaked: r.cloaked,
        selfDestructing: r.selfDestructing,
        heading: r.heading,
        frameTick: frame.tick,
      },
    );
  }

  // Draw event indicators (damage flashes, grenade explosions, etc.)
  if (frame.events) {
    for (const evt of frame.events) {
      if (evt.type === "damaged" && evt.data) {
        const targetRobot = frame.robots.find(r => r.id === evt.robotId);
        if (targetRobot && targetRobot.health > 0) {
          const s = canvasScale();
          const cx = targetRobot.position.x * s;
          const cy = targetRobot.position.y * s;
          ctx.beginPath();
          ctx.arc(cx, cy, 6 * s, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(255,51,85,0.2)";
          ctx.fill();

          // Draw damage number floating up
          ctx.fillStyle = "rgba(255,80,100,0.9)";
          ctx.font = `bold ${Math.max(8, 2 * s)}px sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText(`-${evt.data.damage}`, cx + 8, cy - 14);
        }

        // Grenade explosion marker (larger blast radius indicator)
        if (evt.data.source === "grenade" || evt.data.damageType === "grenade") {
          const s = canvasScale();
          const pos = targetRobot?.position ?? evt.data.position;
          if (pos) {
            const gx = pos.x * s;
            const gy = pos.y * s;
            ctx.beginPath();
            ctx.arc(gx, gy, 3.5 * s, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(255,160,0,0.25)";
            ctx.fill();
            ctx.strokeStyle = "rgba(255,160,0,0.6)";
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
      }

      // Destroyed marker
      if (evt.type === "destroyed") {
        const deadBot = frame.robots.find(r => r.id === evt.robotId);
        if (deadBot) {
          const s = canvasScale();
          const dx = deadBot.position.x * s;
          const dy = deadBot.position.y * s;
          ctx.fillStyle = "rgba(255,0,0,0.5)";
          ctx.font = `bold ${Math.max(10, 3 * s)}px sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText("DESTROYED", dx, dy - 20);
        }
      }
    }
  }

  // Draw vision-overlay (if enabled): each alive robot's vision radius, a
  // heading cone showing its facing direction, and a connecting line to the
  // currently-selected target (inferred from the action). Meant as a debug
  // aid so authors can see what the sensor layer is actually returning —
  // "why isn't my bot firing?" is usually "because the enemy isn't visible".
  if (showVisionOverlay) {
    const s = canvasScale();
    for (const r of frame.robots) {
      if (r.health <= 0) continue;
      const cs = CLASS_STATS[r.robotClass];
      const vision = cs?.visionRange ?? 18;
      const cx = r.position.x * s;
      const cy = r.position.y * s;
      const color = r.teamId === 0 ? "rgba(84,172,240," : "rgba(255,120,120,";
      // Vision radius ring (dashed, subtle)
      ctx.beginPath();
      ctx.arc(cx, cy, vision * s, 0, Math.PI * 2);
      ctx.strokeStyle = color + "0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Heading cone (rough indicator of sensor priority direction)
      if (r.heading) {
        const ang = Math.atan2(r.heading.y, r.heading.x);
        const cone = Math.PI / 2; // ±45° visual cone — not the actual FOV
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, vision * s, ang - cone, ang + cone);
        ctx.closePath();
        ctx.fillStyle = color + "0.08)";
        ctx.fill();
      }
      // Target line — if the frame has a recorded combat target on this
      // robot's action, draw a crosshair to show the current engagement.
      const action = r.action;
      if (action && action.target && typeof action.target === "object"
          && "x" in action.target && "y" in action.target) {
        const tx = action.target.x * s;
        const ty = action.target.y * s;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(tx, ty);
        ctx.strokeStyle = color + "0.5)";
        ctx.lineWidth = 1;
        ctx.stroke();
        // Crosshair at the target point
        ctx.beginPath();
        ctx.arc(tx, ty, 1.2 * s, 0, Math.PI * 2);
        ctx.strokeStyle = color + "0.8)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  // Draw decision traces overlay (if enabled and available)
  if (showDecisionTraces && frame.traces) {
    const s = canvasScale();
    ctx.font = `${Math.max(7, 1.5 * s)}px monospace`;
    ctx.textAlign = "left";
    for (const trace of frame.traces) {
      const robot = frame.robots.find(r => r.id === trace.robotId);
      if (!robot || robot.health <= 0) continue;
      const tx = robot.position.x * s + 12;
      const ty = robot.position.y * s - 8;
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      const text = `${trace.action ?? "idle"} [${trace.budgetUsed}]`;
      const metrics = ctx.measureText(text);
      ctx.fillRect(tx - 2, ty - 8, metrics.width + 4, 11);
      ctx.fillStyle = "rgba(200,200,255,0.9)";
      ctx.fillText(text, tx, ty);
    }
  }

  ctx.restore();

  // Keep the live broadcast overlay (HP bars + clock) in sync with the frame.
  updateMatchHud(frame);
  updateScoreboard(frame);
}

// ============================================================================
// Battle effects — floating damage numbers + explosion bursts + kill feed
// ============================================================================

const _fxParticles = [];           // { kind, x, y, vx, vy, life, maxLife, text, color, size }
const _killFeedEntries = [];       // { el, expiresAt }
let _lastFxFrameIndex = -1;        // Last frame whose events we processed for FX
let _fxMeta = {};                  // robotId -> { name, teamId } for kill-feed labels
const KILL_FEED_TTL_MS = 4500;
const killFeedEl = document.getElementById("kill-feed");

function fxClearAll() {
  _fxParticles.length = 0;
  _lastFxFrameIndex = -1;
  if (killFeedEl) killFeedEl.innerHTML = "";
  _killFeedEntries.length = 0;
}

function fxSpawnDamageNumber(x, y, dmg, isPlayerSide) {
  _fxParticles.push({
    kind: "dmg", x, y,
    vx: (Math.random() - 0.5) * 0.3,
    vy: -0.6,
    life: 0, maxLife: 60,
    text: `-${Math.round(dmg)}`,
    color: isPlayerSide ? "#ff4d6d" : "#fef08a",
    size: dmg > 20 ? 14 : 11,
  });
}

function fxSpawnExplosion(x, y) {
  // Outer ring + burst
  _fxParticles.push({ kind: "ring", x, y, life: 0, maxLife: 28, color: "#fbbf24" });
  for (let i = 0; i < 10; i++) {
    const ang = (i / 10) * Math.PI * 2 + Math.random() * 0.3;
    const speed = 1.5 + Math.random() * 1.2;
    _fxParticles.push({
      kind: "spark", x, y,
      vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
      life: 0, maxLife: 24 + Math.floor(Math.random() * 10),
      color: i % 2 === 0 ? "#fbbf24" : "#ef4444",
    });
  }
}

function fxAdvanceAndRender() {
  if (_fxParticles.length === 0) return;
  const s = canvasScale();
  const { ox, oy } = canvasOffset();
  ctx.save();
  ctx.translate(ox, oy);

  for (let i = _fxParticles.length - 1; i >= 0; i--) {
    const p = _fxParticles[i];
    p.life++;
    if (p.life >= p.maxLife) { _fxParticles.splice(i, 1); continue; }
    const t = p.life / p.maxLife;
    const alpha = 1 - t;

    if (p.kind === "dmg") {
      p.x += p.vx;
      p.y += p.vy;
      p.vy *= 0.96;
      ctx.font = `700 ${p.size}px var(--font-mono, monospace)`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = p.color;
      ctx.globalAlpha = alpha;
      // Soft outline so numbers read against any background.
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.strokeText(p.text, p.x * s, p.y * s);
      ctx.fillText(p.text, p.x * s, p.y * s);
    } else if (p.kind === "spark") {
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.92;
      p.vy *= 0.92;
      ctx.beginPath();
      ctx.arc(p.x * s, p.y * s, Math.max(0.5, (1 - t) * 2.5), 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = alpha;
      ctx.fill();
    } else if (p.kind === "ring") {
      const r = t * 3.5 * s;
      ctx.beginPath();
      ctx.arc(p.x * s, p.y * s, r, 0, Math.PI * 2);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2 * (1 - t);
      ctx.globalAlpha = alpha;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function killFeedAdd(html) {
  if (!killFeedEl) return;
  const el = document.createElement("div");
  el.className = "kill-feed-entry";
  el.innerHTML = html;
  killFeedEl.appendChild(el);
  const entry = { el, expiresAt: performance.now() + KILL_FEED_TTL_MS };
  _killFeedEntries.push(entry);

  // Trim to 4 entries on screen for legibility.
  while (_killFeedEntries.length > 4) {
    const old = _killFeedEntries.shift();
    old.el.remove();
  }
  scheduleKillFeedSweep();
}

let _killFeedSweepHandle = null;
function scheduleKillFeedSweep() {
  if (_killFeedSweepHandle) return;
  _killFeedSweepHandle = setInterval(() => {
    const now = performance.now();
    for (let i = _killFeedEntries.length - 1; i >= 0; i--) {
      const entry = _killFeedEntries[i];
      if (now < entry.expiresAt) continue;
      entry.el.classList.add("kf-leaving");
      _killFeedEntries.splice(i, 1);
      setTimeout(() => entry.el.remove(), 450);
    }
    if (_killFeedEntries.length === 0) {
      clearInterval(_killFeedSweepHandle);
      _killFeedSweepHandle = null;
    }
  }, 250);
}

/**
 * Map a robot id to a friendly display name + team color. Pulls from the
 * replayLabels meta used by the existing match HUD.
 */
function fxLabelFor(robotId) {
  const meta = _fxMeta[robotId];
  if (meta) return meta;
  const name = replayLabels?.[robotId];
  return { name: name || robotId, teamId: 0 };
}

function fxTeamColor(teamId) {
  return teamId === 0 ? "#00d4ff" : "#ff3355";
}

/**
 * Process a newly-rendered frame: dispatch sounds, spawn damage particles,
 * push kill-feed entries. Idempotent across re-renders of the same frame
 * (we only fire once per frame index per replay).
 */
function processFrameEffects(frame, frameIndex) {
  if (!frame || frameIndex <= _lastFxFrameIndex) return;
  _lastFxFrameIndex = frameIndex;

  const events = frame.events || [];
  if (events.length === 0) return;

  // Quick robotId → position lookup
  const positions = new Map();
  for (const r of frame.robots || []) positions.set(r.id, r.position);

  let damageCount = 0;
  let killCount = 0;
  for (const e of events) {
    if (!e) continue;
    if (e.type === "damaged" && e.data) {
      damageCount++;
      const pos = positions.get(e.robotId);
      if (pos && e.data.damage > 0) {
        const label = fxLabelFor(e.robotId);
        fxSpawnDamageNumber(pos.x, pos.y - 2, e.data.damage, label.teamId === 0);
      }
    } else if (e.type === "destroyed") {
      killCount++;
      const pos = positions.get(e.robotId);
      if (pos) fxSpawnExplosion(pos.x, pos.y);

      const victim = fxLabelFor(e.robotId);
      const killerId = e.data?.killedBy ?? e.data?.sourceId;
      const killer = killerId && killerId !== e.robotId ? fxLabelFor(killerId) : null;
      const victimChip = `<span class="kf-icon" style="background:${fxTeamColor(victim.teamId)}22;color:${fxTeamColor(victim.teamId)};">${escapeHtml((victim.name || "?").slice(0,1).toUpperCase())}</span>`;
      if (killer && killer.name && killer.name !== victim.name) {
        const killerChip = `<span class="kf-icon" style="background:${fxTeamColor(killer.teamId)}22;color:${fxTeamColor(killer.teamId)};">${escapeHtml((killer.name || "?").slice(0,1).toUpperCase())}</span>`;
        killFeedAdd(`${killerChip}<span>${escapeHtml(killer.name)}</span><span class="kf-arrow">&#9876;</span>${victimChip}<span class="kf-victim">${escapeHtml(victim.name)}</span>`);
      } else {
        killFeedAdd(`<span class="kf-suicide">&#10005;</span>${victimChip}<span class="kf-victim">${escapeHtml(victim.name)} eliminated</span>`);
      }
    }
  }

  if (damageCount > 0) SFX.playHit();
  if (killCount > 0) SFX.playExplode();
}

function drawIdle() {
  // When idle, preview the currently-selected arena preset so players see
  // exactly what terrain they are about to fight on.
  const preset = getArenaPreset(getMatchArenaId());
  currentArenaLayout = {
    covers: (preset.covers ?? []).map(c => ({ ...c })),
    controlPoints: (preset.controlPoints ?? []).map(cp => ({ ...cp })),
    healingZones: (preset.healingZones ?? []).map(hz => ({ ...hz })),
    hazards: (preset.hazards ?? []).map(hz => ({ ...hz })),
    depots: (preset.depots ?? []).map(d => ({ ...d })),
  };

  drawArenaBackground();
  const w = canvasEl.width;
  const h = canvasEl.height;
  const accent = preset.accent || "#00d4ff";

  // Arena name banner (top)
  ctx.save();
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
  ctx.font = `bold ${Math.max(13, w * 0.030)}px sans-serif`;
  ctx.fillText(preset.name.toUpperCase(), w / 2, 25);
  ctx.fillStyle = hexToRgba(accent, 0.7);
  ctx.font = `600 ${Math.max(9, w * 0.015)}px sans-serif`;
  ctx.fillText((preset.tagline ?? "").toUpperCase(), w / 2, 42);
  ctx.restore();

  // Centered call to action
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = hexToRgba(accent, 0.22);
  ctx.font = `bold ${Math.max(13, w * 0.026)}px sans-serif`;
  ctx.fillText("AWAITING COMBATANTS", w / 2, h / 2 - 8);
  ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
  ctx.font = `${Math.max(10, w * 0.017)}px sans-serif`;
  ctx.fillText("Compile a bot, then run a match", w / 2, h / 2 + 16);
  ctx.restore();
  ctx.textBaseline = "alphabetic";
}

// ============================================================================
// Match-Live Mode (Arena Dominance)
// ============================================================================

function resizeCanvasToWrap() {
  const wrap = document.querySelector(".arena-canvas-wrap");
  if (wrap) {
    const w = Math.max(400, wrap.clientWidth - 32);
    const h = Math.max(400, wrap.clientHeight - 32);
    if (canvasEl.width !== w || canvasEl.height !== h) {
      canvasEl.width = w;
      canvasEl.height = h;
    }
  }
}

function enterMatchLive(participants) {
  matchLiveParticipants = participants;
  if (matchLiveMode) {
    resizeCanvasToWrap();
    return;
  }
  matchLiveMode = true;
  document.body.classList.add("match-live");

  // Resize canvas after the layout transition settles.
  setTimeout(resizeCanvasToWrap, 50);
  setTimeout(resizeCanvasToWrap, 450);
}

function exitMatchLive() {
  if (!matchLiveMode) return;
  matchLiveMode = false;
  matchLiveParticipants = null;
  document.body.classList.remove("match-live");
  hideMatchIntro();
  clearMatchHud();

  // Reset canvas size for builder view
  if (currentView === "builder") {
    canvasEl.width = 400;
    canvasEl.height = 400;
  } else if (currentView === "arena") {
    requestAnimationFrame(resizeArenaCanvasForCurrentView);
  }

  // Redraw
  if (replayData && replayData[replayFrameIndex]) {
    drawFrame(replayData[replayFrameIndex], replayLabels, replayFrameIndex > 0 ? replayData[replayFrameIndex - 1] : null);
  }
}

/** Friendly display name for a participant's playerId. */
function prettyParticipantName(playerId) {
  if (!playerId) return "Bot";
  if (playerId === "player") return "You";
  return playerId.charAt(0).toUpperCase() + playerId.slice(1);
}

/**
 * Build the live broadcast overlay — scoreboard team names, the combatant HUD,
 * and the cinematic intro splash — for a freshly started match replay.
 */
function initMatchBroadcast(result) {
  const meta = result?.replay?.metadata ?? {};
  const participants = meta.participants ?? [];
  const frames = replayData ?? [];
  const frame0 = frames[0];

  // Map robotId -> class, pulled from the first replay frame.
  const classById = new Map();
  for (const r of frame0?.robots ?? []) classById.set(r.id, r.robotClass);

  // A match is free-for-all when there are 3+ distinct teams (battle royale).
  matchIsFFA = new Set(participants.map(p => p.teamId)).size > 2;
  matchFieldSize = participants.length;

  // robotId -> display metadata, used by the HUD, kill feed and results.
  matchParticipantMeta = new Map();
  for (const p of participants) {
    matchParticipantMeta.set(p.robotId, {
      name: prettyParticipantName(p.playerId),
      teamId: p.teamId,
      cls: classById.get(p.robotId) || "brawler",
      isPlayer: p.teamId === 0 && p.playerId === "player",
    });
  }

  // Precompute elimination order by scanning every frame for the first tick a
  // robot is down. Robust (does not depend on event emission) and drives both
  // the live kill feed and final placement.
  const deathFrame = new Map();
  for (let fi = 0; fi < frames.length; fi++) {
    for (const r of frames[fi].robots) {
      if (!deathFrame.has(r.id) && r.health <= 0) deathFrame.set(r.id, fi);
    }
  }
  matchEliminations = [...deathFrame.entries()]
    .map(([robotId, fi]) => {
      const m = matchParticipantMeta.get(robotId) ?? {};
      return {
        robotId, frameIndex: fi, tick: frames[fi]?.tick ?? 0,
        name: m.name ?? "Bot", teamId: m.teamId ?? -1, isPlayer: !!m.isPlayer,
      };
    })
    .sort((a, b) => a.frameIndex - b.frameIndex);

  matchHudRows.clear();
  ffaHudRefs = null;
  matchScoreboard?.classList.toggle("is-ffa", matchIsFFA);
  matchIntroEl?.classList.toggle("is-ffa", matchIsFFA);

  if (matchIsFFA) {
    initFfaBroadcast(meta, participants, classById);
  } else {
    initTeamBroadcast(meta, participants, classById);
  }
}

/** Build the broadcast overlay for a standard 2-team match. */
function initTeamBroadcast(meta, participants, classById) {
  const team0 = participants.filter(p => p.teamId === 0);
  const team1 = participants.filter(p => p.teamId === 1);
  // Personal names for solo/duo teams; a team label once a squad gets large.
  const nameFor = (team, fallback) => team.length === 1
    ? prettyParticipantName(team[0].playerId)
    : (team.length === 2 ? team.map(p => prettyParticipantName(p.playerId)).join(" & ") : fallback);
  const name0 = nameFor(team0, "Blue Team");
  const name1 = nameFor(team1, "Red Team");

  if (scoreboardTeam0) scoreboardTeam0.textContent = name0;
  if (scoreboardTeam1) scoreboardTeam1.textContent = name1;
  if (scoreboardArena) scoreboardArena.textContent = meta.arenaName ?? "Arena";

  buildMatchHudTeam(matchHudTeam0, team0, classById, 0);
  buildMatchHudTeam(matchHudTeam1, team1, classById, 1);

  showMatchIntro(name0, name1, meta.arenaName ?? "Arena", false);
}

/** Build the broadcast overlay for a battle royale (free-for-all). */
function initFfaBroadcast(meta, participants, classById) {
  if (scoreboardTeam0) scoreboardTeam0.textContent = "Battle Royale";
  if (scoreboardTeam1) scoreboardTeam1.textContent = `${matchFieldSize} alive`;
  if (scoreboardArena) scoreboardArena.textContent = meta.arenaName ?? "Arena";

  const player = participants.find(p => p.teamId === 0 && p.playerId === "player");
  const playerCls = (player && classById.get(player.robotId)) || "brawler";

  if (matchHudTeam0) {
    matchHudTeam0.innerHTML = `
      <div class="br-hud-panel">
        <div class="br-hud-title">Battle Royale</div>
        <div class="br-hud-alive">
          <span class="br-hud-alive-n">${matchFieldSize}</span>
          <span class="br-hud-alive-label">still standing<br>of ${matchFieldSize} combatants</span>
        </div>
        <div class="hud-bot br-hud-you">
          <div class="hud-bot-top">
            <div class="hud-bot-icon ${escapeHtml(playerCls)}">${escapeHtml(playerCls.charAt(0).toUpperCase())}</div>
            <div class="hud-bot-id">
              <span class="hud-bot-name">You</span>
              <span class="hud-bot-class">${escapeHtml(playerCls)}</span>
            </div>
          </div>
          <div class="hud-bot-hp">
            <div class="hud-bot-hp-track"><div class="hud-bot-hp-fill"></div></div>
            <span class="hud-bot-hp-text">--</span>
            <span class="hud-bot-down-tag">Eliminated</span>
          </div>
        </div>
      </div>`;
  }
  if (matchHudTeam1) {
    matchHudTeam1.innerHTML = `
      <div class="br-feed-panel">
        <div class="br-feed-title">Eliminations</div>
        <div class="br-feed-list"></div>
      </div>`;
  }
  ffaHudRefs = {
    aliveN: matchHudTeam0?.querySelector(".br-hud-alive-n") ?? null,
    youRow: matchHudTeam0?.querySelector(".br-hud-you") ?? null,
    youFill: matchHudTeam0?.querySelector(".br-hud-you .hud-bot-hp-fill") ?? null,
    youText: matchHudTeam0?.querySelector(".br-hud-you .hud-bot-hp-text") ?? null,
    feed: matchHudTeam1?.querySelector(".br-feed-list") ?? null,
    playerRobotId: player?.robotId ?? null,
  };

  showMatchIntro("Battle Royale", `${matchFieldSize} combatants`, meta.arenaName ?? "Arena", true);
}

/** Render one team's roster of combatant cards into the given HUD container. */
function buildMatchHudTeam(container, members, classById, teamId) {
  if (!container) return;
  container.innerHTML = "";

  const header = document.createElement("div");
  header.className = "hud-team-header";
  const tag = document.createElement("span");
  tag.textContent = teamId === 0 ? "Blue Team" : "Red Team";
  const bar = document.createElement("span");
  bar.className = "hud-team-bar";
  header.append(tag, bar);
  container.appendChild(header);

  for (const p of members) {
    const cls = classById.get(p.robotId) || "brawler";
    const row = document.createElement("div");
    row.className = "hud-bot";
    row.dataset.robot = p.robotId;
    row.innerHTML = `
      <div class="hud-bot-top">
        <div class="hud-bot-icon ${escapeHtml(cls)}">${escapeHtml((cls || "?").charAt(0).toUpperCase())}</div>
        <div class="hud-bot-id">
          <span class="hud-bot-name">${escapeHtml(prettyParticipantName(p.playerId))}</span>
          <span class="hud-bot-class">${escapeHtml(cls)}</span>
        </div>
      </div>
      <div class="hud-bot-hp">
        <div class="hud-bot-hp-track"><div class="hud-bot-hp-fill"></div></div>
        <span class="hud-bot-hp-text">--</span>
        <span class="hud-bot-down-tag">Down</span>
      </div>`;
    container.appendChild(row);
    matchHudRows.set(p.robotId, {
      row,
      fill: row.querySelector(".hud-bot-hp-fill"),
      text: row.querySelector(".hud-bot-hp-text"),
    });
  }
}

/** Apply an HP percentage + tier classes to one HP-bar fill element. */
function applyHpBar(fill, text, robot) {
  const maxHp = CLASS_STATS[robot.robotClass]?.health || 100;
  const hp = Math.max(0, Math.round(robot.health));
  const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
  if (fill) {
    fill.style.width = pct + "%";
    fill.classList.toggle("hp-low", pct > 0 && pct <= 25);
    fill.classList.toggle("hp-mid", pct > 25 && pct <= 55);
  }
  if (text) text.textContent = String(hp);
}

/** Update the live HUD (team rosters, or the battle-royale panels) per frame. */
function updateMatchHud(frame) {
  if (!matchLiveMode || !frame || !frame.robots) return;

  if (matchIsFFA) {
    if (!ffaHudRefs) return;
    const aliveCount = frame.robots.reduce((n, r) => n + (r.health > 0 ? 1 : 0), 0);
    if (ffaHudRefs.aliveN) ffaHudRefs.aliveN.textContent = String(aliveCount);
    const you = frame.robots.find(r => r.id === ffaHudRefs.playerRobotId);
    if (you) {
      applyHpBar(ffaHudRefs.youFill, ffaHudRefs.youText, you);
      ffaHudRefs.youRow?.classList.toggle("is-down", you.health <= 0);
    }
    if (ffaHudRefs.feed) {
      const recent = matchEliminations.filter(e => e.tick <= frame.tick).slice(-7).reverse();
      ffaHudRefs.feed.innerHTML = recent.length
        ? recent.map(e =>
            `<div class="br-feed-row${e.isPlayer ? " is-you" : ""}">`
            + `<span class="br-feed-skull">☠</span>`
            + `<span class="br-feed-name">${escapeHtml(e.name)}</span>`
            + `<span class="br-feed-tick">t${e.tick}</span></div>`).join("")
        : `<div class="br-feed-empty">No eliminations yet</div>`;
    }
    return;
  }

  if (matchHudRows.size === 0) return;
  for (const r of frame.robots) {
    const row = matchHudRows.get(r.id);
    if (!row) continue;
    applyHpBar(row.fill, row.text, r);
    row.row.classList.toggle("is-down", r.health <= 0 || r.alive === false);
  }
}

function clearMatchHud() {
  if (matchHudTeam0) matchHudTeam0.innerHTML = "";
  if (matchHudTeam1) matchHudTeam1.innerHTML = "";
  matchHudRows.clear();
  ffaHudRefs = null;
  matchScoreboard?.classList.remove("is-ffa");
  matchIntroEl?.classList.remove("is-ffa");
}

/** Play the cinematic intro splash; auto-dismisses when the animation ends. */
function showMatchIntro(name0, name1, arenaName, isFfa) {
  if (!matchIntroEl) return;
  if (matchIntroTimer) { clearTimeout(matchIntroTimer); matchIntroTimer = null; }
  if (matchIntroTeam0) matchIntroTeam0.textContent = name0;
  if (matchIntroTeam1) matchIntroTeam1.textContent = name1;
  if (matchIntroArena) {
    matchIntroArena.textContent = isFfa ? `${name1} · ${arenaName}` : arenaName;
  }
  matchIntroEl.hidden = false;
  // Restart the CSS animation by forcing a reflow between class toggles.
  matchIntroEl.classList.remove("playing");
  void matchIntroEl.offsetWidth;
  matchIntroEl.classList.add("playing");
  matchIntroTimer = setTimeout(() => {
    matchIntroEl.hidden = true;
    matchIntroEl.classList.remove("playing");
    matchIntroTimer = null;
  }, 1850);
}

function hideMatchIntro() {
  if (matchIntroTimer) { clearTimeout(matchIntroTimer); matchIntroTimer = null; }
  if (matchIntroEl) {
    matchIntroEl.hidden = true;
    matchIntroEl.classList.remove("playing");
  }
}

function updateScoreboard(frame) {
  if (!matchLiveMode || !frame) return;
  const totalTicks = replayData?.[replayData.length - 1]?.tick ?? 0;
  if (scoreboardTick) scoreboardTick.textContent = `Tick ${frame.tick} / ${totalTicks}`;
  if (matchIsFFA && scoreboardTeam1) {
    const aliveCount = frame.robots.reduce((n, r) => n + (r.health > 0 ? 1 : 0), 0);
    scoreboardTeam1.textContent = `${aliveCount} alive`;
  }
}

/** Reveal the match results scorecard (called when the replay finishes). */
let _victoryStingPlayed = false;
function revealMatchResults() {
  if (matchResultsEl) matchResultsEl.classList.add("visible");
  if (!_victoryStingPlayed) {
    _victoryStingPlayed = true;
    SFX.playVictory();
  }
}

/** Show the results scorecard only while the final replay frame is on screen. */
function syncResultsToFrame() {
  if (!matchResultsEl) return;
  const atEnd = !!replayData && replayFrameIndex >= replayData.length - 1;
  matchResultsEl.classList.toggle("visible", atEnd);
}

// ============================================================================
// Replay System
// ============================================================================

function startReplay(result, opponentName) {
  if (currentView !== "arena") {
    setView("arena");
  }
  stopReplay();

  // Load the procedural arena layout from replay metadata
  const layout = result.replay.metadata?.arenaLayout;
  if (layout) {
    currentArenaLayout = layout;
  }

  const frames = result.replay.frames;
  if (frames.length === 0) {
    drawIdle();
    arenaStatus.textContent = "No frames";
    return;
  }

  replayData = frames;
  lastReplayBookmarks = computeBookmarks(frames);
  const labelsById = {};
  _fxMeta = {};
  for (const p of result.replay.metadata?.participants ?? []) {
    const name = (p.teamId === 0 && p.playerId === "player") ? "You" : p.playerId;
    labelsById[p.robotId] = name;
    _fxMeta[p.robotId] = { name, teamId: p.teamId ?? 0 };
  }
  replayLabels = labelsById;
  replayFrameIndex = 0;
  replayPlaying = true;
  replaySpeed = parseFloat(replaySpeedSelect.value) || 0.24;
  fxClearAll();
  _victoryStingPlayed = false;
  SFX.playStart();

  // Enter match-live mode — the arena takes over the screen — and build the
  // broadcast overlay (scoreboard, combatant HUD, cinematic intro).
  const participants = result.replay.metadata?.participants ?? [];
  enterMatchLive(participants);
  initMatchBroadcast(result);

  // Keep the results scorecard hidden until the match finishes — the live
  // replay is the show, the result is the payoff.
  if (matchResultsEl) matchResultsEl.classList.remove("visible");

  // Log bookmarks to console
  if (lastReplayBookmarks) {
    const bm = lastReplayBookmarks;
    if (bm.firstDamage !== null) logToConsole(`  Bookmark: First damage at tick ${frames[bm.firstDamage]?.tick ?? bm.firstDamage}`, "stat");
    if (bm.firstKill !== null) logToConsole(`  Bookmark: First kill at tick ${frames[bm.firstKill]?.tick ?? bm.firstKill}`, "stat");
  }

  // Setup controls
  replayControlsEl.classList.add("visible");
  replayScrubber.max = frames.length - 1;
  replayScrubber.value = 0;
  btnReplayToggle.textContent = "\u275A\u275A"; // pause icon
  arenaStatus.textContent = "Replaying...";

  lastReplayTimestamp = 0;
  replayAnimId = requestAnimationFrame(replayTick);
}

function stopReplay() {
  replayPlaying = false;
  if (replayAnimId) {
    cancelAnimationFrame(replayAnimId);
    replayAnimId = null;
  }
}

function replayTick(timestamp) {
  if (!replayData || !replayPlaying) return;

  if (!lastReplayTimestamp) lastReplayTimestamp = timestamp;
  const elapsed = timestamp - lastReplayTimestamp;

  // Advance based on speed — base rate: 1 frame per 16ms at 1x
  const msPerFrame = 16 / replaySpeed;
  if (elapsed >= msPerFrame) {
    lastReplayTimestamp = timestamp;

    if (replayFrameIndex >= replayData.length) {
      replayPlaying = false;
      btnReplayToggle.textContent = "\u25B6";
      revealMatchResults();
      return;
    }
    const frame = replayData[replayFrameIndex];
    if (!frame) return;
    drawFrame(frame, replayLabels);
    processFrameEffects(frame, replayFrameIndex);
    fxAdvanceAndRender();
    replayScrubber.value = replayFrameIndex;
    replayTickLabel.textContent = `${frame.tick} / ${replayData[replayData.length - 1].tick}`;

    replayFrameIndex++;
    if (replayFrameIndex >= replayData.length) {
      replayPlaying = false;
      btnReplayToggle.textContent = "\u25B6";
      arenaStatus.textContent = `Done (${replayData[replayData.length - 1].tick} ticks)`;
      revealMatchResults();
      return;
    }
  }

  replayAnimId = requestAnimationFrame(replayTick);
}

function toggleReplayPlayPause() {
  if (!replayData) return;

  if (replayPlaying) {
    replayPlaying = false;
    btnReplayToggle.textContent = "\u25B6";
    arenaStatus.textContent = "Paused";
  } else {
    // If at end, restart from the top
    if (replayFrameIndex >= replayData.length) {
      replayFrameIndex = 0;
    }
    if (matchResultsEl) matchResultsEl.classList.remove("visible");
    replayPlaying = true;
    btnReplayToggle.textContent = "\u275A\u275A";
    arenaStatus.textContent = "Replaying...";
    lastReplayTimestamp = 0;
    replayAnimId = requestAnimationFrame(replayTick);
  }
}

function scrubReplay() {
  if (!replayData) return;
  const idx = parseInt(replayScrubber.value, 10);
  // Scrubbing backwards/forwards shouldn't replay old SFX or kill-feed
  // entries — wipe FX state and let the new frame re-paint silently.
  if (idx < _lastFxFrameIndex) fxClearAll();
  replayFrameIndex = idx;
  _lastFxFrameIndex = Math.max(_lastFxFrameIndex, idx);
  const frame = replayData[idx];
  if (frame) {
    drawFrame(frame, replayLabels);
    fxAdvanceAndRender();
    replayTickLabel.textContent = `${frame.tick} / ${replayData[replayData.length - 1].tick}`;
    arenaStatus.textContent = `Tick ${frame.tick}`;
    syncResultsToFrame();
  }
}

function stepReplayForward() {
  if (!replayData) return;
  stopReplay();
  btnReplayToggle.textContent = "\u25B6";
  if (replayFrameIndex < replayData.length - 1) {
    replayFrameIndex++;
  }
  const frame = replayData[replayFrameIndex];
  if (frame) {
    drawFrame(frame, replayLabels);
    replayScrubber.value = replayFrameIndex;
    replayTickLabel.textContent = `${frame.tick} / ${replayData[replayData.length - 1].tick}`;
    arenaStatus.textContent = `Tick ${frame.tick}`;
    syncResultsToFrame();
  }
}

function jumpToBookmark(bookmarkName) {
  if (!replayData || !lastReplayBookmarks) return;
  const idx = lastReplayBookmarks[bookmarkName];
  if (idx === null || idx === undefined) {
    logToConsole(`No ${bookmarkName} bookmark found in this replay.`, "warn");
    return;
  }
  stopReplay();
  btnReplayToggle.textContent = "\u25B6";
  replayFrameIndex = idx;
  const frame = replayData[idx];
  if (frame) {
    drawFrame(frame, replayLabels);
    replayScrubber.value = idx;
    replayTickLabel.textContent = `${frame.tick} / ${replayData[replayData.length - 1].tick}`;
    arenaStatus.textContent = `Tick ${frame.tick} (${bookmarkName})`;
    syncResultsToFrame();
  }
}

function stepReplayBack() {
  if (!replayData) return;
  stopReplay();
  btnReplayToggle.textContent = "\u25B6";
  if (replayFrameIndex > 0) {
    replayFrameIndex--;
  }
  const frame = replayData[replayFrameIndex];
  if (frame) {
    drawFrame(frame, replayLabels);
    replayScrubber.value = replayFrameIndex;
    replayTickLabel.textContent = `${frame.tick} / ${replayData[replayData.length - 1].tick}`;
    arenaStatus.textContent = `Tick ${frame.tick}`;
    syncResultsToFrame();
  }
}

// ============================================================================
// Preset Loading
// ============================================================================

function loadPreset(key) {
  const preset = getBotEntry(key);
  if (!preset) return;
  editorEl.value = preset.source;
  currentPreset = key;
  currentEditorBotName = preset.name;
  currentEditorUserBotId = key.startsWith("user_") ? key : null;
  currentEditorRemoteBotId = null;
  if (currentEditorUserBotId) {
    const map = getRemoteBotMap();
    for (const [remoteId, localId] of Object.entries(map)) {
      if (localId === currentEditorUserBotId) {
        currentEditorRemoteBotId = remoteId;
        break;
      }
    }
  }

  presetButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.bot === key);
  });

  // Also highlight user bot sidebar entries
  document.querySelectorAll(".sidebar-user-bot").forEach((el) => {
    el.classList.toggle("active", el.dataset.bot === key);
  });

  compiledPlayer = null;
  btnRun.disabled = true;
  clearErrors();
  updateHighlighting();
  updateLineNumbers();
  updateEditorFileName();
  updateArenaLoadedBotLabel();
}

// ============================================================================
// Editor Events
// ============================================================================

let highlightDebounce = null;

function onEditorInput() {
  updateHighlighting();
  updateLineNumbers();
  syncScroll();
}

editorEl.addEventListener("input", () => {
  // Debounce highlighting for performance
  clearTimeout(highlightDebounce);
  highlightDebounce = setTimeout(onEditorInput, 30);
});

editorEl.addEventListener("scroll", syncScroll);

/**
 * Editor key handling: indentation, bracket auto-close, smart Enter.
 *
 * The autocomplete popup installs its own `keydown` listener and pre-empts
 * Tab / Enter / Escape while it's visible. Because DOM listeners fire in
 * registration order, this handler runs first — so we check the popup's
 * visibility up front and defer to it when open. That also closes a latent
 * double-insert bug that existed before Phase 3 (Tab with autocomplete open
 * would insert 2 spaces AND an accepted completion).
 */
const AUTO_CLOSE_PAIRS = { "(": ")", "[": "]", "{": "}", '"': '"' };

function isAutocompleteOpen() {
  const el = document.querySelector(".editor-autocomplete");
  return !!(el && !el.hidden);
}

/**
 * Count `"` characters before the caret on the current line so we don't
 * auto-close a string inside another string (the heuristic used by the
 * autocomplete gating earlier).
 */
function cursorIsInsideStringLiteral() {
  const src = editorEl.value;
  const pos = editorEl.selectionStart;
  const lineStart = src.lastIndexOf("\n", pos - 1) + 1;
  const prefix = src.slice(lineStart, pos);
  let count = 0;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] === "\\") { i++; continue; } // skip escaped char
    if (prefix[i] === '"') count++;
  }
  return count % 2 === 1;
}

/**
 * Compute indentation (leading whitespace only) of the line containing `pos`.
 * Returns the exact whitespace substring so we can preserve tabs or mixed
 * indent if anyone somehow gets them in — the editor itself uses 2-space
 * indent but we don't want to corrupt pasted code.
 */
function indentOfLine(src, pos) {
  const lineStart = src.lastIndexOf("\n", pos - 1) + 1;
  let i = lineStart;
  while (i < src.length && (src[i] === " " || src[i] === "\t")) i++;
  return src.slice(lineStart, i);
}

function insertAtCursor(text, caretOffsetFromEnd = 0) {
  const start = editorEl.selectionStart;
  const end = editorEl.selectionEnd;
  editorEl.value = editorEl.value.slice(0, start) + text + editorEl.value.slice(end);
  const newCaret = start + text.length - caretOffsetFromEnd;
  editorEl.selectionStart = editorEl.selectionEnd = newCaret;
  onEditorInput();
}

editorEl.addEventListener("keydown", (e) => {
  // Defer to the autocomplete popup when it's up.
  if (isAutocompleteOpen() && (e.key === "Tab" || e.key === "Enter" || e.key === "Escape"
      || e.key === "ArrowUp" || e.key === "ArrowDown")) {
    return;
  }

  if (e.key === "Tab") {
    e.preventDefault();
    const start = editorEl.selectionStart;
    const end = editorEl.selectionEnd;
    editorEl.value =
      editorEl.value.substring(0, start) + "  " + editorEl.value.substring(end);
    editorEl.selectionStart = editorEl.selectionEnd = start + 2;
    onEditorInput();
    return;
  }

  // Smart Enter: preserve the current line's indent, and add one extra level
  // when the previous non-whitespace char on the line is `{`. Skip when the
  // user has a selection (Enter should replace selections normally).
  if (e.key === "Enter" && !e.shiftKey && editorEl.selectionStart === editorEl.selectionEnd) {
    const pos = editorEl.selectionStart;
    const src = editorEl.value;
    const baseIndent = indentOfLine(src, pos);
    // Find the last non-whitespace char before the caret on the same line.
    const lineStart = src.lastIndexOf("\n", pos - 1) + 1;
    let j = pos - 1;
    while (j >= lineStart && (src[j] === " " || src[j] === "\t")) j--;
    const prevChar = j >= lineStart ? src[j] : "";
    const nextChar = src[pos] ?? "";

    if (prevChar === "{" && nextChar === "}") {
      // { | }  ->  insert newline+indent+extra, newline+indent, keep caret in middle
      e.preventDefault();
      const extra = "  ";
      const inserted = `\n${baseIndent}${extra}\n${baseIndent}`;
      insertAtCursor(inserted, baseIndent.length + 1);
      return;
    }
    if (prevChar === "{") {
      e.preventDefault();
      const extra = "  ";
      insertAtCursor(`\n${baseIndent}${extra}`);
      return;
    }
    if (baseIndent.length > 0) {
      e.preventDefault();
      insertAtCursor(`\n${baseIndent}`);
      return;
    }
  }

  // Auto-close brackets and quotes. Only fire when there's no selection —
  // wrapping a selection would be a separate, more opinionated feature and
  // can surprise users who expect the character to overwrite their selection.
  if (editorEl.selectionStart === editorEl.selectionEnd && AUTO_CLOSE_PAIRS[e.key]) {
    const opener = e.key;
    const closer = AUTO_CLOSE_PAIRS[opener];
    const src = editorEl.value;
    const pos = editorEl.selectionStart;
    const nextChar = src[pos] ?? "";

    // Don't auto-pair a quote if the caret is already inside a string —
    // the user is almost certainly closing it by hand.
    if (opener === '"' && cursorIsInsideStringLiteral()) return;

    // Don't auto-pair if the next character is an identifier char. Typing
    // `(` before an existing `foo` usually means "wrap this call" and our
    // simple heuristic would leave a stray `)` mid-expression.
    if (/[A-Za-z0-9_]/.test(nextChar) && opener !== '"') return;

    e.preventDefault();
    insertAtCursor(opener + closer, 1);
    return;
  }

  // Skip-over-closer: typing `)` when the caret sits on an auto-inserted `)`
  // should move past it rather than inserting a second one. This is the
  // canonical editor-UX pattern.
  if ((e.key === ")" || e.key === "]" || e.key === "}" || e.key === '"')
      && editorEl.selectionStart === editorEl.selectionEnd
      && editorEl.value[editorEl.selectionStart] === e.key) {
    e.preventDefault();
    editorEl.selectionStart = editorEl.selectionEnd = editorEl.selectionStart + 1;
    return;
  }

  // Backspace inside an empty pair deletes both sides.
  if (e.key === "Backspace"
      && editorEl.selectionStart === editorEl.selectionEnd
      && editorEl.selectionStart > 0) {
    const pos = editorEl.selectionStart;
    const left = editorEl.value[pos - 1];
    const right = editorEl.value[pos];
    if (AUTO_CLOSE_PAIRS[left] === right) {
      e.preventDefault();
      editorEl.value = editorEl.value.slice(0, pos - 1) + editorEl.value.slice(pos + 1);
      editorEl.selectionStart = editorEl.selectionEnd = pos - 1;
      onEditorInput();
      return;
    }
  }
});

// ============================================================================
// Event Wiring
// ============================================================================

btnCompile.addEventListener("click", doCompile);
btnRun.addEventListener("click", doRunMatch);
btnCompileRun.addEventListener("click", doCompileAndRun);
btnClear.addEventListener("click", clearConsole);
btnRunTeamSim?.addEventListener("click", doRunTeamSimulation);
document.getElementById("btn-run-gauntlet")?.addEventListener("click", doRunGauntlet);

presetButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    loadPreset(btn.dataset.bot);
  });
});

// Replay controls
btnReplayToggle.addEventListener("click", toggleReplayPlayPause);
btnReplayStep?.addEventListener("click", stepReplayForward);
btnReplayStepBack?.addEventListener("click", stepReplayBack);
btnBookmarkDamage?.addEventListener("click", () => jumpToBookmark("firstDamage"));
btnBookmarkKill?.addEventListener("click", () => jumpToBookmark("firstKill"));
replayScrubber.addEventListener("input", () => {
  stopReplay();
  btnReplayToggle.textContent = "\u25B6";
  scrubReplay();
});
replaySpeedSelect.addEventListener("change", () => {
  replaySpeed = parseFloat(replaySpeedSelect.value) || 1;
});

// Resize handle for editor/arena split
const resizeHandle = document.getElementById("resize-handle");
const editorPane = document.querySelector(".editor-pane");
const arenaPane = document.querySelector(".arena-pane");
if (resizeHandle && editorPane && arenaPane) {
  let isResizing = false;
  resizeHandle.addEventListener("mousedown", (e) => {
    isResizing = true;
    resizeHandle.classList.add("active");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!isResizing) return;
    const workspace = document.querySelector(".workspace");
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const totalW = rect.width;
    const minEditor = 250;
    const minArena = 250;
    const editorW = Math.max(minEditor, Math.min(totalW - minArena - 5, offsetX));
    editorPane.style.flex = "none";
    editorPane.style.width = `${editorW}px`;
    arenaPane.style.flex = "none";
    arenaPane.style.width = `${totalW - editorW - 5}px`;
  });
  document.addEventListener("mouseup", () => {
    if (isResizing) {
      isResizing = false;
      resizeHandle.classList.remove("active");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  });
}

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === "Enter") {
    e.preventDefault();
    doCompileAndRun();
  } else if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    doCompile();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    // Ctrl/Cmd+S: save current editor program to library (browser default
    // would save the page — we suppress that and do something useful).
    e.preventDefault();
    document.getElementById("btn-save-library")?.click();
  } else if (!isFieldInFocus(e.target)) {
    // Replay controls (only when the user isn't typing). The replay
    // controls are also hidden outside of Arena view so the arrow keys
    // still feel "free" elsewhere.
    if (e.key === " " && currentView === "arena") {
      e.preventDefault();
      toggleReplayPlayPause();
    } else if (e.key === "ArrowRight" && currentView === "arena") {
      e.preventDefault();
      stepReplayForward();
    } else if (e.key === "ArrowLeft" && currentView === "arena") {
      e.preventDefault();
      stepReplayBack();
    }
  }
});

function isFieldInFocus(el) {
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

// ============================================================================
// Team Builder (Modal) — 2-team battles up to 5v5, plus battle royale rosters
// ============================================================================

const MAX_TEAM_SLOTS = 5;
const MAX_ROYALE_SLOTS = 20;

let tbMode = "team";          // "team" | "royale"
let tbLastFocusedElement = null;

const BOT_ICONS = {
  bruiser: "B", kiter: "K", fortress: "F",
  healer: "H", flanker: "L", sentinel: "S",
};

function botIconLetter(key) {
  if (key === "__editor__") return "★"; // star — the player's own bot
  if (BOT_ICONS[key]) return BOT_ICONS[key];
  const entry = getBotEntry(key);
  if (!entry) return "?";
  return (entry.name?.charAt(0) || "U").toUpperCase();
}

function tbGetBotClass(key) {
  return getBotEntry(key)?.class ?? "brawler";
}

/** The slot container for a roster ("ally" | "enemy" | "royale"). */
function tbContainerFor(team) {
  if (team === "ally") return tbAllySlots;
  if (team === "enemy") return tbEnemySlots;
  return tbRoyaleSlots;
}

function tbCountCards(container) {
  return container?.querySelectorAll(".tb-bot-card").length ?? 0;
}

/** A varied auto-fill preset key for slot index `i`. */
function tbAutofillKey(i) {
  return AUTOFILL_POOL[((i % AUTOFILL_POOL.length) + AUTOFILL_POOL.length) % AUTOFILL_POOL.length];
}

/**
 * Approximate "ceiling" stats used to normalize bars in the picker. Tuned to
 * what currently exists in CLASS_STATS so the strongest class in each axis
 * pegs the bar at 100%.
 */
const STAT_CEILINGS = { health: 150, moveSpeed: 2.2, attackDamage: 14, attackRange: 8.0 };

function renderStatBars(cls) {
  const stats = CLASS_STATS[cls] || CLASS_STATS.brawler;
  const pct = (val, ceil) => Math.max(8, Math.min(100, Math.round((val / ceil) * 100)));
  const row = (label, val, ceil, kind) => `
    <div class="tb-stat" title="${label}: ${val}">
      <span class="tb-stat-label">${label}</span>
      <div class="tb-stat-bar"><div class="tb-stat-bar-fill ${kind}" style="width:${pct(val, ceil)}%"></div></div>
    </div>`;
  return `
    ${row("HP",  stats.health,       STAT_CEILINGS.health,       "hp")}
    ${row("SPD", stats.moveSpeed,    STAT_CEILINGS.moveSpeed,    "spd")}
    ${row("DMG", stats.attackDamage, STAT_CEILINGS.attackDamage, "dmg")}
    ${row("RNG", stats.attackRange,  STAT_CEILINGS.attackRange,  "rng")}`;
}

function tbDisplayName(key, entry) {
  if (entry?.isEditor) return `${entry.name} (you)`;
  return entry?.name ?? key;
}

function tbRenderCardContent(card, botKey) {
  const entry = getBotEntry(botKey);
  const cls = entry?.class ?? "brawler";
  const safeCls = escapeHtml(cls);
  const meta = BOT_META[botKey];
  const role = entry?.isEditor ? "Your bot" : (entry?.isUser ? "My Bot" : (meta?.role ?? "Preset"));

  card.dataset.botKey = botKey;
  card.classList.toggle("tb-card-you", !!entry?.isEditor);
  card.innerHTML = `
    <div class="tb-card-icon ${safeCls}">${escapeHtml(botIconLetter(botKey))}</div>
    <div class="tb-card-body">
      <span class="tb-card-name">${escapeHtml(tbDisplayName(botKey, entry))}</span>
      <span class="tb-card-meta">
        <span>${safeCls}</span><span class="dot"></span><span>${escapeHtml(role)}</span>
      </span>
      <div class="tb-card-stats">${renderStatBars(cls)}</div>
    </div>
    <div class="tb-card-actions">
      <button class="tb-change-btn" type="button" title="Pick a different robot">Change</button>
      <button class="tb-remove-btn" type="button" title="Remove">&times;</button>
    </div>`;
}

function tbCreateBotCard(team, botKey) {
  const card = document.createElement("div");
  card.className = "tb-bot-card";
  card.dataset.team = team;
  tbRenderCardContent(card, botKey);

  card.querySelector(".tb-change-btn").addEventListener("click", () => {
    openBotPicker({
      title: "Replace robot",
      currentKey: card.dataset.botKey,
      includeEditor: true,
      onPick: (newKey) => {
        tbRenderCardContent(card, newKey);
        tbUpdateInfo();
      },
    });
  });

  card.querySelector(".tb-remove-btn").addEventListener("click", () => {
    card.remove();
    tbUpdateInfo();
    tbUpdateEmptyStates();
  });

  return card;
}

function tbUpdateEmptyStates() {
  for (const container of [tbAllySlots, tbEnemySlots, tbRoyaleSlots]) {
    if (!container) continue;
    const existing = container.querySelector(".tb-empty");
    if (tbCountCards(container) === 0) {
      if (!existing) {
        const empty = document.createElement("div");
        empty.className = "tb-empty";
        empty.textContent = "No bots added yet";
        container.appendChild(empty);
      }
    } else if (existing) {
      existing.remove();
    }
  }
}

function tbUpdateInfo() {
  if (tbMode === "royale") {
    const n = tbCountCards(tbRoyaleSlots);
    if (tbMatchInfo) tbMatchInfo.textContent = `${n} combatant${n === 1 ? "" : "s"}`;
    if (btnTbRun) btnTbRun.disabled = n < 3;
  } else {
    const a = tbCountCards(tbAllySlots);
    const e = tbCountCards(tbEnemySlots);
    if (tbMatchInfo) tbMatchInfo.textContent = `${a} vs ${e}`;
    if (btnTbRun) btnTbRun.disabled = a < 1 || e < 1;
  }
}

function tbAddBot(team, botKey) {
  const container = tbContainerFor(team);
  if (!container) return;
  const cap = team === "royale" ? MAX_ROYALE_SLOTS : MAX_TEAM_SLOTS;
  if (tbCountCards(container) >= cap) {
    logToConsole(`Roster is full (max ${cap}).`, "warn");
    return;
  }
  const empty = container.querySelector(".tb-empty");
  if (empty) empty.remove();
  container.appendChild(tbCreateBotCard(team, botKey));
  tbUpdateInfo();
}

/** Switch the modal between the Team Battle and Battle Royale layouts. */
function tbSetMode(mode) {
  tbMode = mode === "royale" ? "royale" : "team";
  for (const btn of document.querySelectorAll(".tb-mode-btn")) {
    btn.classList.toggle("active", btn.dataset.tbMode === tbMode);
  }
  for (const view of document.querySelectorAll(".tb-view")) {
    view.hidden = view.dataset.tbView !== tbMode;
  }
  if (btnTbRun) btnTbRun.textContent = tbMode === "royale" ? "Run Royale" : "Run Battle";
  tbUpdateInfo();
}

/** Fill the current layout's empty slots with a varied roster. */
function tbAutofill() {
  if (tbMode === "royale") {
    if (tbCountCards(tbRoyaleSlots) === 0) tbAddBot("royale", "__editor__");
    while (tbCountCards(tbRoyaleSlots) < 8) {
      tbAddBot("royale", tbAutofillKey(tbCountCards(tbRoyaleSlots)));
    }
  } else {
    if (tbCountCards(tbAllySlots) === 0) tbAddBot("ally", "__editor__");
    while (tbCountCards(tbAllySlots) < 3) {
      tbAddBot("ally", tbAutofillKey(tbCountCards(tbAllySlots) + 1));
    }
    while (tbCountCards(tbEnemySlots) < 3) {
      tbAddBot("enemy", tbAutofillKey(tbCountCards(tbEnemySlots) + 7));
    }
  }
  tbUpdateEmptyStates();
}

/** Remove every bot from the current layout. */
function tbClear() {
  const containers = tbMode === "royale" ? [tbRoyaleSlots] : [tbAllySlots, tbEnemySlots];
  for (const c of containers) { if (c) c.innerHTML = ""; }
  tbUpdateEmptyStates();
  tbUpdateInfo();
}

function tbOpenModal() {
  if (!teamBuilderModal) return;

  if (tbAllySlots) tbAllySlots.innerHTML = "";
  if (tbEnemySlots) tbEnemySlots.innerHTML = "";
  if (tbRoyaleSlots) tbRoyaleSlots.innerHTML = "";

  // Sensible starting rosters for both layouts.
  tbAddBot("ally", "__editor__");
  tbAddBot("ally", "healer");
  tbAddBot("enemy", "kiter");
  tbAddBot("enemy", "fortress");
  tbAddBot("royale", "__editor__");
  for (let i = 1; i < 8; i++) tbAddBot("royale", tbAutofillKey(i));

  tbSetMode("team");
  tbUpdateEmptyStates();
  // Remember the opener so focus can be restored for keyboard users.
  tbLastFocusedElement = document.activeElement;
  teamBuilderModal.hidden = false;
  (btnTbRun || btnCloseTeamBuilder)?.focus?.();
}

function tbCloseModal() {
  if (teamBuilderModal) teamBuilderModal.hidden = true;
  if (tbLastFocusedElement && typeof tbLastFocusedElement.focus === "function") {
    tbLastFocusedElement.focus();
  }
  tbLastFocusedElement = null;
}

/**
 * Compile every card in a container into participant objects. `teamFn(i)`
 * supplies the team id. `nameState` carries the cross-roster name allocator so
 * the engine never sees a duplicate playerId.
 */
function tbCollectRoster(container, teamFn, nameState) {
  const cards = container ? [...container.querySelectorAll(".tb-bot-card")] : [];
  const out = [];
  for (let i = 0; i < cards.length; i++) {
    const key = cards[i].dataset.botKey;
    const entry = getBotEntry(key);
    if (!entry) { logToConsole(`Unknown bot: ${key}`, "error"); return null; }
    let compiled;
    try { compiled = compile(entry.source); }
    catch (e) { logToConsole(`${entry.name} error: ${e.message}`, "error"); return null; }
    if (!compiled.success) {
      logToConsole(`${entry.name} failed to compile: ${compiled.errors.join(", ")}`, "error");
      return null;
    }
    // The editor bot becomes "player" (highlighted as You) on its first use.
    let playerId;
    if (entry.isEditor && !nameState.playerUsed) {
      playerId = "player";
      nameState.playerUsed = true;
    } else {
      const base = entry.isEditor ? "Your Bot" : entry.name;
      let name = base, n = 2;
      while (nameState.used.has(name.toLowerCase())) name = `${base} ${n++}`;
      nameState.used.add(name.toLowerCase());
      playerId = name;
    }
    out.push({
      program: compiled.program, constants: compiled.constants,
      playerId, teamId: teamFn(i),
    });
  }
  return out;
}

async function tbRunBattle() {
  const nameState = { used: new Set(["you"]), playerUsed: false };
  let participants, mode, label;
  // Snapshot the enemy roster's bot keys NOW (before the modal closes) so
  // we can credit per-opponent W/L records after the match finishes.
  const enemyKeysSnapshot = [...(tbEnemySlots?.querySelectorAll(".tb-bot-card") ?? [])]
    .map((c) => c.dataset.botKey)
    .filter((k) => k && k !== "__editor__");

  if (tbMode === "royale") {
    const roster = tbCollectRoster(tbRoyaleSlots, () => 0, nameState);
    if (!roster) return;
    if (roster.length < 3) {
      logToConsole("Battle royale needs at least 3 combatants.", "warn");
      return;
    }
    // Put the player first so they anchor team 0, then give each its own team.
    roster.sort((a, b) => (b.playerId === "player" ? 1 : 0) - (a.playerId === "player" ? 1 : 0));
    roster.forEach((p, i) => { p.teamId = i; });
    participants = roster;
    mode = "battle_royale";
    label = `Battle Royale · ${roster.length} bots`;
  } else {
    const allies = tbCollectRoster(tbAllySlots, () => 0, nameState);
    if (!allies) return;
    const enemies = tbCollectRoster(tbEnemySlots, () => 1, nameState);
    if (!enemies) return;
    if (allies.length < 1 || enemies.length < 1) {
      logToConsole("Both teams need at least one bot.", "warn");
      return;
    }
    participants = [...allies, ...enemies];
    const maxN = Math.max(allies.length, enemies.length);
    mode = maxN <= 1 ? "duel_1v1" : maxN <= 2 ? "squad_2v2"
      : maxN <= 3 ? "team_3v3" : maxN <= 4 ? "team_4v4" : "team_5v5";
    label = `Team Battle · ${allies.length}v${enemies.length}`;
  }

  const setup = {
    config: {
      mode, arenaWidth: ARENA_WIDTH, arenaHeight: ARENA_HEIGHT,
      maxTicks: 3000, tickRate: 30, seed: getMatchSeed(),
      arenaId: getMatchArenaId(),
    },
    participants,
  };

  tbCloseModal();
  logToConsole(`\n--- Team Builder: ${label} ---`, "event");
  showMatchLoading("Simulating match…", label);
  await nextFrame();

  let result;
  try {
    telemetry.increment(Telemetry.MATCH_RUN);
    result = runMatch(setup);
  } catch (e) {
    telemetry.increment(Telemetry.MATCH_ERROR);
    logToConsole(`Match error: ${e.message}`, "error");
    hideMatchLoading();
    return;
  } finally {
    hideMatchLoading();
  }

  telemetry.record(Telemetry.MATCH_DURATION_TICKS, result.tickCount);
  lastMatchResult = result;
  recordMatchAchievements(result);
  // Credit each enemy-team bot key with a win/loss against the player.
  // Skipped for battle royale where there's no clear 1v1 opponent.
  if (mode !== "battle_royale" && enemyKeysSnapshot.length > 0) {
    const playerWon = result.winner === 0;
    const isDraw = result.winner === null;
    for (const k of enemyKeysSnapshot) {
      MatchStats.recordVersus(k, {
        won: isDraw ? null : playerWon,
        opponentClass: getBotEntry(k)?.class || null,
      });
    }
  }
  logToConsole(`Winner: ${result.winner === null ? "DRAW" : `Team ${result.winner}`}  |  ${result.reason}  |  ${result.tickCount} ticks`, "success");
  flushBotLogs(result.botLogs);
  showMatchResults(result, null);
  startReplay(result, null);
}

// ============================================================================
// Full-page Battle & Decision Traces Toggles
// ============================================================================

function exitFullPageBattle() {
  fullPageBattle = false;
  document.body.classList.remove("fullpage-battle");
  btnToggleFullpage?.classList.remove("active");
  if (btnToggleFullpage) btnToggleFullpage.textContent = "Expand";
}

function toggleFullPageBattle() {
  fullPageBattle = !fullPageBattle;
  document.body.classList.toggle("fullpage-battle", fullPageBattle);
  btnToggleFullpage?.classList.toggle("active", fullPageBattle);
  if (btnToggleFullpage) btnToggleFullpage.textContent = fullPageBattle ? "Collapse" : "Expand";

  // Resize canvas for full-page mode
  requestAnimationFrame(() => {
    if (fullPageBattle) {
      const wrap = document.querySelector(".arena-canvas-wrap");
      if (wrap) {
        canvasEl.width = Math.max(400, wrap.clientWidth - 32);
        canvasEl.height = Math.max(400, wrap.clientHeight - 32);
      }
    } else {
      canvasEl.width = 400;
      canvasEl.height = 400;
    }

    // Redraw current frame
    if (replayData && replayData[replayFrameIndex]) {
      drawFrame(replayData[replayFrameIndex], replayLabels, replayFrameIndex > 0 ? replayData[replayFrameIndex - 1] : null);
    }
  });
}

function toggleDecisionTraces() {
  showDecisionTraces = !showDecisionTraces;
  btnToggleTraces?.classList.toggle("active", showDecisionTraces);

  // Redraw current frame
  if (replayData && replayData[replayFrameIndex]) {
    drawFrame(replayData[replayFrameIndex], replayLabels, replayFrameIndex > 0 ? replayData[replayFrameIndex - 1] : null);
  }
}

function toggleVisionOverlay() {
  showVisionOverlay = !showVisionOverlay;
  btnToggleVision?.classList.toggle("active", showVisionOverlay);
  if (replayData && replayData[replayFrameIndex]) {
    drawFrame(replayData[replayFrameIndex], replayLabels, replayFrameIndex > 0 ? replayData[replayFrameIndex - 1] : null);
  }
}

// --- Canvas hover inspector -------------------------------------------------
//
// Hover the canvas during a replay to inspect the robot under the cursor.
// We reuse the current replay frame rather than listening to engine state so
// the tooltip stays correct while scrubbing or paused. Pure read-only — no
// frame mutation — so this can't break rendering or determinism.

const canvasTooltipEl = (() => {
  if (typeof document === "undefined") return null;
  const el = document.createElement("div");
  el.className = "canvas-tooltip";
  el.hidden = true;
  document.body.appendChild(el);
  return el;
})();

function currentReplayFrame() {
  if (!replayData || replayData.length === 0) return null;
  const idx = Math.min(replayFrameIndex, replayData.length - 1);
  return replayData[idx] ?? null;
}

/** Pixel -> arena coord, accounting for CSS scaling of the canvas. */
function canvasPxToArena(clientX, clientY) {
  const rect = canvasEl.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const pxX = (clientX - rect.left) * (canvasEl.width / rect.width);
  const pxY = (clientY - rect.top)  * (canvasEl.height / rect.height);
  const s = canvasScale();
  if (s === 0) return null;
  const { ox, oy } = canvasOffset();
  return { x: (pxX - ox) / s, y: (pxY - oy) / s };
}

function findRobotAt(frame, arenaX, arenaY, maxArenaDist = 3) {
  if (!frame || !frame.robots) return null;
  let best = null;
  let bestDist = maxArenaDist;
  for (const r of frame.robots) {
    if (r.health <= 0) continue;
    const dx = r.position.x - arenaX;
    const dy = r.position.y - arenaY;
    const d = Math.hypot(dx, dy);
    if (d < bestDist) { bestDist = d; best = r; }
  }
  return best;
}

function formatAction(action) {
  if (!action) return "idle";
  if (typeof action === "string") return action;
  if (typeof action !== "object") return String(action);
  const type = action.type ?? "?";
  if (action.target && typeof action.target === "object" && "x" in action.target) {
    return `${type} → (${Math.round(action.target.x)}, ${Math.round(action.target.y)})`;
  }
  if (action.target) return `${type} → ${action.target}`;
  return type;
}

function hideCanvasTooltip() {
  if (canvasTooltipEl) canvasTooltipEl.hidden = true;
}

canvasEl?.addEventListener("mousemove", (e) => {
  if (!canvasTooltipEl) return;
  const frame = currentReplayFrame();
  if (!frame) { hideCanvasTooltip(); return; }
  const arena = canvasPxToArena(e.clientX, e.clientY);
  if (!arena) { hideCanvasTooltip(); return; }
  const hit = findRobotAt(frame, arena.x, arena.y, 3.5);
  if (!hit) { hideCanvasTooltip(); return; }

  const label = replayLabels?.[hit.id] ?? hit.id;
  const cs = CLASS_STATS[hit.robotClass];
  const maxHP = cs?.health ?? 100;
  const hpPct = Math.max(0, Math.min(100, Math.round((hit.health / maxHP) * 100)));
  const team = hit.teamId === 0 ? "team 0" : "team 1";
  const cloak = hit.cloaked ? " · cloaked" : "";
  const heat = cs?.maxHeat !== undefined && hit.heat !== undefined ? ` · heat ${Math.round(hit.heat)}` : "";
  const action = formatAction(hit.action);

  canvasTooltipEl.innerHTML = `
    <div class="ct-row ct-title">
      <span class="ct-team team-${hit.teamId}">${team}</span>
      <b>${escapeHtml(label)}</b>
      <span class="ct-class">${escapeHtml(hit.robotClass ?? "")}</span>
    </div>
    <div class="ct-row">HP <b>${hit.health}</b> / ${maxHP} (${hpPct}%)</div>
    <div class="ct-row">tick <b>${frame.tick ?? 0}</b> · ${escapeHtml(action)}${cloak}${heat}</div>
  `;
  // Anchor to the cursor but flip to the left if near the right edge.
  const pad = 12;
  const rect = canvasTooltipEl.getBoundingClientRect();
  const desiredW = Math.max(rect.width, 220);
  let x = e.clientX + pad;
  if (x + desiredW > window.innerWidth - 8) x = e.clientX - desiredW - pad;
  canvasTooltipEl.style.left = `${Math.max(8, x)}px`;
  canvasTooltipEl.style.top = `${e.clientY + pad}px`;
  canvasTooltipEl.hidden = false;
});

canvasEl?.addEventListener("mouseleave", hideCanvasTooltip);

// ============================================================================
// Bot Picker — visual modal for choosing a robot
// ============================================================================

const botPickerModal = document.getElementById("bot-picker-modal");
const botPickerTitle = document.getElementById("bot-picker-title");
const botPickerGrid = document.getElementById("bot-picker-grid");
const botPickerSearch = document.getElementById("bot-picker-search");
const botPickerEmpty = document.getElementById("bot-picker-empty");

let _bpOnPick = null;
let _bpFilterClass = "";
let _bpQuery = "";
let _bpIncludeEditor = true;
let _bpCurrentKey = null;
let _bpLastFocused = null;

function bpClassFor(key) {
  return getBotEntry(key)?.class ?? "brawler";
}

function bpDifficulty(key) {
  return BOT_META[key]?.difficulty ?? 2;
}

function bpAllChoices() {
  const items = [];
  if (_bpIncludeEditor) {
    items.push({ key: "__editor__", source: "editor" });
  }
  for (const key of BOT_PICKER_ORDER) {
    if (BOT_PRESETS[key]) items.push({ key, source: "preset" });
  }
  for (const bot of BotLibrary.getAll()) {
    items.push({ key: bot.id, source: "user" });
  }
  return items;
}

function bpRenderCard({ key, source }) {
  const entry = getBotEntry(key);
  if (!entry) return "";
  const cls = entry.class ?? "brawler";
  const safeCls = escapeHtml(cls);
  const meta = BOT_META[key];
  const tagline = source === "editor"
    ? "Your live editor program — pick this to field your own code."
    : source === "user"
    ? "Saved to your library."
    : (meta?.tagline ?? "No description.");
  const role = source === "editor" ? "Your bot"
             : source === "user"   ? "My Bot"
             : (meta?.role ?? "Preset");
  const badges = [];
  if (source === "editor") badges.push(`<span class="bp-badge bp-badge-editor">YOU</span>`);
  if (source === "user")   badges.push(`<span class="bp-badge bp-badge-user">MY BOT</span>`);
  if (source === "preset") {
    const d = bpDifficulty(key);
    const label = d === 1 ? "EASY" : d === 2 ? "MEDIUM" : "ADVANCED";
    badges.push(`<span class="bp-badge bp-badge-diff-${d}">${label}</span>`);
  }
  // Per-opponent record chip — surfaces "you've beaten this 3 times" so the
  // picker doubles as a personal stats page.
  const rec = source !== "editor" ? MatchStats.recordFor(key) : null;
  if (rec && rec.played > 0) {
    const cls = rec.wins > rec.losses ? "bp-badge-rec-positive"
              : rec.losses > rec.wins ? "bp-badge-rec-negative"
              : "bp-badge-rec-even";
    const label = MatchStats.recordLabel(key);
    badges.push(`<span class="bp-badge ${cls}" title="Your record vs this bot">${escapeHtml(label)}</span>`);
  } else if (source !== "editor") {
    badges.push(`<span class="bp-badge bp-badge-rec-none" title="Never played">NEW</span>`);
  }
  return `
    <button class="bp-card" type="button" role="option" data-bot-key="${escapeHtml(key)}">
      <div class="bp-card-head">
        <div class="bp-card-icon ${safeCls}">${escapeHtml(botIconLetter(key))}</div>
        <div class="bp-card-title">
          <span class="bp-card-name">${escapeHtml(tbDisplayName(key, entry))}</span>
          <span class="bp-card-sub">${safeCls} · ${escapeHtml(role)}</span>
        </div>
      </div>
      <div class="bp-card-tag">${escapeHtml(tagline)}</div>
      <div class="bp-card-stats">${renderStatBars(cls)}</div>
      <div class="bp-card-badges">${badges.join("")}</div>
    </button>`;
}

function bpRender() {
  if (!botPickerGrid) return;
  const q = _bpQuery.trim().toLowerCase();
  const items = bpAllChoices().filter(({ key, source }) => {
    const entry = getBotEntry(key);
    if (!entry) return false;
    if (_bpFilterClass && entry.class !== _bpFilterClass) return false;
    if (q) {
      const hay = `${entry.name} ${entry.class} ${BOT_META[key]?.role ?? ""} ${BOT_META[key]?.tagline ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  botPickerGrid.innerHTML = items.map(bpRenderCard).join("");
  if (botPickerEmpty) botPickerEmpty.hidden = items.length > 0;
}

function openBotPicker({ title = "Pick a Robot", currentKey = null, includeEditor = true, onPick } = {}) {
  if (!botPickerModal) return;
  _bpOnPick = onPick;
  _bpCurrentKey = currentKey;
  _bpIncludeEditor = includeEditor;
  _bpQuery = "";
  _bpFilterClass = "";
  if (botPickerSearch) botPickerSearch.value = "";
  for (const f of document.querySelectorAll(".bp-filter")) {
    f.classList.toggle("active", f.dataset.bpClass === "");
  }
  if (botPickerTitle) botPickerTitle.textContent = title;
  _bpLastFocused = document.activeElement;
  botPickerModal.hidden = false;
  bpRender();
  setTimeout(() => botPickerSearch?.focus(), 30);
}

function closeBotPicker() {
  if (botPickerModal) botPickerModal.hidden = true;
  _bpOnPick = null;
  if (_bpLastFocused && typeof _bpLastFocused.focus === "function") {
    try { _bpLastFocused.focus(); } catch {}
  }
  _bpLastFocused = null;
}

botPickerGrid?.addEventListener("click", (e) => {
  const card = e.target.closest(".bp-card");
  if (!card) return;
  const key = card.dataset.botKey;
  const cb = _bpOnPick;
  closeBotPicker();
  if (typeof cb === "function") cb(key);
});

botPickerSearch?.addEventListener("input", () => {
  _bpQuery = botPickerSearch.value || "";
  bpRender();
});

for (const btn of document.querySelectorAll(".bp-filter")) {
  btn.addEventListener("click", () => {
    _bpFilterClass = btn.dataset.bpClass || "";
    for (const f of document.querySelectorAll(".bp-filter")) {
      f.classList.toggle("active", f === btn);
    }
    bpRender();
  });
}

document.getElementById("btn-close-bot-picker")?.addEventListener("click", closeBotPicker);
document.getElementById("btn-bot-picker-cancel")?.addEventListener("click", closeBotPicker);
botPickerModal?.addEventListener("click", (e) => {
  if (e.target === botPickerModal) closeBotPicker();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && botPickerModal && !botPickerModal.hidden) {
    closeBotPicker();
  }
});

// Quick Battle button in the top bar — directly opens the Team Builder.
document.getElementById("btn-quick-battle")?.addEventListener("click", () => {
  tbOpenModal();
});

// Wire Team Builder modal
btnOpenTeamBuilder?.addEventListener("click", tbOpenModal);
btnCloseTeamBuilder?.addEventListener("click", tbCloseModal);
btnTbCancel?.addEventListener("click", tbCloseModal);
btnTbRun?.addEventListener("click", tbRunBattle);

// Add-bot buttons: open the visual picker so the user actually chooses.
for (const btn of document.querySelectorAll(".tb-add-btn")) {
  btn.addEventListener("click", () => {
    const team = btn.dataset.team;
    const container = tbContainerFor(team);
    const cap = team === "royale" ? MAX_ROYALE_SLOTS : MAX_TEAM_SLOTS;
    if (tbCountCards(container) >= cap) {
      logToConsole(`Roster is full (max ${cap}).`, "warn");
      return;
    }
    openBotPicker({
      title: team === "enemy" ? "Add to Red Team"
           : team === "ally"  ? "Add to Blue Team"
                              : "Add a combatant",
      includeEditor: true,
      onPick: (key) => tbAddBot(team, key),
    });
  });
}

// Battle-format toggle + quick actions.
for (const btn of document.querySelectorAll(".tb-mode-btn")) {
  btn.addEventListener("click", () => tbSetMode(btn.dataset.tbMode));
}
document.getElementById("btn-tb-autofill")?.addEventListener("click", tbAutofill);
document.getElementById("btn-tb-clear")?.addEventListener("click", tbClear);

// Picking Battle Royale defaults the arena to the dedicated free-for-all map.
matchModeSelect?.addEventListener("change", () => {
  if (matchModeSelect.value === "battle_royale" && arenaSelect
      && [...arenaSelect.options].some(o => o.value === "nexus")) {
    arenaSelect.value = "nexus";
    currentArenaId = "nexus";
    updateArenaInfo();
    if (!replayData) drawIdle();
  }
});

// Close modal on overlay click
teamBuilderModal?.addEventListener("click", (e) => {
  if (e.target === teamBuilderModal) tbCloseModal();
});

// Close modal on Escape key — beta testers have complained about being
// trapped in the modal without a mouse.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && teamBuilderModal && !teamBuilderModal.hidden) {
    tbCloseModal();
  }
});

// Wire Arena toggles
btnToggleTraces?.addEventListener("click", toggleDecisionTraces);
btnToggleVision?.addEventListener("click", toggleVisionOverlay);
btnShareMatch?.addEventListener("click", doShareMatch);
btnToggleFullpage?.addEventListener("click", toggleFullPageBattle);

// Wire match-live exit button
btnExitMatchLive?.addEventListener("click", exitMatchLive);

// ============================================================================
// Bot Entry Helper (unified access: preset OR user library)
// ============================================================================

/**
 * Look up a bot by key. Returns a normalized { name, class, source } object,
 * or null if no match. Keys prefixed with "user_" resolve against the bot
 * library; anything else falls back to BOT_PRESETS.
 */
function getBotEntry(key) {
  if (!key) return null;
  // The live editor program — lets the Team Builder field the player's own bot.
  if (key === "__editor__") {
    return {
      name: currentEditorBotName || "Your Bot",
      class: compiledPlayer?.program?.robotClass || "brawler",
      source: editorEl.value,
      isEditor: true,
    };
  }
  if (typeof key === "string" && key.startsWith("user_")) {
    const bot = BotLibrary.getById(key);
    if (!bot) return null;
    return { name: bot.name, class: bot.class, source: bot.source, isUser: true, id: bot.id };
  }
  const preset = BOT_PRESETS[key];
  if (!preset) return null;
  return { name: preset.name, class: preset.class, source: preset.source, isUser: false };
}

/** Build <option> markup for every available bot, marking `selectedKey` as selected. */
function buildBotSelectOptions(selectedKey, includeEditor = false) {
  const groups = [];
  if (includeEditor) {
    const sel = selectedKey === "__editor__" ? " selected" : "";
    groups.push(`<optgroup label="Editor"><option value="__editor__"${sel}>★ Your Bot (editor)</option></optgroup>`);
  }
  const presetOpts = Object.entries(BOT_PRESETS)
    .map(([k, p]) => `<option value="${k}"${k === selectedKey ? " selected" : ""}>${escapeHtml(p.name)}</option>`)
    .join("");
  groups.push(`<optgroup label="Presets">${presetOpts}</optgroup>`);

  const userBots = BotLibrary.getAll();
  if (userBots.length > 0) {
    const userOpts = userBots
      .map((b) => `<option value="${b.id}"${b.id === selectedKey ? " selected" : ""}>${escapeHtml(b.name)} (${b.class})</option>`)
      .join("");
    groups.push(`<optgroup label="My Bots">${userOpts}</optgroup>`);
  }
  return groups.join("");
}

// ============================================================================
// Toast notifications
// ============================================================================

const toastContainer = document.getElementById("toast-container");

function toast(message, type = "info", timeout = 3500) {
  if (!toastContainer) return;
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  requestAnimationFrame(() => el.classList.add("visible"));
  setTimeout(() => {
    el.classList.remove("visible");
    setTimeout(() => el.remove(), 250);
  }, timeout);
}

// ============================================================================
// View Switching (Builder / Arena / Library)
// ============================================================================

function setView(name) {
  if (name !== "builder" && name !== "arena" && name !== "library" && name !== "community" && name !== "tournament") return;

  const leavingArena = currentView === "arena" && name !== "arena";
  currentView = name;
  document.body.dataset.view = name;

  // Arena playback should never keep occupying the UI after the user leaves
  // the Arena tab. Keep the replay data available, but stop animations and
  // collapse broadcast/full-page chrome so Builder and Library feel like clean
  // destinations rather than partial overlays.
  if (name !== "arena") {
    if (leavingArena) stopReplay();
    if (matchLiveMode) exitMatchLive();
    if (fullPageBattle) exitFullPageBattle();
  }

  // Top nav tabs
  document.querySelectorAll(".view-tab").forEach((btn) => {
    const active = btn.dataset.view === name;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });

  // Sidebar panels
  document.querySelectorAll(".sidebar-panel").forEach((panel) => {
    panel.hidden = panel.dataset.sidebar !== name;
  });

  // Main view content — library + community + tournament are separate areas
  const workspace = document.querySelector('[data-view-content="workspace"]');
  const libraryView = document.querySelector('[data-view-content="library"]');
  const communityView = document.querySelector('[data-view-content="community"]');
  const tournamentView = document.querySelector('[data-view-content="tournament"]');
  const isFullPageView = name === "library" || name === "community" || name === "tournament";
  if (workspace) workspace.hidden = isFullPageView;
  if (libraryView) libraryView.hidden = name !== "library";
  if (communityView) communityView.hidden = name !== "community";
  if (tournamentView) tournamentView.hidden = name !== "tournament";

  if (name === "library") {
    renderLibrary();
  } else if (name === "community") {
    renderCommunity();
  } else if (name === "tournament") {
    initTournamentView();
  } else if (name === "arena") {
    // Resize canvas to fill the arena pane since editor collapses
    requestAnimationFrame(resizeArenaCanvasForCurrentView);
  } else {
    // Builder: reset canvas to compact size
    canvasEl.width = 400;
    canvasEl.height = 400;
    if (replayData && replayData[replayFrameIndex]) {
      drawFrame(replayData[replayFrameIndex], replayLabels, replayFrameIndex > 0 ? replayData[replayFrameIndex - 1] : null);
    } else {
      drawIdle();
    }
  }

  updateArenaLoadedBotLabel();
}

function resizeArenaCanvasForCurrentView() {
  const wrap = document.querySelector(".arena-canvas-wrap");
  if (!wrap) return;
  const w = Math.max(400, wrap.clientWidth - 20);
  const h = Math.max(400, wrap.clientHeight - 20);
  canvasEl.width = w;
  canvasEl.height = h;
  if (replayData && replayData[replayFrameIndex]) {
    drawFrame(replayData[replayFrameIndex], replayLabels, replayFrameIndex > 0 ? replayData[replayFrameIndex - 1] : null);
  } else {
    drawIdle();
  }
}

document.querySelectorAll(".view-tab").forEach((btn) => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

window.addEventListener("resize", () => {
  if (matchLiveMode) {
    const wrap = document.querySelector(".arena-canvas-wrap");
    if (wrap) {
      canvasEl.width = Math.max(400, wrap.clientWidth - 32);
      canvasEl.height = Math.max(400, wrap.clientHeight - 32);
    }
    if (replayData && replayData[replayFrameIndex]) {
      drawFrame(replayData[replayFrameIndex], replayLabels, replayFrameIndex > 0 ? replayData[replayFrameIndex - 1] : null);
    }
  } else if (currentView === "arena") {
    resizeArenaCanvasForCurrentView();
  }
});

// ============================================================================
// Editor header / Arena loaded-bot label
// ============================================================================

const editorFileNameEl = document.getElementById("editor-file-name");
const arenaLoadedBotEl = document.getElementById("arena-loaded-bot");

function updateEditorFileName() {
  if (!editorFileNameEl) return;
  const base = (currentEditorBotName || "robot").replace(/\s+/g, "_").toLowerCase();
  editorFileNameEl.textContent = `${base}.arena${currentEditorUserBotId ? " (library)" : ""}`;
}

function updateArenaLoadedBotLabel() {
  if (!arenaLoadedBotEl) return;
  if (compiledPlayer) {
    arenaLoadedBotEl.textContent = `${currentEditorBotName || "Unnamed"} (compiled)`;
    arenaLoadedBotEl.classList.add("ok");
  } else {
    arenaLoadedBotEl.textContent = `${currentEditorBotName || "Unnamed"} (not compiled)`;
    arenaLoadedBotEl.classList.remove("ok");
  }
}

// ============================================================================
// Opponent select — dynamic, includes user bots
// ============================================================================

function refreshOpponentSelect() {
  if (!opponentSelect) return;
  const prev = opponentSelect.value || "kiter";
  opponentSelect.innerHTML = buildBotSelectOptions(prev);
  // If previous value is no longer valid, fall back to kiter
  if (!getBotEntry(opponentSelect.value)) {
    opponentSelect.value = "kiter";
  }
}

// ============================================================================
// Auth / Account UI
// ============================================================================

const authStatusEl = document.getElementById("auth-status");
const btnAuthOpen = document.getElementById("btn-auth-open");
const btnAuthLogout = document.getElementById("btn-auth-logout");
const btnSyncCloud = document.getElementById("btn-sync-cloud");
const authModal = document.getElementById("auth-modal");
const btnCloseAuth = document.getElementById("btn-close-auth");
const authModeEl = document.getElementById("auth-mode");
const authIdentityEl = document.getElementById("auth-identity");
const authEmailWrap = document.getElementById("auth-email-wrap");
const authUsernameWrap = document.getElementById("auth-username-wrap");
const authEmailEl = document.getElementById("auth-email");
const authUsernameEl = document.getElementById("auth-username");
const authPasswordEl = document.getElementById("auth-password");
const authMessageEl = document.getElementById("auth-message");
const btnAuthSubmit = document.getElementById("btn-auth-submit");
const REMOTE_BOT_MAP_KEY = "arenascript.remote.botmap.v1";

function setAuthMessage(text, kind = "info") {
  if (!authMessageEl) return;
  authMessageEl.textContent = text;
  authMessageEl.style.color = kind === "error" ? "#fca5a5" : kind === "success" ? "#86efac" : "";
}

function getRemoteBotMap() {
  try {
    const raw = localStorage.getItem(REMOTE_BOT_MAP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function setRemoteBotMap(map) {
  localStorage.setItem(REMOTE_BOT_MAP_KEY, JSON.stringify(map || {}));
}

function rememberRemoteMapping(remoteId, localId) {
  if (!remoteId || !localId) return;
  const map = getRemoteBotMap();
  map[remoteId] = localId;
  setRemoteBotMap(map);
}

function updateAuthUi() {
  if (currentUser) {
    if (authStatusEl) authStatusEl.textContent = `@${currentUser.username}`;
    if (btnAuthOpen) btnAuthOpen.hidden = true;
    if (btnAuthLogout) btnAuthLogout.hidden = false;
    if (btnSyncCloud) btnSyncCloud.hidden = false;
  } else {
    if (authStatusEl) authStatusEl.textContent = "Guest";
    if (btnAuthOpen) btnAuthOpen.hidden = false;
    if (btnAuthLogout) btnAuthLogout.hidden = true;
    if (btnSyncCloud) btnSyncCloud.hidden = true;
  }
}

function openAuthModal() {
  if (!authModal) return;
  authModal.hidden = false;
  setAuthMessage("Use login or create a new account.", "info");
}

function closeAuthModal() {
  if (!authModal) return;
  authModal.hidden = true;
}

function updateAuthModeUi() {
  const isRegister = authModeEl?.value === "register";
  if (authEmailWrap) authEmailWrap.hidden = !isRegister;
  if (authUsernameWrap) authUsernameWrap.hidden = !isRegister;
  if (authIdentityEl) authIdentityEl.placeholder = isRegister ? "Optional (email also accepted for login)" : "Email or username";
}

async function refreshCurrentUser() {
  if (!ApiClient.hasAuthToken()) {
    currentUser = null;
    updateAuthUi();
    return;
  }
  try {
    const me = await ApiClient.me();
    currentUser = me.user ?? null;
  } catch {
    currentUser = null;
  }
  updateAuthUi();
  if (currentUser) {
    // Keep share state on library cards accurate after sign-in / page reload.
    refreshVisibilityCache().then(() => {
      if (currentView === "library") renderLibrary();
    }).catch(() => {});
  }
}

async function syncRemoteBotsIntoLibrary() {
  if (!currentUser) return;
  const { bots } = await ApiClient.listRemoteBots();
  const map = getRemoteBotMap();
  let imported = 0;
  for (const rb of bots ?? []) {
    if (!rb?.id || !rb?.name) continue;
    if (rb?.visibility) setVisibilityCacheEntry(rb.id, rb.visibility);
    const mappedLocalId = map[rb.id];
    const mappedLocal = mappedLocalId ? BotLibrary.getById(mappedLocalId) : null;
    const versions = await ApiClient.listRemoteBotVersions(rb.id);
    const src = versions?.versions?.[0]?.source_code;
    if (!src) continue;
    if (mappedLocal) {
      const updated = BotLibrary.updateBot(mappedLocal.id, src);
      if (updated.ok) imported++;
      continue;
    }
    const added = BotLibrary.addBot(src, { overrideName: rb.name });
    if (added.ok) {
      rememberRemoteMapping(rb.id, added.bot.id);
      imported++;
    }
  }
  if (imported > 0) {
    toast(`Synced ${imported} cloud bot${imported > 1 ? "s" : ""}.`, "success");
  } else {
    toast("No new cloud bots to sync.", "info");
  }
}

btnAuthOpen?.addEventListener("click", openAuthModal);
btnCloseAuth?.addEventListener("click", closeAuthModal);
authModeEl?.addEventListener("change", updateAuthModeUi);
btnAuthLogout?.addEventListener("click", async () => {
  await ApiClient.logout();
  currentUser = null;
  updateAuthUi();
  if (currentView === "library") renderLibrary();
  toast("Signed out.", "info");
});
btnSyncCloud?.addEventListener("click", async () => {
  try {
    await syncRemoteBotsIntoLibrary();
  } catch (e) {
    toast(`Cloud sync failed: ${e.message ?? String(e)}`, "error");
  }
});
btnAuthSubmit?.addEventListener("click", async () => {
  try {
    const mode = authModeEl?.value || "login";
    if (mode === "register") {
      const email = authEmailEl?.value?.trim() || "";
      const username = authUsernameEl?.value?.trim() || "";
      const password = authPasswordEl?.value || "";
      const data = await ApiClient.register({ email, username, password });
      currentUser = data.user;
      setAuthMessage("Account created successfully.", "success");
    } else {
      const identity = authIdentityEl?.value?.trim() || "";
      const password = authPasswordEl?.value || "";
      const data = await ApiClient.login({ identity, password });
      currentUser = data.user;
      setAuthMessage("Signed in successfully.", "success");
    }
    updateAuthUi();
    setTimeout(closeAuthModal, 250);
  } catch (e) {
    setAuthMessage(e.message ?? String(e), "error");
  }
});

// ============================================================================
// Save-to-Library button
// ============================================================================

const btnSaveLibrary = document.getElementById("btn-save-library");

btnSaveLibrary?.addEventListener("click", async () => {
  const source = editorEl.value;
  if (!source.trim()) {
    toast("Editor is empty.", "warn");
    return;
  }

  // If this editor already represents a library bot, update it in place.
  if (currentEditorUserBotId) {
    const r = BotLibrary.updateBot(currentEditorUserBotId, source);
    if (r.ok) {
      currentEditorBotName = r.bot.name;
      updateEditorFileName();
      toast(`Updated "${r.bot.name}" in library.`, "success");
      logToConsole(`Library: updated "${r.bot.name}".`, "success");
      if (currentUser && currentEditorRemoteBotId) {
        try {
          await ApiClient.createRemoteBotVersion({
            botId: currentEditorRemoteBotId,
            sourceCode: source,
            versionLabel: `v${Date.now()}`,
          });
          logToConsole(`Cloud: pushed new version for "${r.bot.name}".`, "event");
        } catch (e) {
          logToConsole(`Cloud sync warning: ${e.message ?? String(e)}`, "warn");
        }
      }
    } else {
      toast(`Validation failed: ${r.errors[0]}`, "error", 6000);
      logToConsole(`Library save failed: ${r.errors.join("; ")}`, "error");
    }
    return;
  }

  const r = BotLibrary.addBot(source);
  if (r.ok) {
    currentEditorUserBotId = r.bot.id;
    currentEditorBotName = r.bot.name;
    currentPreset = r.bot.id;
    updateEditorFileName();
    toast(`Saved "${r.bot.name}" to library.`, "success");
    logToConsole(`Library: saved "${r.bot.name}" (${r.bot.class}).`, "success");
    Achievements.fact("bot_saved", { count: BotLibrary.getAll().length });
    if (currentUser) {
      try {
        const created = await ApiClient.createRemoteBot({
          name: r.bot.name,
          sourceCode: source,
          versionLabel: "v1",
        });
        if (created?.bot?.id) {
          currentEditorRemoteBotId = created.bot.id;
          rememberRemoteMapping(created.bot.id, r.bot.id);
        }
        logToConsole(`Cloud: saved "${r.bot.name}" to account.`, "event");
      } catch (e) {
        logToConsole(`Cloud sync warning: ${e.message ?? String(e)}`, "warn");
      }
    }
    if (r.warnings?.length) {
      logToConsole(`Warnings: ${r.warnings.join("; ")}`, "warn");
    }
  } else {
    toast(`Validation failed: ${r.errors[0]}`, "error", 6000);
    logToConsole(`Library save failed: ${r.errors.join("; ")}`, "error");
  }
});

// ============================================================================
// Library View — render user-bot grid & upload handling
// ============================================================================

const libraryGridEl = document.getElementById("library-grid");
const libraryEmptyEl = document.getElementById("library-empty");
const libraryDropzoneEl = document.getElementById("library-dropzone");
const libraryFileInput = document.getElementById("library-file-input");
const libraryUploadResultsEl = document.getElementById("library-upload-results");
const librarySearchEl = document.getElementById("library-search");
const libraryFilterClassEl = document.getElementById("library-filter-class");
const tabCountLibraryEl = document.getElementById("tab-count-library");
const sidebarUserBotsEl = document.getElementById("sidebar-user-bots");

function formatDate(ts) {
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch { return ""; }
}

function filterLibrary(bots) {
  const q = (librarySearchEl?.value || "").trim().toLowerCase();
  const cls = libraryFilterClassEl?.value || "";
  return bots.filter((b) => {
    if (cls && b.class !== cls) return false;
    if (q) {
      const hay = `${b.name} ${b.author ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function classIconLetter(cls) {
  return { brawler: "B", ranger: "R", tank: "T", support: "S" }[cls] ?? "?";
}

// ---------------------------------------------------------------------------
// Community / sharing — visibility cache keyed by remote bot id
// ---------------------------------------------------------------------------

const VISIBILITY_CACHE_KEY = "arenascript.remote.visibility";

function getVisibilityCache() {
  try {
    const raw = localStorage.getItem(VISIBILITY_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function setVisibilityCacheEntry(remoteId, visibility) {
  if (!remoteId) return;
  const cache = getVisibilityCache();
  if (visibility) cache[remoteId] = visibility;
  else delete cache[remoteId];
  localStorage.setItem(VISIBILITY_CACHE_KEY, JSON.stringify(cache));
}

/** Find the remoteId for a local bot id, scanning the remote→local map. */
function findRemoteIdForLocal(localId) {
  if (!localId) return null;
  const map = getRemoteBotMap();
  for (const [remoteId, mappedLocal] of Object.entries(map)) {
    if (mappedLocal === localId) return remoteId;
  }
  return null;
}

/** Pull the latest visibility for every remote bot the user owns into the cache. */
async function refreshVisibilityCache() {
  if (!currentUser) return;
  try {
    const { bots } = await ApiClient.listRemoteBots();
    for (const rb of bots ?? []) {
      if (rb?.id && rb?.visibility) setVisibilityCacheEntry(rb.id, rb.visibility);
    }
  } catch {
    // Non-fatal — the UI just won't show share state until next sync.
  }
}

async function toggleBotShared(localBot) {
  if (!currentUser) {
    toast("Sign in to share your bot.", "warn");
    return;
  }
  let remoteId = findRemoteIdForLocal(localBot.id);

  // First-time share: upload to cloud, then set public.
  if (!remoteId) {
    try {
      const created = await ApiClient.createRemoteBot({
        name: localBot.name,
        sourceCode: localBot.source,
        visibility: "public",
      });
      remoteId = created?.bot?.id;
      if (remoteId) {
        rememberRemoteMapping(remoteId, localBot.id);
        setVisibilityCacheEntry(remoteId, "public");
        toast(`"${localBot.name}" shared to community.`, "success");
        renderLibrary();
        Achievements.fact("bot_shared");
      } else {
        toast("Couldn't share bot (no id returned).", "error");
      }
    } catch (e) {
      toast(`Share failed: ${e.message ?? String(e)}`, "error");
    }
    return;
  }

  const cache = getVisibilityCache();
  const current = cache[remoteId] || "private";
  const next = current === "public" ? "private" : "public";
  try {
    await ApiClient.setBotVisibility({ id: remoteId, visibility: next });
    setVisibilityCacheEntry(remoteId, next);
    toast(next === "public"
      ? `"${localBot.name}" is now public.`
      : `"${localBot.name}" is now private.`, "success");
    renderLibrary();
    if (next === "public") Achievements.fact("bot_shared");
  } catch (e) {
    toast(`Couldn't change visibility: ${e.message ?? String(e)}`, "error");
  }
}

function botSharedState(localBot) {
  const remoteId = findRemoteIdForLocal(localBot.id);
  if (!remoteId) return { remoteId: null, visibility: null };
  const cache = getVisibilityCache();
  return { remoteId, visibility: cache[remoteId] || null };
}

// ---------------------------------------------------------------------------
// Community view
// ---------------------------------------------------------------------------

const communityGridEl = document.getElementById("community-grid");
const communityEmptyEl = document.getElementById("community-empty");
const communityCountEl = document.getElementById("community-count");
const communityBannerEl = document.getElementById("community-banner");
const communitySearchEl = document.getElementById("community-search");
const communityClassEl = document.getElementById("community-class");
const communitySortEl = document.getElementById("community-sort");

let _communityCache = null;       // Last server response
let _communityRequest = 0;        // Race-prevention token

/** Extract the bot class from a stored source string (regex-based). */
function classFromSource(src) {
  const m = String(src ?? "").match(/\bclass\s*:\s*"([^"]+)"/);
  if (!m) return "brawler";
  const c = m[1].trim().toLowerCase();
  return ["brawler", "ranger", "tank", "support"].includes(c) ? c : "brawler";
}

function applyCommunityClientFilter(bots) {
  const cls = communityClassEl?.value || "";
  if (!cls) return bots;
  return bots.filter((b) => classFromSource(b.source_code) === cls);
}

async function renderCommunity() {
  if (!communityGridEl) return;

  const reqId = ++_communityRequest;
  communityGridEl.innerHTML = `<div class="community-loading">Loading community bots…</div>`;
  if (communityEmptyEl) communityEmptyEl.hidden = true;
  if (communityCountEl) communityCountEl.textContent = "—";
  if (communityBannerEl) {
    communityBannerEl.hidden = true;
    communityBannerEl.textContent = "";
  }

  let payload;
  try {
    payload = await ApiClient.listCommunityBots({
      q: communitySearchEl?.value?.trim() || "",
      sort: communitySortEl?.value || "recent",
      limit: 100,
    });
  } catch (e) {
    if (reqId !== _communityRequest) return;
    communityGridEl.innerHTML = "";
    if (communityBannerEl) {
      communityBannerEl.hidden = false;
      communityBannerEl.textContent = `Couldn't reach the community server (${e.message ?? "network error"}). Make sure the backend is configured.`;
    }
    return;
  }
  if (reqId !== _communityRequest) return;

  _communityCache = payload;
  const filtered = applyCommunityClientFilter(payload.bots ?? []);

  if (communityCountEl) {
    const total = payload.total ?? filtered.length;
    communityCountEl.textContent = `${filtered.length}${filtered.length !== total ? ` of ${total}` : ""} bot${total === 1 ? "" : "s"}`;
  }

  if (filtered.length === 0) {
    communityGridEl.innerHTML = "";
    if (communityEmptyEl) communityEmptyEl.hidden = false;
    return;
  }

  communityGridEl.innerHTML = "";
  for (const bot of filtered) {
    const cls = classFromSource(bot.source_code);
    const card = document.createElement("div");
    card.className = "bot-card community-card";
    card.dataset.id = bot.id;
    card.innerHTML = `
      <div class="bot-card-header">
        <div class="bot-class-icon ${cls}">${classIconLetter(cls)}</div>
        <div class="bot-card-title">
          <div class="bot-card-name" title="${escapeHtml(bot.name)}">${escapeHtml(bot.name)}</div>
          <div class="bot-card-meta">${cls} • by @${escapeHtml(bot.author_username || "anon")}</div>
        </div>
        <span class="community-pill">PUBLIC</span>
      </div>
      <div class="community-stats">${renderStatBars(cls)}</div>
      <div class="bot-card-source"><code>${escapeHtml(String(bot.source_code || "").split("\n").slice(0, 5).join("\n"))}</code></div>
      <div class="bot-card-footer">
        <span class="bot-card-date">${formatDate(bot.updated_at || bot.created_at)}</span>
        <div class="bot-card-actions">
          <button class="bc-btn bc-btn-primary" data-act="install" title="Save a copy to your library">Install</button>
          <button class="bc-btn" data-act="preview" title="Open in editor (read-only paste)">View</button>
        </div>
      </div>`;

    card.querySelector('[data-act="install"]').addEventListener("click", () => {
      const src = bot.source_code;
      if (!src) {
        toast("No source code on this entry.", "error");
        return;
      }
      const overrideName = `${bot.name} (by @${bot.author_username || "anon"})`;
      const r = BotLibrary.addBot(src, { overrideName });
      if (r.ok) {
        toast(`Installed "${bot.name}" to your library.`, "success");
        Achievements.fact("bot_installed");
      } else {
        toast(`Couldn't install: ${(r.errors || []).join(", ") || "unknown error"}`, "error");
      }
    });
    card.querySelector('[data-act="preview"]').addEventListener("click", () => {
      if (editorEl && bot.source_code) {
        editorEl.value = bot.source_code;
        currentEditorBotName = bot.name || "Community Bot";
        compiledPlayer = null;
        if (btnRun) btnRun.disabled = true;
        updateHighlighting?.();
        updateLineNumbers?.();
        setView("builder");
        toast(`Previewing "${bot.name}" in editor.`, "info");
      }
    });

    communityGridEl.appendChild(card);
  }
}

communitySearchEl?.addEventListener("input", () => {
  clearTimeout(communitySearchEl._t);
  communitySearchEl._t = setTimeout(renderCommunity, 250);
});
communitySortEl?.addEventListener("change", renderCommunity);
communityClassEl?.addEventListener("change", renderCommunity);
document.getElementById("btn-community-refresh")?.addEventListener("click", renderCommunity);

function renderLibrary() {
  if (!libraryGridEl) return;
  const all = BotLibrary.getAll();
  const bots = filterLibrary(all);

  libraryGridEl.innerHTML = "";

  if (all.length === 0) {
    libraryEmptyEl.hidden = false;
    libraryGridEl.hidden = true;
    return;
  }
  libraryEmptyEl.hidden = true;
  libraryGridEl.hidden = false;

  if (bots.length === 0) {
    libraryGridEl.innerHTML = `<div class="library-no-match">No bots match the current filter.</div>`;
    return;
  }

  for (const bot of bots) {
    const card = document.createElement("div");
    card.className = "bot-card";
    card.dataset.id = bot.id;
    const shared = botSharedState(bot);
    const sharedPill = shared.visibility === "public"
      ? `<span class="community-pill" title="Visible to all players in the Community list">PUBLIC</span>`
      : "";
    const shareLabel = shared.visibility === "public" ? "Unshare" : "Share";
    const shareTitle = !currentUser
      ? "Sign in to share bots with the community"
      : shared.visibility === "public"
      ? "Hide this bot from the community list"
      : "Publish this bot to the community list";
    card.innerHTML = `
      <div class="bot-card-header">
        <div class="bot-class-icon ${bot.class}">${classIconLetter(bot.class)}</div>
        <div class="bot-card-title">
          <div class="bot-card-name" title="${escapeHtml(bot.name)}">${escapeHtml(bot.name)}</div>
          <div class="bot-card-meta">${bot.class}${bot.author ? " • " + escapeHtml(bot.author) : ""}</div>
        </div>
        ${sharedPill}
      </div>
      <div class="bot-card-source"><code>${escapeHtml(bot.source.split("\n").slice(0, 5).join("\n"))}</code></div>
      <div class="bot-card-footer">
        <span class="bot-card-date">${formatDate(bot.updatedAt || bot.createdAt)}</span>
        <div class="bot-card-actions">
          <button class="bc-btn" data-act="edit"   title="Load in Builder">Edit</button>
          <button class="bc-btn" data-act="battle" title="Use as your bot in Arena">Battle</button>
          <button class="bc-btn" data-act="opponent" title="Set as opponent">Opp</button>
          <button class="bc-btn bc-btn-share" data-act="share" title="${escapeHtml(shareTitle)}" ${currentUser ? "" : "disabled"}>${shareLabel}</button>
          <button class="bc-btn" data-act="export" title="Download .arena">Export</button>
          <button class="bc-btn bc-btn-danger" data-act="delete" title="Delete">&times;</button>
        </div>
      </div>`;

    card.querySelector('[data-act="edit"]').addEventListener("click", () => {
      loadPreset(bot.id);
      setView("builder");
      toast(`Loaded "${bot.name}" into editor.`, "info");
    });
    card.querySelector('[data-act="battle"]').addEventListener("click", () => {
      loadPreset(bot.id);
      if (doCompile()) {
        setView("arena");
        toast(`"${bot.name}" compiled. Ready to battle.`, "success");
      }
    });
    card.querySelector('[data-act="opponent"]').addEventListener("click", () => {
      refreshOpponentSelect();
      opponentSelect.value = bot.id;
      setView("arena");
      toast(`"${bot.name}" set as opponent.`, "info");
    });
    card.querySelector('[data-act="share"]').addEventListener("click", () => {
      toggleBotShared(bot);
    });
    card.querySelector('[data-act="export"]').addEventListener("click", () => {
      BotLibrary.exportBot(bot.id);
    });
    card.querySelector('[data-act="delete"]').addEventListener("click", () => {
      if (confirm(`Delete "${bot.name}"? This cannot be undone.`)) {
        BotLibrary.deleteBot(bot.id);
        toast(`Deleted "${bot.name}".`, "info");
      }
    });

    libraryGridEl.appendChild(card);
  }
}

function renderSidebarUserBots() {
  if (!sidebarUserBotsEl) return;
  const bots = BotLibrary.getAll();
  if (tabCountLibraryEl) tabCountLibraryEl.textContent = String(bots.length);

  if (bots.length === 0) {
    sidebarUserBotsEl.innerHTML = `<div class="sidebar-empty-hint">No saved bots yet. Write code in the editor and click <b>Save to Library</b>, or upload a <code>.arena</code> file from the My Bots tab.</div>`;
    return;
  }

  sidebarUserBotsEl.innerHTML = "";
  for (const bot of bots) {
    const el = document.createElement("button");
    el.className = "bot-preset sidebar-user-bot";
    if (bot.id === currentPreset) el.classList.add("active");
    el.dataset.bot = bot.id;
    el.title = `${bot.name} — ${bot.class}`;
    el.innerHTML = `
      <div class="bot-class-icon ${bot.class}">${classIconLetter(bot.class)}</div>
      <div class="bot-preset-info">
        <span class="bot-preset-name">${escapeHtml(bot.name)}</span>
        <span class="bot-preset-class">${bot.class}</span>
      </div>`;
    el.addEventListener("click", () => loadPreset(bot.id));
    sidebarUserBotsEl.appendChild(el);
  }
}

async function handleFileUpload(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  libraryUploadResultsEl.hidden = false;
  libraryUploadResultsEl.innerHTML = `<div class="upload-status">Validating ${files.length} file${files.length > 1 ? "s" : ""}…</div>`;

  const results = await BotLibrary.importFiles(files);

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;

  const parts = [
    `<div class="upload-summary">`,
    `<span class="upload-ok">${okCount} saved</span>`,
    failCount ? `<span class="upload-fail">${failCount} rejected</span>` : "",
    `<button class="upload-dismiss" id="btn-dismiss-upload">Dismiss</button>`,
    `</div>`,
  ];

  for (const r of results) {
    if (r.ok) {
      parts.push(`<div class="upload-row ok"><b>&#10004; ${escapeHtml(r.file)}</b> → "${escapeHtml(r.bot.name)}" (${r.bot.class})</div>`);
    } else {
      parts.push(`<div class="upload-row fail"><b>&#10008; ${escapeHtml(r.file)}</b><div class="upload-errors">${r.errors.map(escapeHtml).join("<br>")}</div></div>`);
    }
  }

  libraryUploadResultsEl.innerHTML = parts.join("");
  document.getElementById("btn-dismiss-upload")?.addEventListener("click", () => {
    libraryUploadResultsEl.hidden = true;
    libraryUploadResultsEl.innerHTML = "";
  });

  if (okCount > 0) {
    toast(`Imported ${okCount} bot${okCount > 1 ? "s" : ""}.`, "success");
  }
  if (failCount > 0 && okCount === 0) {
    toast(`${failCount} file${failCount > 1 ? "s" : ""} failed validation.`, "error", 5000);
  }
}

// Upload buttons
document.getElementById("btn-library-upload")?.addEventListener("click", () => libraryFileInput?.click());
document.getElementById("btn-library-upload-top")?.addEventListener("click", () => libraryFileInput?.click());
libraryFileInput?.addEventListener("change", (e) => {
  handleFileUpload(e.target.files);
  e.target.value = ""; // allow re-uploading the same file
});

// New empty bot (builder)
function newEmptyBot() {
  const template =
`robot "New Bot" version "1.0"

meta {
  author: "You"
  class: "brawler"
}

on spawn {
}

on tick {
  let enemy = nearest_enemy()
  if enemy != null {
    attack enemy
  }
}
`;
  editorEl.value = template;
  currentEditorBotName = "New Bot";
  currentEditorUserBotId = null;
  currentEditorRemoteBotId = null;
  currentPreset = "";
  presetButtons.forEach((btn) => btn.classList.remove("active"));
  document.querySelectorAll(".sidebar-user-bot").forEach((el) => el.classList.remove("active"));
  compiledPlayer = null;
  btnRun.disabled = true;
  clearErrors();
  updateHighlighting();
  updateLineNumbers();
  updateEditorFileName();
  updateArenaLoadedBotLabel();
  setView("builder");
  editorEl.focus();
}
document.getElementById("btn-library-new")?.addEventListener("click", newEmptyBot);
document.getElementById("btn-sidebar-new-bot")?.addEventListener("click", newEmptyBot);

// Drag & drop on library dropzone
if (libraryDropzoneEl) {
  ["dragenter", "dragover"].forEach((ev) => {
    libraryDropzoneEl.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      libraryDropzoneEl.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    libraryDropzoneEl.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      libraryDropzoneEl.classList.remove("dragover");
    });
  });
  libraryDropzoneEl.addEventListener("drop", (e) => {
    const files = e.dataTransfer?.files;
    if (files?.length) handleFileUpload(files);
  });
  libraryDropzoneEl.addEventListener("click", () => libraryFileInput?.click());
}

// Library filters
librarySearchEl?.addEventListener("input", renderLibrary);
libraryFilterClassEl?.addEventListener("change", renderLibrary);

// Arena sidebar "Run Match" button (duplicates btn-run but always available)
document.getElementById("btn-arena-run")?.addEventListener("click", () => {
  if (!compiledPlayer) {
    if (!doCompile()) {
      toast("Fix compile errors in Builder first.", "error");
      setView("builder");
      return;
    }
  }
  doRunMatch();
});

// React to any library change: refresh dependent UI
BotLibrary.subscribe(() => {
  renderSidebarUserBots();
  refreshOpponentSelect();
  if (currentView === "library") renderLibrary();
});

// ============================================================================
// Match history panel (local, stored in localStorage via ui/enhanced.js)
// ============================================================================

function refreshMatchHistoryPanel() {
  const listEl = document.getElementById("match-history-list");
  if (!listEl) return;
  const history = getMatchHistory();
  listEl.innerHTML = "";
  if (history.length === 0) {
    listEl.innerHTML = `<div class="match-history-empty">No matches yet — run one in the Arena and it'll appear here.</div>`;
    return;
  }
  for (const entry of history) {
    const row = document.createElement("div");
    row.className = "match-history-entry";
    const resultClass =
      entry.winnerTeam === null ? "draw" : entry.youWon ? "win" : "loss";
    const resultLabel =
      entry.winnerTeam === null ? "DRAW" : entry.youWon ? "WIN" : "LOSS";
    const ago = formatRelative(entry.ts);
    row.innerHTML = `
      <span class="match-history-result ${resultClass}">${resultLabel}</span>
      <span class="match-history-detail">${escapeHtml(entry.you)} <span style="color:var(--text-muted)">vs</span> ${escapeHtml(entry.opponent)}</span>
      <span class="match-history-meta">${escapeHtml(entry.arena ?? "")} · seed ${escapeHtml(String(entry.seed))}</span>
      <span class="match-history-meta">${ago}</span>`;
    listEl.appendChild(row);
  }
}

function formatRelative(ts) {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

document.getElementById("btn-match-history-clear")?.addEventListener("click", () => {
  if (!confirm("Clear local match history?")) return;
  clearMatchHistory();
  refreshMatchHistoryPanel();
});

// ============================================================================
// Install enhanced UI (command palette + shortcut help + language reference)
// ============================================================================

installShortcutHelp();
installLangReference();
installEditorAutocomplete(editorEl, () => {
  // Re-run syntax highlight + diagnostic rebuild after a completion accept
  // so the inserted text is styled immediately.
  onEditorInput();
});
installOnboarding({
  loadBot: (key) => {
    loadPreset(key);
    setView("builder");
  },
});

// If the page was opened with a #match=asv1:... hash, try to rehydrate the
// shared match so the opener can reproduce it with one click. Runs after
// other UI is wired so toast() and editor state are ready. The boolean
// return is consulted later in bootstrap so the default preset load
// doesn't clobber the restored editor source.
const sharedMatchRestored = tryRestoreSharedMatch();

installCommandPalette(() => {
  // Build the command list dynamically so newly saved user bots, current
  // view state, etc. are reflected each time the palette opens.
  const cmds = [];
  cmds.push({
    kind: "action", icon: "▶",
    label: "Compile current program",
    hint: "Ctrl+Enter",
    keywords: ["build"],
    run: () => doCompile(),
  });
  cmds.push({
    kind: "action", icon: "⚔",
    label: "Compile and run match",
    hint: "Ctrl+Shift+Enter",
    keywords: ["battle", "fight"],
    run: () => doCompileAndRun(),
  });
  cmds.push({
    kind: "action", icon: "💾",
    label: "Save current editor program to library",
    keywords: ["save"],
    run: () => document.getElementById("btn-save-library")?.click(),
  });
  cmds.push({
    kind: "action", icon: "🔗",
    label: "Share last match (copy link to clipboard)",
    hint: lastMatchBundle ? `seed ${lastMatchBundle.seed}` : "run a match first",
    keywords: ["share", "copy", "replay", "link", "export"],
    run: () => doShareMatch(),
  });
  cmds.push({
    kind: "match", icon: "🏆",
    label: "Run gauntlet against preset slate",
    hint: "your bot vs N opponents",
    keywords: ["gauntlet", "benchmark", "winrate", "test"],
    run: () => doRunGauntlet(),
  });
  cmds.push({
    kind: "action", icon: "🗑",
    label: "Clear console",
    keywords: ["log", "output"],
    run: () => clearConsole(),
  });
  for (const view of ["builder", "arena", "library"]) {
    cmds.push({
      kind: "action", icon: "→",
      label: `Switch to ${view.charAt(0).toUpperCase() + view.slice(1)} view`,
      keywords: ["view", "tab", "go"],
      run: () => setView(view),
    });
  }
  cmds.push({
    kind: "doc", icon: "📖",
    label: "Open language reference",
    hint: "Ctrl+/",
    keywords: ["docs", "help", "sensor", "syntax"],
    run: () => document.getElementById("btn-open-lang-ref")?.click(),
  });
  cmds.push({
    kind: "doc", icon: "?",
    label: "Show keyboard shortcuts",
    hint: "Shift+?",
    keywords: ["help", "keys"],
    run: () => document.getElementById("btn-show-help")?.click(),
  });

  // Preset bots — load into editor
  for (const [key, preset] of Object.entries(BOT_PRESETS)) {
    cmds.push({
      kind: "bot", icon: classIconLetter(preset.class) ?? "B",
      label: `Load preset: ${preset.name}`,
      hint: preset.class,
      keywords: ["preset", preset.class, preset.name.toLowerCase()],
      run: () => {
        loadPreset(key);
        setView("builder");
      },
    });
  }
  // User bots
  for (const bot of BotLibrary.getAll()) {
    cmds.push({
      kind: "bot", icon: classIconLetter(bot.class) ?? "•",
      label: `Load my bot: ${bot.name}`,
      hint: bot.class,
      keywords: ["mine", "my", bot.class, bot.name.toLowerCase()],
      run: () => {
        loadPreset(bot.id);
        setView("builder");
      },
    });
  }
  // Match actions
  cmds.push({
    kind: "match", icon: "⚑",
    label: "Open team builder",
    run: () => document.getElementById("btn-open-team-builder")?.click(),
  });
  cmds.push({
    kind: "match", icon: "↺",
    label: "Run match with random seed",
    run: () => {
      if (seedInput) seedInput.value = "";
      setView("arena");
      doRunMatch();
    },
  });
  return cmds;
});

// ============================================================================
// SFX toggle wiring
// ============================================================================

const btnSfxToggle = document.getElementById("btn-sfx-toggle");

function updateSfxButton() {
  if (!btnSfxToggle) return;
  const on = SFX.isEnabled();
  btnSfxToggle.classList.toggle("sfx-muted", !on);
  const icon = btnSfxToggle.querySelector(".sfx-icon");
  if (icon) icon.textContent = on ? "🔊" : "🔇";
  btnSfxToggle.title = on ? "Mute sound effects" : "Unmute sound effects";
}

btnSfxToggle?.addEventListener("click", () => {
  SFX.setEnabled(!SFX.isEnabled());
  updateSfxButton();
  if (SFX.isEnabled()) SFX.playClick();
});

updateSfxButton();

// ============================================================================
// Daily Challenge
// ============================================================================
//
// Deterministic-per-day opponent + arena + seed. Encourages daily return
// visits without any backend dependency — the challenge is purely a function
// of today's date, the best-time leaderboard lives in localStorage.

const DC_STORAGE_KEY = "arenascript.daily.v1";
const dcEl = document.getElementById("daily-challenge");
const dcDateEl = document.getElementById("dc-date");
const dcTitleEl = document.getElementById("dc-title");
const dcMetaEl = document.getElementById("dc-meta");
const dcBestEl = document.getElementById("dc-best");
const dcRunBtn = document.getElementById("btn-dc-run");

function dcTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dcDayIndex() {
  // Days since a fixed epoch — used to deterministically pick today's matchup.
  const d = new Date();
  const utc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor(utc / 86400000);
}

function dcGetState() {
  try {
    const raw = localStorage.getItem(DC_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function dcRecordResult(dayKey, tickCount, won) {
  const state = dcGetState();
  const entry = state[dayKey] || { attempts: 0, bestTicks: null, won: false };
  entry.attempts++;
  if (won && (entry.bestTicks === null || tickCount < entry.bestTicks)) {
    entry.bestTicks = tickCount;
    entry.won = true;
  }
  state[dayKey] = entry;
  try { localStorage.setItem(DC_STORAGE_KEY, JSON.stringify(state)); } catch {}
}

const DC_OPPONENT_POOL = [
  "kiter", "fortress", "flanker", "sentinel", "hivemind",
  "phantom", "warden", "overclock", "oracle", "zealot", "predator",
];

function dcTodayConfig() {
  const idx = dcDayIndex();
  const oppKey = DC_OPPONENT_POOL[idx % DC_OPPONENT_POOL.length];
  const arenaList = ARENA_PRESET_ORDER.filter((a) => a !== "nexus");
  const arenaId = arenaList[idx % arenaList.length];
  // Seed is bounded by the engine PRNG range; a day-derived stable seed.
  const seed = (idx * 2654435761) % 2_147_483_646;
  return { oppKey, arenaId, seed, dayKey: dcTodayKey() };
}

function dcFormatTicks(ticks) {
  if (ticks == null) return "—";
  const seconds = ticks / 30; // engine runs at 30 ticks/sec
  return `${seconds.toFixed(1)}s`;
}

function dcRender() {
  if (!dcEl) return;
  const cfg = dcTodayConfig();
  const opp = getBotEntry(cfg.oppKey);
  const arena = getArenaPreset(cfg.arenaId);
  if (!opp || !arena) { dcEl.hidden = true; return; }

  dcEl.hidden = false;
  if (dcDateEl) {
    const d = new Date();
    dcDateEl.textContent = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  if (dcTitleEl) dcTitleEl.textContent = `Beat ${opp.name}`;
  if (dcMetaEl) dcMetaEl.textContent = `${arena.name} · 1v1 · fixed seed`;

  const state = dcGetState()[cfg.dayKey];
  if (dcBestEl) {
    if (!state || !state.won) {
      dcBestEl.classList.add("dc-best-none");
      dcBestEl.textContent = state ? `${state.attempts} attempt${state.attempts === 1 ? "" : "s"}` : "No attempts yet";
    } else {
      dcBestEl.classList.remove("dc-best-none");
      dcBestEl.textContent = `Best: ${dcFormatTicks(state.bestTicks)}`;
    }
  }
}

async function dcRun() {
  const cfg = dcTodayConfig();
  // Make sure the editor bot is compiled; if it isn't, run a fresh compile.
  if (!compiledPlayer && !doCompile()) {
    toast("Compile your bot first.", "warn");
    return;
  }
  // Set arena + seed in the match controls so a follow-up "Run" reproduces.
  if (arenaSelect && [...arenaSelect.options].some(o => o.value === cfg.arenaId)) {
    arenaSelect.value = cfg.arenaId;
    currentArenaId = cfg.arenaId;
    updateArenaInfo();
  }
  if (matchModeSelect) matchModeSelect.value = "duel_1v1";
  if (seedInput) seedInput.value = String(cfg.seed);
  if (opponentSelect) {
    refreshOpponentSelect();
    opponentSelect.value = cfg.oppKey;
  }

  setView("arena");
  await nextFrame();
  await doRunMatch();

  // Record the outcome — assumes lastMatchResult is populated after doRunMatch.
  if (lastMatchResult) {
    const playerWon = lastMatchResult.winner === 0;
    const isDraw = lastMatchResult.winner === null;
    dcRecordResult(cfg.dayKey, lastMatchResult.tickCount, playerWon);
    dcRender();
    // doRunMatch already records per-opponent stats; the Daily Challenge
    // counts as a notable head-to-head, so we don't double-record here.
    if (playerWon) {
      toast(`Daily Challenge: WON in ${dcFormatTicks(lastMatchResult.tickCount)}`, "success");
      Achievements.fact("daily_won", { durationTicks: lastMatchResult.tickCount });
    } else if (!isDraw) {
      toast(`Daily Challenge: try again — that was attempt #${(dcGetState()[cfg.dayKey]?.attempts) || 1}`, "info");
    }
  }
}

dcRunBtn?.addEventListener("click", dcRun);
dcRender();

// ============================================================================
// Achievements wiring
// ============================================================================

const achievementsModal = document.getElementById("achievements-modal");
const btnAchievements = document.getElementById("btn-achievements");
const btnCloseAchievements = document.getElementById("btn-close-achievements");
const achPillEl = document.getElementById("ach-pill");
const achGridEl = document.getElementById("ach-grid");
const achStatUnlocked = document.getElementById("ach-stat-unlocked");
const achStatWins = document.getElementById("ach-stat-wins");
const achStatPlayed = document.getElementById("ach-stat-played");
const achStatStreak = document.getElementById("ach-stat-streak");
const achUnlockToast = document.getElementById("ach-unlock-toast");
const achUnlockIcon = document.getElementById("ach-unlock-icon");
const achUnlockTitle = document.getElementById("ach-unlock-title");
const achUnlockDesc = document.getElementById("ach-unlock-desc");

function updateAchievementsPill() {
  if (!achPillEl) return;
  const s = Achievements.summary();
  achPillEl.textContent = `${s.unlocked}/${s.total}`;
  achPillEl.classList.toggle("ach-pill-full", s.unlocked === s.total && s.total > 0);
}

function renderAchievementsModal() {
  if (!achGridEl) return;
  const state = Achievements.getState();
  achStatUnlocked.textContent = String(Object.keys(state.unlocked).length);
  achStatWins.textContent = String(state.matchesWon || 0);
  achStatPlayed.textContent = String(state.matchesPlayed || 0);
  achStatStreak.textContent = String(state.currentStreak || 0);

  achGridEl.innerHTML = "";
  for (const ach of Achievements.getAchievements()) {
    const unlocked = !!state.unlocked[ach.id];
    const prog = Achievements.progressFor(ach.id);
    const showBar = ach.target && ach.target > 1;
    const card = document.createElement("div");
    card.className = `ach-card ${unlocked ? "unlocked" : "locked"}`;
    card.innerHTML = `
      <div class="ach-card-icon">${ach.icon}</div>
      <div class="ach-card-body">
        <div class="ach-card-title">${escapeHtml(ach.title)}</div>
        <div class="ach-card-desc">${escapeHtml(ach.desc)}</div>
        ${showBar ? `
          <div class="ach-card-progress">
            <div class="ach-progress-bar"><div class="ach-progress-fill" style="width:${prog.percent}%"></div></div>
            <div class="ach-progress-text">${prog.current}/${prog.target}</div>
          </div>` : ""}
      </div>`;
    achGridEl.appendChild(card);
  }
}

function openAchievementsModal() {
  if (!achievementsModal) return;
  renderAchievementsModal();
  achievementsModal.hidden = false;
}

function closeAchievementsModal() {
  if (achievementsModal) achievementsModal.hidden = true;
}

let _achToastQueue = [];
let _achToastShowing = false;

function showAchievementToast(def) {
  if (!achUnlockToast) return;
  _achToastQueue.push(def);
  drainAchToastQueue();
}

function drainAchToastQueue() {
  if (_achToastShowing || _achToastQueue.length === 0) return;
  const def = _achToastQueue.shift();
  _achToastShowing = true;
  achUnlockIcon.textContent = def.icon || "🏆";
  achUnlockTitle.textContent = def.title || "Unlocked";
  achUnlockDesc.textContent = def.desc || "";
  achUnlockToast.classList.remove("leaving");
  achUnlockToast.hidden = false;
  // Use the SFX victory cue — short fanfare, fits perfectly.
  SFX.playVictory();
  setTimeout(() => {
    achUnlockToast.classList.add("leaving");
    setTimeout(() => {
      achUnlockToast.hidden = true;
      _achToastShowing = false;
      drainAchToastQueue();
    }, 400);
  }, 4200);
}

document.addEventListener("achievement-unlocked", (e) => {
  showAchievementToast(e.detail);
  updateAchievementsPill();
  if (achievementsModal && !achievementsModal.hidden) renderAchievementsModal();
});

Achievements.subscribe(() => updateAchievementsPill());

btnAchievements?.addEventListener("click", openAchievementsModal);
btnCloseAchievements?.addEventListener("click", closeAchievementsModal);
achievementsModal?.addEventListener("click", (e) => {
  if (e.target === achievementsModal) closeAchievementsModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && achievementsModal && !achievementsModal.hidden) closeAchievementsModal();
});

updateAchievementsPill();

/**
 * Inspect a finished match result + replay and emit a `match_ended` fact.
 * Used by every code path that finishes a match.
 */
function recordMatchAchievements(result) {
  if (!result) return;
  const playerWon = result.winner === 0;
  const ffa = !!result.ffa || (result.metadata && result.metadata.mode === "battle_royale");
  // Per-team-max — the largest team size, used by Squad Leader.
  let perTeamMax = 1;
  const teams = new Map();
  for (const p of result.replay?.metadata?.participants ?? []) {
    teams.set(p.teamId, (teams.get(p.teamId) || 0) + 1);
  }
  for (const v of teams.values()) perTeamMax = Math.max(perTeamMax, v);

  // Damage taken by the player robot (id "player") — scan replay events.
  let damageTaken = 0;
  for (const frame of result.replay?.frames ?? []) {
    for (const e of frame.events || []) {
      if (e.type === "damaged" && e.robotId === "player") damageTaken += e.data?.damage ?? 0;
    }
  }

  // Player robot class — from the participant matching playerId "player".
  let robotClass = null;
  for (const p of result.replay?.metadata?.participants ?? []) {
    if (p.playerId === "player") {
      robotClass = p.program?.robotClass || p.robotClass || null;
      break;
    }
  }

  Achievements.fact("match_ended", {
    won: playerWon,
    ffa,
    perTeamMax,
    durationTicks: result.tickCount ?? 0,
    damageTaken,
    robotClass,
  });
}

// ============================================================================
// Tournament — single-elimination bracket runner
// ============================================================================

const tournEmptyEl = document.getElementById("tourn-empty");
const tournRosterEl = document.getElementById("tourn-roster");
const tournRosterGridEl = document.getElementById("tourn-roster-grid");
const tournRosterCountEl = document.getElementById("tourn-roster-count");
const tournBracketEl = document.getElementById("tourn-bracket");
const tournWinnerEl = document.getElementById("tourn-winner");
const tournStatusEl = document.getElementById("tourn-status");
const tournSizeEl = document.getElementById("tourn-size");
const tournArenaEl = document.getElementById("tourn-arena");
const tournSeedEl = document.getElementById("tourn-seed");
const btnTournRun = document.getElementById("btn-tourn-run");
const btnTournClear = document.getElementById("btn-tourn-clear");
const btnTournPick = document.getElementById("btn-tourn-pick");
const btnTournAutofill = document.getElementById("btn-tourn-autofill");
const btnTournNew = document.getElementById("btn-tourn-new");

let _tournRoster = [];           // [{ key, name, class, isYou }]
let _tournBracket = null;        // { rounds: [{ matches: [{ a, b, winner, result, completed }] }] }
let _tournRunning = false;
let _tournViewInited = false;

function initTournamentView() {
  if (!_tournViewInited) {
    // Populate the arena <select> the first time the view opens.
    if (tournArenaEl) {
      tournArenaEl.innerHTML = ARENA_PRESET_ORDER
        .map((id) => `<option value="${id}">${escapeHtml(getArenaPreset(id).name)}</option>`)
        .join("");
    }
    _tournViewInited = true;
  }
  renderTournamentView();
}

function tournRosterCapacity() {
  return parseInt(tournSizeEl?.value || "8", 10);
}

/**
 * Canonical single-elimination seed order for n participants. Pairing
 * consecutive entries gives the standard bracket (1 only meets 2 in the
 * final, etc.). e.g. n=8 -> [1, 8, 4, 5, 2, 7, 3, 6].
 */
function bracketSeedOrder(n) {
  if (n === 1) return [1];
  const half = bracketSeedOrder(n / 2);
  const out = [];
  for (const s of half) out.push(s, n + 1 - s);
  return out;
}

function tournUpdateRunBtn() {
  const cap = tournRosterCapacity();
  const enough = _tournRoster.length === cap;
  if (btnTournRun) {
    btnTournRun.disabled = !enough || _tournRunning;
    btnTournRun.textContent = enough ? "Run Tournament" : `Need ${cap - _tournRoster.length} more`;
  }
}

function renderTournamentView() {
  if (!tournRosterGridEl) return;
  const empty = _tournRoster.length === 0;
  if (tournEmptyEl) tournEmptyEl.hidden = !empty || !!_tournBracket;
  if (tournRosterEl) tournRosterEl.hidden = empty;
  if (tournRosterCountEl) tournRosterCountEl.textContent = `${_tournRoster.length}/${tournRosterCapacity()}`;

  tournRosterGridEl.innerHTML = "";
  _tournRoster.forEach((p, i) => {
    const card = document.createElement("div");
    card.className = "tourn-roster-card";
    card.innerHTML = `
      <span class="seed">#${i + 1}</span>
      <span class="icon ${escapeHtml(p.class)}">${escapeHtml(botIconLetter(p.key))}</span>
      <span class="name">${escapeHtml(p.name)}</span>
      ${p.isYou ? `<span class="you">YOU</span>` : ""}`;
    tournRosterGridEl.appendChild(card);
  });
  tournUpdateRunBtn();
  renderBracket();
}

function tournAddParticipant(key) {
  const cap = tournRosterCapacity();
  if (_tournRoster.length >= cap) return;
  const entry = getBotEntry(key);
  if (!entry) return;
  _tournRoster.push({
    key,
    name: entry.isEditor ? "Your Bot" : entry.name,
    class: entry.class,
    isYou: !!entry.isEditor,
  });
  renderTournamentView();
}

function tournClear() {
  _tournRoster = [];
  _tournBracket = null;
  if (tournWinnerEl) tournWinnerEl.hidden = true;
  if (tournStatusEl) tournStatusEl.textContent = "Idle";
  renderTournamentView();
}

function tournAutofill() {
  const cap = tournRosterCapacity();
  _tournRoster = [];
  // Always seed the player's editor bot at #1.
  _tournRoster.push({
    key: "__editor__",
    name: "Your Bot",
    class: compiledPlayer?.program?.robotClass || "brawler",
    isYou: true,
  });
  // Then varied presets from the pool.
  let i = 0;
  while (_tournRoster.length < cap && i < AUTOFILL_POOL.length * 2) {
    const key = AUTOFILL_POOL[i % AUTOFILL_POOL.length];
    if (!_tournRoster.some((p) => p.key === key)) {
      const entry = getBotEntry(key);
      if (entry) {
        _tournRoster.push({ key, name: entry.name, class: entry.class, isYou: false });
      }
    }
    i++;
  }
  renderTournamentView();
}

function tournPickParticipant() {
  const cap = tournRosterCapacity();
  if (_tournRoster.length >= cap) {
    toast("Roster is full. Clear or remove a bot first.", "warn");
    return;
  }
  openBotPicker({
    title: `Pick participant #${_tournRoster.length + 1}`,
    includeEditor: !_tournRoster.some((p) => p.isYou),
    onPick: (key) => {
      tournAddParticipant(key);
      // Keep picking until the bracket is full.
      if (_tournRoster.length < cap) setTimeout(tournPickParticipant, 80);
    },
  });
}

function renderBracket() {
  if (!tournBracketEl) return;
  if (!_tournBracket) {
    tournBracketEl.hidden = true;
    tournBracketEl.innerHTML = "";
    return;
  }
  tournBracketEl.hidden = false;

  const rounds = _tournBracket.rounds;
  // Use the planned total based on bracket size so labels stay correct even
  // before later rounds have been generated.
  const totalRounds = Math.log2(rounds[0].matches.length * 2);
  const labelFor = (rIdx) => {
    const remaining = Math.pow(2, totalRounds - rIdx);
    if (remaining === 2) return "Final";
    if (remaining === 4) return "Semifinal";
    if (remaining === 8) return "Quarterfinal";
    return `Round of ${remaining}`;
  };

  tournBracketEl.innerHTML = "";
  rounds.forEach((round, rIdx) => {
    const col = document.createElement("div");
    col.className = "tourn-round";
    col.innerHTML = `<div class="tourn-round-label">${labelFor(rIdx)}</div>`;
    round.matches.forEach((m, mIdx) => {
      const matchEl = document.createElement("div");
      matchEl.className = `tourn-match ${m.running ? "tm-running" : ""} ${m.completed ? "tm-complete" : ""}`;
      matchEl.dataset.r = String(rIdx);
      matchEl.dataset.m = String(mIdx);
      const slot = (p, isWinner, isLoser) => {
        if (!p) return `<div class="tm-slot tm-tbd"><span class="tm-seed">—</span><span class="tm-name" style="color:var(--text-muted);">TBD</span></div>`;
        const cls = isWinner ? "tm-winner" : isLoser ? "tm-loser" : "";
        return `
          <div class="tm-slot ${cls}">
            <span class="tm-seed">#${p.seed}</span>
            <span class="tm-icon ${escapeHtml(p.class)}">${escapeHtml(botIconLetter(p.key))}</span>
            <span class="tm-name">${escapeHtml(p.name)}${p.isYou ? `<span class="you-tag">YOU</span>` : ""}</span>
          </div>`;
      };
      const winnerSeat = m.winnerSeat; // "a" | "b" | null
      matchEl.innerHTML = `
        ${slot(m.a, winnerSeat === "a", winnerSeat === "b" && m.completed)}
        ${slot(m.b, winnerSeat === "b", winnerSeat === "a" && m.completed)}
        <div class="tm-meta">
          <span>${m.running ? "Running…" : m.completed ? `${m.tickCount} ticks` : "Awaiting"}</span>
          ${m.completed && m.result ? `<button class="tm-watch" data-r="${rIdx}" data-m="${mIdx}">Watch replay</button>` : ""}
        </div>`;
      col.appendChild(matchEl);
    });
    tournBracketEl.appendChild(col);
  });
}

tournBracketEl?.addEventListener("click", (e) => {
  const btn = e.target.closest(".tm-watch");
  if (!btn) return;
  const r = parseInt(btn.dataset.r, 10);
  const m = parseInt(btn.dataset.m, 10);
  const match = _tournBracket?.rounds?.[r]?.matches?.[m];
  if (!match?.result) return;
  // Reuse the existing arena flow: load the replay and switch to the arena view.
  lastMatchResult = match.result;
  setView("arena");
  startReplay(match.result, null);
});

/** Compile a roster entry into a {program, constants, playerId} participant. */
function tournBuildParticipant(p, teamId) {
  const entry = getBotEntry(p.key);
  if (!entry) throw new Error(`Unknown bot ${p.key}`);
  const r = compile(entry.source);
  if (!r.success) throw new Error(`${entry.name} failed to compile`);
  return {
    program: r.program,
    constants: r.constants,
    playerId: p.isYou ? "player" : p.name,
    teamId,
  };
}

async function runTournament() {
  if (_tournRunning) return;
  const cap = tournRosterCapacity();
  if (_tournRoster.length !== cap) { toast(`Need ${cap} participants.`, "warn"); return; }

  _tournRunning = true;
  if (btnTournRun) btnTournRun.disabled = true;
  if (tournWinnerEl) tournWinnerEl.hidden = true;
  if (tournStatusEl) tournStatusEl.textContent = "Seeding bracket…";

  // Validate & compile every entry up front so we fail fast.
  const compiled = [];
  for (let i = 0; i < _tournRoster.length; i++) {
    const p = _tournRoster[i];
    const entry = getBotEntry(p.key);
    if (!entry) {
      toast(`Unknown bot at seed #${i + 1}`, "error");
      _tournRunning = false;
      tournUpdateRunBtn();
      return;
    }
    const r = compile(entry.source);
    if (!r.success) {
      toast(`${entry.name} failed to compile: ${r.errors?.[0] ?? "unknown"}`, "error");
      _tournRunning = false;
      tournUpdateRunBtn();
      return;
    }
    compiled.push({ ...p, seed: i + 1, program: r.program, constants: r.constants });
  }

  // Build the bracket structure using canonical single-elim seeding so the
  // top seeds can only meet in the final if both win out. For an 8-bracket
  // the round-1 order is [1, 8, 4, 5, 2, 7, 3, 6].
  const order = bracketSeedOrder(compiled.length);
  const roundMatches = [];
  for (let i = 0; i < order.length; i += 2) {
    roundMatches.push({
      a: compiled[order[i] - 1],
      b: compiled[order[i + 1] - 1],
      winner: null,
      winnerSeat: null,
      completed: false,
      running: false,
    });
  }
  _tournBracket = { rounds: [{ matches: roundMatches }] };
  renderTournamentView();
  if (tournEmptyEl) tournEmptyEl.hidden = true;

  const arenaId = tournArenaEl?.value || DEFAULT_ARENA_ID;
  const seedBase = parseInt(tournSeedEl?.value, 10);
  const useSeed = !Number.isNaN(seedBase) && seedBase >= 0 ? seedBase : Math.floor(Math.random() * 2147483646);

  let roundIdx = 0;
  let totalRounds = Math.log2(compiled.length);

  while (roundIdx < totalRounds) {
    const round = _tournBracket.rounds[roundIdx];
    if (tournStatusEl) tournStatusEl.textContent = `Round ${roundIdx + 1} of ${totalRounds}`;

    // Run each match in the round sequentially with UI yields so the bracket
    // animates rather than freezing the tab for the whole tournament.
    for (let mIdx = 0; mIdx < round.matches.length; mIdx++) {
      const match = round.matches[mIdx];
      match.running = true;
      renderTournamentView();
      await nextFrame();
      // Tiny delay so the "running" pulse is visible even on fast matches.
      await new Promise((r) => setTimeout(r, 280));

      const setup = {
        config: {
          mode: "duel_1v1",
          arenaWidth: ARENA_WIDTH,
          arenaHeight: ARENA_HEIGHT,
          maxTicks: 3000,
          tickRate: 30,
          // Mix in round/match index so every match gets a unique seed.
          seed: (useSeed + roundIdx * 977 + mIdx * 31) % 2147483646,
          arenaId,
        },
        participants: [
          { program: match.a.program, constants: match.a.constants, playerId: match.a.name + " (a)", teamId: 0 },
          { program: match.b.program, constants: match.b.constants, playerId: match.b.name + " (b)", teamId: 1 },
        ],
      };

      let result;
      try {
        result = runMatch(setup);
      } catch (e) {
        toast(`Match crashed: ${e.message}`, "error");
        match.running = false;
        renderTournamentView();
        continue;
      }

      match.running = false;
      match.completed = true;
      match.tickCount = result.tickCount;
      match.result = result;
      // Single elim: ties go to the higher seed (lower seed number).
      let winnerSeat;
      if (result.winner === 0) winnerSeat = "a";
      else if (result.winner === 1) winnerSeat = "b";
      else winnerSeat = match.a.seed < match.b.seed ? "a" : "b";
      match.winnerSeat = winnerSeat;
      match.winner = winnerSeat === "a" ? match.a : match.b;
      renderTournamentView();
      SFX.playHit();
    }

    // Build next round from this round's winners.
    if (round.matches.length > 1 || roundIdx + 1 < totalRounds) {
      const winners = round.matches.map((m) => m.winner);
      const nextMatches = [];
      for (let i = 0; i < winners.length; i += 2) {
        nextMatches.push({
          a: winners[i] || null,
          b: winners[i + 1] || null,
          winner: null,
          winnerSeat: null,
          completed: false,
          running: false,
        });
      }
      _tournBracket.rounds.push({ matches: nextMatches });
      renderTournamentView();
      await nextFrame();
    }

    roundIdx++;
  }

  // Crown the champion.
  const champion = _tournBracket.rounds[_tournBracket.rounds.length - 1].matches[0].winner;
  if (tournStatusEl) tournStatusEl.textContent = `Champion: ${champion.name}`;
  if (tournWinnerEl) {
    tournWinnerEl.hidden = false;
    document.getElementById("tw-name").textContent = champion.name + (champion.isYou ? "  (you!)" : "");
    const totalMatches = _tournBracket.rounds.reduce((s, r) => s + r.matches.length, 0);
    document.getElementById("tw-stats").textContent =
      `${compiled.length}-bot single elimination · ${totalRounds} rounds · ${totalMatches} matches`;
  }
  SFX.playVictory();

  // Achievement: winning a tournament as the player counts as a squad win
  // (it's a multi-bot competition you led).
  if (champion.isYou) {
    Achievements.fact("match_ended", {
      won: true,
      perTeamMax: compiled.length,   // counts as the "Squad Leader" trigger
      durationTicks: 0,               // tournament isn't a single match — skip speedrun
      damageTaken: 1,                 // skip Untouchable for tournament
      robotClass: compiledPlayer?.program?.robotClass || null,
    });
    Achievements.fact("tournament_won", {
      seed: champion.seed,
      bracketSize: compiled.length,
    });
  }

  _tournRunning = false;
  tournUpdateRunBtn();
}

btnTournRun?.addEventListener("click", runTournament);
btnTournClear?.addEventListener("click", tournClear);
btnTournPick?.addEventListener("click", tournPickParticipant);
btnTournAutofill?.addEventListener("click", tournAutofill);
btnTournNew?.addEventListener("click", () => {
  _tournBracket = null;
  if (tournWinnerEl) tournWinnerEl.hidden = true;
  renderTournamentView();
});
tournSizeEl?.addEventListener("change", () => {
  // Trim or signal underfill when bracket size shrinks/grows.
  const cap = tournRosterCapacity();
  if (_tournRoster.length > cap) _tournRoster = _tournRoster.slice(0, cap);
  renderTournamentView();
});

// ============================================================================
// Share card — download a PNG of the current match result
// ============================================================================

document.getElementById("btn-share-card")?.addEventListener("click", async () => {
  if (!lastMatchResult) {
    toast("Run a match first.", "warn");
    return;
  }
  try {
    const arena = getArenaPreset(getMatchArenaId());
    const durationLabel = `${(lastMatchResult.tickCount / 30).toFixed(1)}s`;
    const winnerSide = lastMatchResult.winner;
    let winnerLabel = null;
    if (winnerSide === 0 || winnerSide === 1) {
      const participants = lastMatchResult.replay?.metadata?.participants ?? [];
      // Use the player name if Team 0 won and the player was on it; otherwise
      // fall back to a "Team X Wins" framing.
      const playerOnWinning = participants.some((p) => p.teamId === winnerSide && p.playerId === "player");
      if (playerOnWinning) winnerLabel = "YOU WIN";
    }
    const { blob } = await generateShareCard(lastMatchResult, {
      arenaName: arena?.name || "Arena",
      durationLabel,
      winnerLabel,
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadBlob(blob, `arenascript-match-${stamp}.png`);
    toast("Share card downloaded.", "success");
    SFX.playClick();
  } catch (e) {
    toast(`Share card failed: ${e.message ?? String(e)}`, "error");
  }
});

// ============================================================================
// Init
// ============================================================================

refreshOpponentSelect();
renderSidebarUserBots();
refreshMatchHistoryPanel();
updateAuthModeUi();
refreshCurrentUser().catch(() => {});
// Skip the default preset when a shared match link populated the editor —
// otherwise the restore toast fires but the source is overwritten a few
// ticks later, defeating the share link entirely.
if (!sharedMatchRestored) loadPreset("bruiser");
initArenaSelect();
drawIdle();
updateEditorFileName();
updateArenaLoadedBotLabel();
logToConsole(`ArenaScript v${ENGINE_VERSION} — Ready`, "event");
logToConsole("Tip: Ctrl+K opens the command palette, Ctrl+/ opens the language reference.", "info");
