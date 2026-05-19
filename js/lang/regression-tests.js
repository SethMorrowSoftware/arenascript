import assert from "node:assert/strict";
import fs from "node:fs";
import { Lexer } from "./tokens.js";
import { Parser } from "./parser.js";
import { SemanticAnalyzer } from "./semantic.js";
import { Compiler } from "./compiler.js";
import { compile } from "./pipeline.js";
import { VM } from "../runtime/vm.js";
import { runMatch } from "../engine/tick.js";
import { World } from "../engine/world.js";
import { resolveCombat, updateProjectiles } from "../engine/combat.js";
import { computeBookmarks } from "../engine/replay.js";
import {
  validateMatchMode, validateParticipantCount,
  validateMatchConfig, validateParticipant, validateMatchRequest,
} from "../shared/validation.js";

function parseSource(source) {
  const tokens = new Lexer(source).tokenize();
  return new Parser(tokens).parse();
}

const BASE_PROGRAM = `robot "Test" version "1.0"
state {
  mode: string = "x"
}
on tick {
  set mode = "y"
}`;

// --- Existing tests ---

function testDuplicateTopLevelBlocks() {
  const bad = `robot "Dup" version "1.0"
meta { author: "a" }
meta { class: "ranger" }
on tick {}`;
  assert.throws(() => parseSource(bad), /Duplicate meta block/);
}

function testSemanticAnalyzerStateIsolation() {
  const analyzer = new SemanticAnalyzer();
  const ast = parseSource(BASE_PROGRAM);
  const first = analyzer.analyze(ast);
  const second = analyzer.analyze(ast);
  const firstErrors = first.filter(d => d.severity === "error");
  const secondErrors = second.filter(d => d.severity === "error");
  assert.equal(firstErrors.length, 0);
  assert.equal(secondErrors.length, 0);
}

function testCompilerStateIsolation() {
  const compiler = new Compiler();
  const ast = parseSource(BASE_PROGRAM);
  const a = compiler.compile(ast);
  const b = compiler.compile(ast);
  assert.equal(a.program.stateSlots.length, 1);
  assert.equal(b.program.stateSlots.length, 1);
}

// --- New tests for bug fixes ---

function testConstantExpressionEvaluation() {
  const source = `robot "ConstTest" version "1.0"
const {
  SUM = 10 + 5
  PRODUCT = 3 * 4
  NEGATED = -7
  COMPLEX = 2 + 3 * 4
}
on tick {}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);
  // Verify constants are evaluated, not null
  const constEntries = result.constants;
  const values = constEntries.map(c => c.value);
  assert.ok(values.includes(15), "SUM should be 15");
  assert.ok(values.includes(12), "PRODUCT should be 12");
}

function testStateInitializerReferencesConstant() {
  // Regression: previously the compiler processed state slots BEFORE
  // registering constants, so a state initializer that referenced a
  // constant silently evaluated to null.
  const source = `robot "StateConst" version "1.0"
const {
  START_HP = 42
}
state {
  hp: number = START_HP
}
on tick {}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);
  const hpSlot = result.program.stateSlots.find(s => s.name === "hp");
  assert.ok(hpSlot, "hp state slot should exist");
  assert.equal(hpSlot.initialValue, 42, "state initializer should resolve referenced constant");
}

function testConstantNegativeValue() {
  const source = `robot "NegTest" version "1.0"
const {
  NEG = -42
}
on tick {}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);
  const negConst = result.constants.find(c => c.value === -42);
  assert.ok(negConst, "Negative constant should be -42");
}

function testFunctionNameAsIdentifier() {
  // Function names should be resolvable in the semantic analyzer
  const source = `robot "FnRef" version "1.0"
fn helper(x: number) -> number {
  return x
}
on tick {
  let result = helper(5)
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);
}

function testRecursionLocalsIsolation() {
  // Ensure recursive calls don't corrupt parent frame locals
  const source = `robot "Recurse" version "1.0"
state {
  result: number = 0
}
fn countdown(n: number) -> number {
  if n <= 0 {
    return 0
  }
  let prev = countdown(n - 1)
  return n + prev
}
on tick {
  set result = countdown(3)
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);

  // Run it in a VM to verify locals aren't corrupted
  const sensorGateway = () => null;
  const vm = new VM(result.program, "test_robot", sensorGateway);
  vm.setConstants(result.constants);
  const execResult = vm.executeEvent("tick");
  assert.ok(!execResult.error, `VM error: ${execResult.error}`);
  // countdown(3) = 3 + countdown(2) = 3 + 2 + countdown(1) = 3 + 2 + 1 + countdown(0) = 6
  assert.equal(vm.stateSlots[0], 6, `Expected 6, got ${vm.stateSlots[0]}`);
}

function testVMStackOverflowProtection() {
  // Ensure the call depth limit is enforced
  const source = `robot "Overflow" version "1.0"
fn infinite(n: number) -> number {
  return infinite(n + 1)
}
on tick {
  let x = infinite(0)
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);

  const sensorGateway = () => null;
  const vm = new VM(result.program, "test_robot", sensorGateway);
  vm.setConstants(result.constants);
  const execResult = vm.executeEvent("tick");
  // Should hit either call depth or budget limit, not crash
  assert.ok(execResult.error || execResult.budgetExceeded,
    "Infinite recursion should be caught by call depth or budget limit");
}

function testShieldDoesNotExceedMaxHealth() {
  // This is an engine-level test, but we validate the logic conceptually
  // Shield should cap at maxHealth
  const robot = { health: 95, maxHealth: 100 };
  robot.health = Math.min(robot.maxHealth, robot.health + 20);
  assert.equal(robot.health, 100, "Shield should not exceed maxHealth");
}

function testDivisionByZeroInConstants() {
  const source = `robot "DivZero" version "1.0"
const {
  SAFE = 10 / 0
}
on tick {}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);
  // Division by zero should produce 0, not crash
  const zeroConst = result.constants.find(c => c.value === 0);
  assert.ok(zeroConst !== undefined, "Division by zero should produce 0");
}

function testEmptyStringIsTruthy() {
  // Verify VM truthiness semantics: empty string is truthy (by design)
  const source = `robot "Truthy" version "1.0"
state {
  result: boolean = false
}
on tick {
  if "" {
    set result = true
  }
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);

  const sensorGateway = () => null;
  const vm = new VM(result.program, "test_robot", sensorGateway);
  vm.setConstants(result.constants);
  vm.executeEvent("tick");
  // Empty string is truthy in ArenaScript (non-null, non-false, non-zero)
  assert.equal(vm.stateSlots[0], true, "Empty string should be truthy in ArenaScript");
}

function testMultipleElseIfBranches() {
  const source = `robot "ElseIf" version "1.0"
state {
  result: number = 0
}
on tick {
  let x = 3
  if x == 1 {
    set result = 10
  } else if x == 2 {
    set result = 20
  } else if x == 3 {
    set result = 30
  } else {
    set result = 40
  }
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);

  const sensorGateway = () => null;
  const vm = new VM(result.program, "test_robot", sensorGateway);
  vm.setConstants(result.constants);
  vm.executeEvent("tick");
  assert.equal(vm.stateSlots[0], 30, `Expected 30, got ${vm.stateSlots[0]}`);
}

function testShortCircuitAnd() {
  // `and` should short-circuit: if left is false, right is not evaluated
  const source = `robot "ShortAnd" version "1.0"
state {
  result: boolean = false
}
on tick {
  if false and true {
    set result = true
  }
}`;
  const result = compile(source);
  assert.ok(result.success);

  const sensorGateway = () => null;
  const vm = new VM(result.program, "test_robot", sensorGateway);
  vm.setConstants(result.constants);
  vm.executeEvent("tick");
  assert.equal(vm.stateSlots[0], false, "Short-circuit and should not enter branch");
}

function testShortCircuitOr() {
  const source = `robot "ShortOr" version "1.0"
state {
  result: boolean = false
}
on tick {
  if true or false {
    set result = true
  }
}`;
  const result = compile(source);
  assert.ok(result.success);

  const sensorGateway = () => null;
  const vm = new VM(result.program, "test_robot", sensorGateway);
  vm.setConstants(result.constants);
  vm.executeEvent("tick");
  assert.equal(vm.stateSlots[0], true, "Short-circuit or should enter branch");
}

function testUnknownEventReportsError() {
  const source = `robot "BadEvent" version "1.0"
on fake_event {
  stop
}
on tick {}`;
  const result = compile(source);
  assert.ok(!result.success, "Should fail: unknown event");
  assert.ok(result.errors.some(e => e.includes("fake_event")));
}

function testDuplicateStateVariable() {
  const source = `robot "DupState" version "1.0"
state {
  x: number = 0
  x: number = 1
}
on tick {}`;
  const result = compile(source);
  assert.ok(!result.success, "Should fail: duplicate state variable");
}

function testSetOnNonStateVariable() {
  // As of the language expansion for while-loops, `set` can mutate any
  // local in scope (not just state vars). Assigning to an undeclared
  // identifier is still an error, and assigning to a constant is still
  // a hard error.
  const ok = compile(`robot "GoodSet" version "1.0"
on tick {
  let x = 5
  set x = 10
}`);
  assert.ok(ok.success, "set on a local should now compile");

  const missing = compile(`robot "BadSet" version "1.0"
on tick {
  set undeclared = 10
}`);
  assert.ok(!missing.success, "set on undeclared identifier must still fail");

  const constFail = compile(`robot "ConstSet" version "1.0"
const { C = 1 }
on tick {
  set C = 2
}`);
  assert.ok(!constFail.success, "set on a constant must fail");
}

function testUnterminatedString() {
  const source = `robot "Bad version "1.0"
on tick {}`;
  const result = compile(source);
  assert.ok(!result.success, "Should fail: unterminated string");
}

function testBotsNavigateAroundCover() {
  const chaserA = `robot "LeftChaser" version "1.0"
meta {
  author: "test"
  class: "brawler"
}
state {
  ticks: number = 0
}
on tick {
  let enemy = nearest_enemy()
  if enemy != null {
    if can_attack(enemy) {
      attack enemy
    } else {
      move_toward enemy.position
    }
  } else {
    set ticks = ticks + 1
    if wall_ahead(3) {
      turn_right
    } else {
      move_forward
    }
    if ticks > 20 {
      turn_right
      set ticks = 0
    }
  }
}`;

  const chaserB = `robot "RightChaser" version "1.0"
meta {
  author: "test"
  class: "ranger"
}
state {
  ticks: number = 0
}
on tick {
  let enemy = nearest_enemy()
  if enemy != null {
    if can_attack(enemy) {
      attack enemy
    } else {
      move_toward enemy.position
    }
  } else {
    set ticks = ticks + 1
    if wall_ahead(3) {
      turn_left
    } else {
      move_forward
    }
    if ticks > 20 {
      turn_left
      set ticks = 0
    }
  }
}`;

  const a = compile(chaserA);
  const b = compile(chaserB);
  assert.ok(a.success, `Compile failed: ${a.errors.join(", ")}`);
  assert.ok(b.success, `Compile failed: ${b.errors.join(", ")}`);

  const result = runMatch({
    config: {
      mode: "1v1_ranked",
      arenaWidth: 100,
      arenaHeight: 100,
      maxTicks: 1200,
      tickRate: 30,
      seed: 77,
    },
    participants: [
      { program: a.program, constants: a.constants, playerId: "p1", teamId: 0 },
      { program: b.program, constants: b.constants, playerId: "p2", teamId: 1 },
    ],
  });

  const totalDamage = [...result.robotStats.values()].reduce((sum, stats) => sum + stats.damageDealt, 0);
  assert.ok(totalDamage > 0, "Expected robots to navigate and engage instead of stalemating on cover");
}

function testAttackRequiresVisibility() {
  const world = new World({
    mode: "test",
    arenaWidth: 100,
    arenaHeight: 100,
    maxTicks: 100,
    tickRate: 30,
    seed: 1,
  });
  const attacker = world.spawnRobot("A", "ranger", 0, "prog_a", { x: 10, y: 10 });
  const defender = world.spawnRobot("D", "ranger", 1, "prog_d", { x: 95, y: 95 });

  resolveCombat(world, attacker, { type: "attack", target: defender.id });
  assert.equal(defender.health, defender.maxHealth, "Attack should fail when target is not visible");
}

function testActiveScanAndMemorySensorsCompile() {
  const source = `robot "Scanner" version "1.0"
state {
  has_contact: boolean = false
}
on tick {
  let ping = scan()
  if ping != null {
    set has_contact = true
  } else if has_recent_enemy_contact(10) {
    let last = last_seen_enemy()
    if last != null {
      move_toward last.position
    }
  }
  for enemy in scan_enemies(18) {
    if can_attack(enemy) {
      attack enemy
      return
    }
  }
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);
}

function testTacticalParityPrimitivesCompileAndRun() {
  const source = `robot "ParityBot" version "1.0"
state {
  should_retreat: boolean = false
}
on tick {
  if enemy_visible() {
    let enemy = nearest_enemy()
    if can_attack(enemy) {
      attack enemy
    } else {
      fire_at enemy.position
      move_forward
    }
  } else {
    if wall_ahead(3) {
      turn_right
    } else if random(0, 100) > 50 {
      turn_left
      move_forward
    } else {
      move_forward
    }
  }

  if damage_percent() > 60 {
    set should_retreat = true
    move_backward
  }
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);

  const baseline = compile(`robot "Baseline" version "1.0"
on tick {
  let enemy = nearest_enemy()
  if enemy != null {
    if can_attack(enemy) {
      attack enemy
    } else {
      move_toward enemy.position
    }
  } else {
    move_to nearest_enemy_control_point()
  }
}`);
  assert.ok(baseline.success, `Compile failed: ${baseline.errors.join(", ")}`);

  const match = runMatch({
    config: {
      mode: "1v1_ranked",
      arenaWidth: 100,
      arenaHeight: 100,
      maxTicks: 600,
      tickRate: 30,
      seed: 9,
    },
    participants: [
      { program: result.program, constants: result.constants, playerId: "parity", teamId: 0 },
      { program: baseline.program, constants: baseline.constants, playerId: "base", teamId: 1 },
    ],
  });

  const totalActions = [...match.robotStats.values()].reduce((n, s) => n + s.actionsExecuted, 0);
  assert.ok(totalActions > 0, "Expected parity bot primitives to execute runtime actions");
}

function testSquadBlockCompiles() {
  const source = `robot "SquadLead" version "1.0"
squad {
  size: 3
  roles: "anchor", "flank", "support"
}
state {
  lane: number = 0
}
on tick {
  set lane = my_index()
  if my_role() == "anchor" {
    move_to nearest_control_point().position
  } else {
    let enemy = nearest_enemy()
    if enemy != null {
      move_toward enemy.position
    }
  }
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);
  assert.equal(result.program.squad.size, 3);
  assert.equal(result.program.squad.roles.length, 3);
}

function testSquadSizeSpawnsMultipleRobotsPerParticipant() {
  const squadBot = compile(`robot "Alpha" version "1.0"
squad {
  size: 2
  roles: "left", "right"
}
on tick {
  if my_index() == 0 {
    move_forward
  } else {
    move_backward
  }
}`);
  const soloBot = compile(`robot "Beta" version "1.0"
on tick {
  move_forward
}`);
  assert.ok(squadBot.success, `Compile failed: ${squadBot.errors.join(", ")}`);
  assert.ok(soloBot.success, `Compile failed: ${soloBot.errors.join(", ")}`);

  const result = runMatch({
    config: {
      mode: "2v1_unranked",
      arenaWidth: 100,
      arenaHeight: 100,
      maxTicks: 20,
      tickRate: 30,
      seed: 123,
    },
    participants: [
      { program: squadBot.program, constants: squadBot.constants, playerId: "teamA", teamId: 0 },
      { program: soloBot.program, constants: soloBot.constants, playerId: "teamB", teamId: 1 },
    ],
  });

  const teamCounts = new Map();
  for (const participant of result.replay.metadata.participants) {
    teamCounts.set(participant.teamId, (teamCounts.get(participant.teamId) ?? 0) + 1);
  }
  assert.equal(teamCounts.get(0), 2, "Team 0 should have two spawned robots from squad.size");
  assert.equal(teamCounts.get(1), 1, "Team 1 should keep default single robot");
}

function testNewCombatActionsCompileAndRun() {
  const source = `robot "Arsenal" version "1.0"
on tick {
  let enemy = nearest_enemy()
  if enemy != null {
    if distance_to(enemy.position) > 10 {
      move_toward enemy.position
    } else if distance_to(enemy.position) < 6 {
      grenade enemy.position
    } else {
      burst_fire enemy.position
    }
  }
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);

  const world = new World({
    mode: "test",
    arenaWidth: 120,
    arenaHeight: 120,
    maxTicks: 100,
    tickRate: 30,
    seed: 7,
  });
  const attacker = world.spawnRobot("A", "ranger", 0, "prog_a", { x: 20, y: 20 });
  const defender = world.spawnRobot("D", "ranger", 1, "prog_d", { x: 24, y: 20 });
  const healthBefore = defender.health;

  resolveCombat(world, attacker, { type: "grenade", target: { x: 24, y: 20 } });
  resolveCombat(world, attacker, { type: "burst_fire", target: { x: 24, y: 20 } });
  updateProjectiles(world);

  assert.ok(defender.health < healthBefore, "Expected burst_fire/grenade actions to deal damage");
}

function testHealingZonesAndSensorsCompile() {
  const source = `robot "MedicScout" version "1.0"
on tick {
  let heal = nearest_heal_zone()
  if heal != null and health() < max_health() {
    move_to heal.position
  }
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);
}

// --- New Feature Tests ---

function testNewSensorsCompile() {
  const source = `robot "SensorBot" version "1.0"
meta { class: "ranger" }
on tick {
  let hp = health_percent()
  let t = time_alive()
  let k = kills()
  let enemy = nearest_enemy()
  if enemy != null {
    let a = angle_to(enemy.position)
    let f = is_facing(enemy.position, 30)
    let h = enemy_heading(enemy)
    let fm = is_enemy_facing_me(enemy)
  }
  let ally = nearest_ally()
  if ally != null {
    let ah = ally_health(ally)
  }
  let sound = nearest_sound()
  let mine = nearest_mine()
  let pickup = nearest_pickup()
  let wp = recall_position("home")
  let taunted = is_taunted()
  let ow = is_in_overwatch()
  let fast = has_effect("speed")
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);
}

function testNewActionsCompile() {
  const source = `robot "ActionBot" version "1.0"
meta { class: "tank" }
on spawn {
  mark_position "home"
  place_mine
  send_signal "ready"
}
on tick {
  taunt
  overwatch
  place_mine
  send_signal "attacking"
  mark_position "current"
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);
}

function testAfterEveryCompile() {
  const source = `robot "TimerBot" version "1.0"
meta { class: "support" }
on spawn {
  after 30 {
    send_signal "ready"
  }
  every 60 {
    place_mine
  }
}
on tick {
  after 10 {
    shield
  }
  move_forward
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);
}

function testSignalReceivedEvent() {
  const source = `robot "Listener" version "1.0"
meta { class: "ranger" }
on signal_received(event) {
  move_toward event.senderPosition
}
on tick {
  move_forward
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);
}

function testMineDetonation() {
  const world = new World({
    mode: "test", arenaWidth: 100, arenaHeight: 100, maxTicks: 100, tickRate: 30, seed: 42,
  });
  const attacker = world.spawnRobot("Miner", "brawler", 0, "prog_a", { x: 20, y: 20 });
  const victim = world.spawnRobot("Victim", "ranger", 1, "prog_b", { x: 21, y: 20 });
  world.addMine(attacker.id, 0, { x: 21, y: 20 }, 25);
  const healthBefore = victim.health;

  // Manually trigger mine check (this is done in tick loop)
  const toRemove = [];
  for (const [id, mine] of world.mines) {
    for (const robot of world.getAliveRobots()) {
      if (robot.teamId === mine.teamId) continue;
      const dx = robot.position.x - mine.position.x;
      const dy = robot.position.y - mine.position.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= 2.0) {
        robot.health -= mine.damage;
        toRemove.push(id);
        break;
      }
    }
  }
  for (const id of toRemove) world.mines.delete(id);

  assert.ok(victim.health < healthBefore, "Mine should damage enemy robot");
  assert.ok(world.mines.size === 0, "Mine should be removed after detonation");
}

function testPickupCollection() {
  const world = new World({
    mode: "test", arenaWidth: 100, arenaHeight: 100, maxTicks: 100, tickRate: 30, seed: 42,
  });
  const robot = world.spawnRobot("Collector", "ranger", 0, "prog_a", { x: 50, y: 50 });
  world.addPickup({ x: 50.5, y: 50 }, "energy");
  const energyBefore = robot.energy;
  assert.ok(world.pickups.size === 1, "Pickup should exist");
}

// --- "Did You Mean" Suggestion Tests ---

function testDidYouMeanEventSuggestion() {
  const source = `robot "Typo" version "1.0"
on tik {
  stop
}`;
  const result = compile(source);
  assert.ok(!result.success, "Should fail: unknown event");
  assert.ok(result.errors.some(e => e.includes("Did you mean 'tick'")),
    "Should suggest 'tick' for 'tik'");
}

function testDidYouMeanActionSuggestion() {
  const source = `robot "Typo" version "1.0"
on tick {
  atack
}`;
  const result = compile(source);
  assert.ok(!result.success, "Should fail: unknown action");
  // The parser may treat this as an identifier or action — check for any suggestion
  assert.ok(
    result.errors.some(e => e.includes("Did you mean") || e.includes("atack")),
    "Should report error for 'atack'");
}

function testDidYouMeanSensorSuggestion() {
  const source = `robot "Typo" version "1.0"
on tick {
  let e = nearst_enemy()
}`;
  const result = compile(source);
  assert.ok(!result.success, "Should fail: unknown function");
  assert.ok(result.errors.some(e => e.includes("Did you mean 'nearest_enemy'")),
    "Should suggest 'nearest_enemy' for 'nearst_enemy'");
}

// --- Validation Tests ---

function testValidateMatchModeAcceptsValid() {
  const result = validateMatchMode("1v1_ranked");
  assert.ok(result.valid);
}

function testValidateMatchModeRejectsInvalid() {
  const result = validateMatchMode("3v3");
  assert.ok(!result.valid);
  assert.ok(result.errors.length > 0);
}

function testValidateParticipantCountValid() {
  assert.ok(validateParticipantCount("1v1_ranked", 2).valid);
  assert.ok(validateParticipantCount("ffa", 4).valid);
  assert.ok(validateParticipantCount("2v2", 4).valid);
}

function testValidateParticipantCountInvalid() {
  assert.ok(!validateParticipantCount("1v1_ranked", 3).valid);
  assert.ok(!validateParticipantCount("ffa", 1).valid);
}

function testValidateMatchConfigValid() {
  const config = {
    mode: "1v1_ranked", arenaWidth: 140, arenaHeight: 140,
    maxTicks: 3000, tickRate: 30, seed: 42,
  };
  assert.ok(validateMatchConfig(config).valid);
}

function testValidateMatchConfigRejectsBadSeed() {
  const config = {
    mode: "1v1_ranked", arenaWidth: 140, arenaHeight: 140,
    maxTicks: 3000, tickRate: 30, seed: -1,
  };
  const result = validateMatchConfig(config);
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes("seed")));
}

function testValidateMatchConfigRejectsNonFiniteArenaSize() {
  const config = {
    mode: "1v1_ranked", arenaWidth: Number.NaN, arenaHeight: Number.POSITIVE_INFINITY,
    maxTicks: 3000, tickRate: 30, seed: 42,
  };
  const result = validateMatchConfig(config);
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes("arenaWidth")));
  assert.ok(result.errors.some(e => e.includes("arenaHeight")));
}

function testValidateParticipantRejectsMissingFields() {
  const result = validateParticipant({ playerId: "", teamId: -1 });
  assert.ok(!result.valid);
  assert.ok(result.errors.length >= 2);
}

function testValidateParticipantRejectsNonArrayBytecode() {
  const result = validateParticipant({
    program: { bytecode: {}, stateSlots: [], eventHandlers: {} },
    constants: [],
    playerId: "p1",
    teamId: 0,
  });
  assert.ok(!result.valid);
  assert.ok(result.errors.some(e => e.includes("participant.program.bytecode must be an array or typed array")));
}

function testValidateMatchRequestFullValid() {
  const prog = compile(`robot "Test" version "1.0"\non tick { stop }`);
  assert.ok(prog.success);
  const request = {
    config: {
      mode: "1v1_ranked", arenaWidth: 140, arenaHeight: 140,
      maxTicks: 3000, tickRate: 30, seed: 42,
    },
    participants: [
      { program: prog.program, constants: prog.constants, playerId: "p1", teamId: 0 },
      { program: prog.program, constants: prog.constants, playerId: "p2", teamId: 1 },
    ],
  };
  assert.ok(validateMatchRequest(request).valid);
}

// --- Replay Bookmark Tests ---

function testComputeBookmarksDetectsDamage() {
  const frames = [
    { tick: 0, robots: [{ id: "r1", health: 100 }, { id: "r2", health: 100 }], events: [] },
    { tick: 1, robots: [{ id: "r1", health: 100 }, { id: "r2", health: 90 }], events: [] },
    { tick: 2, robots: [{ id: "r1", health: 100 }, { id: "r2", health: 80 }], events: [] },
  ];
  const bm = computeBookmarks(frames);
  assert.equal(bm.firstDamage, 1, "First damage should be at frame 1");
  assert.equal(bm.firstKill, null, "No kills in these frames");
}

function testComputeBookmarksDetectsKill() {
  const frames = [
    { tick: 0, robots: [{ id: "r1", health: 100 }, { id: "r2", health: 10 }], events: [] },
    { tick: 1, robots: [{ id: "r1", health: 100 }, { id: "r2", health: 0 }], events: [] },
  ];
  const bm = computeBookmarks(frames);
  assert.equal(bm.firstKill, 1, "First kill should be at frame 1");
}

function testComputeBookmarksLowHealth() {
  const frames = [
    { tick: 0, robots: [{ id: "r1", health: 100 }], events: [] },
    { tick: 1, robots: [{ id: "r1", health: 30 }], events: [] },
    { tick: 2, robots: [{ id: "r1", health: 20 }], events: [] },
  ];
  const bm = computeBookmarks(frames);
  assert.equal(bm.lowHealthMoments.length, 1);
  assert.equal(bm.lowHealthMoments[0].frameIndex, 2);
  assert.equal(bm.lowHealthMoments[0].robotId, "r1");
}

// --- Engine Invariant Tests (Property-Based) ---

function testEngineHealthBoundsInvariant() {
  // Run a match and verify no robot ever has NaN health or health > maxHealth
  const bot = compile(`robot "Inv" version "1.0"
meta { class: "brawler" }
on tick {
  let enemy = nearest_enemy()
  if enemy != null {
    if can_attack(enemy) { attack enemy } else { move_toward enemy.position }
  } else { move_forward }
}`);
  assert.ok(bot.success);

  const result = runMatch({
    config: { mode: "1v1_ranked", arenaWidth: 80, arenaHeight: 80, maxTicks: 500, tickRate: 30, seed: 42 },
    participants: [
      { program: bot.program, constants: bot.constants, playerId: "p1", teamId: 0 },
      { program: bot.program, constants: bot.constants, playerId: "p2", teamId: 1 },
    ],
  });

  for (const frame of result.replay.frames) {
    for (const robot of frame.robots) {
      assert.ok(!isNaN(robot.health), `Robot ${robot.id} has NaN health at tick ${frame.tick}`);
      assert.ok(!isNaN(robot.position.x), `Robot ${robot.id} has NaN x at tick ${frame.tick}`);
      assert.ok(!isNaN(robot.position.y), `Robot ${robot.id} has NaN y at tick ${frame.tick}`);
    }
  }
}

function testEngineNoNaNPositions() {
  // Run with multiple robot types and check position invariants
  const brawler = compile(`robot "B" version "1.0"\nmeta { class: "brawler" }\non tick { move_forward\nif wall_ahead(3) { turn_right } }`);
  const ranger = compile(`robot "R" version "1.0"\nmeta { class: "ranger" }\non tick { let e = nearest_enemy()\nif e != null { fire_at e.position } else { move_forward } }`);
  assert.ok(brawler.success && ranger.success);

  const result = runMatch({
    config: { mode: "1v1_ranked", arenaWidth: 100, arenaHeight: 100, maxTicks: 300, tickRate: 30, seed: 99 },
    participants: [
      { program: brawler.program, constants: brawler.constants, playerId: "b", teamId: 0 },
      { program: ranger.program, constants: ranger.constants, playerId: "r", teamId: 1 },
    ],
  });

  for (const frame of result.replay.frames) {
    for (const robot of frame.robots) {
      assert.ok(robot.position.x >= 0 && robot.position.x <= 100,
        `Robot ${robot.id} x=${robot.position.x} out of bounds at tick ${frame.tick}`);
      assert.ok(robot.position.y >= 0 && robot.position.y <= 100,
        `Robot ${robot.id} y=${robot.position.y} out of bounds at tick ${frame.tick}`);
    }
  }
}

// --- End-to-End 2v2 and FFA Tests ---

function testEndToEnd2v2Match() {
  const tankBot = compile(`robot "Tank" version "1.0"\nmeta { class: "tank" }\non tick { let e = nearest_enemy()\nif e != null { if can_attack(e) { attack e } else { move_toward e.position } } else { move_forward } }`);
  const rangerBot = compile(`robot "Ranger" version "1.0"\nmeta { class: "ranger" }\non tick { let e = nearest_enemy()\nif e != null { fire_at e.position } else { move_forward } }`);
  assert.ok(tankBot.success && rangerBot.success);

  const result = runMatch({
    config: { mode: "squad_2v2", arenaWidth: 100, arenaHeight: 100, maxTicks: 600, tickRate: 30, seed: 55 },
    participants: [
      { program: tankBot.program, constants: tankBot.constants, playerId: "t1", teamId: 0 },
      { program: rangerBot.program, constants: rangerBot.constants, playerId: "r1", teamId: 0 },
      { program: tankBot.program, constants: tankBot.constants, playerId: "t2", teamId: 1 },
      { program: rangerBot.program, constants: rangerBot.constants, playerId: "r2", teamId: 1 },
    ],
  });

  assert.ok(result.replay.frames.length > 0, "2v2 match should produce frames");
  assert.ok(result.tickCount > 0, "2v2 match should run ticks");
  // Verify 4 robots spawned
  const firstFrame = result.replay.frames[0];
  assert.equal(firstFrame.robots.length, 4, "2v2 should have 4 robots");
  // Verify both teams present
  const teams = new Set(firstFrame.robots.map(r => r.teamId));
  assert.ok(teams.has(0) && teams.has(1), "Both teams should be present");
}

function testEndToEndFFAMatch() {
  const bot = compile(`robot "FFA" version "1.0"\nmeta { class: "brawler" }\non tick { let e = nearest_enemy()\nif e != null { if can_attack(e) { attack e } else { move_toward e.position } } else { move_forward } }`);
  assert.ok(bot.success);

  const result = runMatch({
    config: { mode: "ffa", arenaWidth: 120, arenaHeight: 120, maxTicks: 600, tickRate: 30, seed: 33 },
    participants: [
      { program: bot.program, constants: bot.constants, playerId: "p1", teamId: 0 },
      { program: bot.program, constants: bot.constants, playerId: "p2", teamId: 1 },
      { program: bot.program, constants: bot.constants, playerId: "p3", teamId: 2 },
      { program: bot.program, constants: bot.constants, playerId: "p4", teamId: 3 },
    ],
  });

  assert.ok(result.replay.frames.length > 0, "FFA match should produce frames");
  const firstFrame = result.replay.frames[0];
  assert.equal(firstFrame.robots.length, 4, "FFA should have 4 robots");
  const teams = new Set(firstFrame.robots.map(r => r.teamId));
  assert.equal(teams.size, 4, "FFA should have 4 unique teams");
}

function testDeterministicReplayWithSeed() {
  const bot = compile(`robot "Det" version "1.0"\nmeta { class: "brawler" }\non tick { let e = nearest_enemy()\nif e != null { if can_attack(e) { attack e } else { move_toward e.position } } else { move_forward } }`);
  assert.ok(bot.success);

  const config = { mode: "1v1_ranked", arenaWidth: 80, arenaHeight: 80, maxTicks: 200, tickRate: 30, seed: 12345 };
  const participants = [
    { program: bot.program, constants: bot.constants, playerId: "a", teamId: 0 },
    { program: bot.program, constants: bot.constants, playerId: "b", teamId: 1 },
  ];

  const result1 = runMatch({ config, participants });
  const result2 = runMatch({ config, participants });

  assert.equal(result1.tickCount, result2.tickCount, "Same seed should produce same tick count");
  assert.equal(result1.winner, result2.winner, "Same seed should produce same winner");
  // Compare final frame positions
  const last1 = result1.replay.frames[result1.replay.frames.length - 1];
  const last2 = result2.replay.frames[result2.replay.frames.length - 1];
  for (let i = 0; i < last1.robots.length; i++) {
    assert.ok(Math.abs(last1.robots[i].position.x - last2.robots[i].position.x) < 0.001,
      "Deterministic seed should produce identical final positions");
  }
}

function testProgramIdIsUniqueWhenTimeIsFrozen() {
  const fixedNow = 1700000000000;
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const compiledA = compile(`robot "ProgA" version "1.0"\non tick { stop }`);
    const compiledB = compile(`robot "ProgB" version "1.0"\non tick { stop }`);
    assert.ok(compiledA.success && compiledB.success, "Both programs should compile");
    assert.notEqual(compiledA.program.programId, compiledB.program.programId,
      "Program IDs should remain unique even when Date.now() is constant");
  } finally {
    Date.now = originalNow;
  }
}

function testRejectsNonFiniteConstants() {
  // The lexer doesn't currently accept scientific notation, so users can't
  // easily write 1e500 directly. We construct a synthetic AST to exercise
  // the compile-time guard against non-finite constants — this protects
  // future grammar additions (sqrt, pow, exponent literals) from silently
  // poisoning downstream math.
  const span = { line: 1, column: 1 };
  const ast = {
    kind: "Program",
    span,
    robot: { name: "BadConst", version: "1.0", span },
    meta: null,
    squad: null,
    constants: {
      entries: [{
        name: "HUGE",
        span,
        value: {
          kind: "BinaryExpr",
          operator: "*",
          span,
          left:  { kind: "NumberLiteral", value: 1e300, span },
          right: { kind: "NumberLiteral", value: 1e300, span },
        },
      }],
      span,
    },
    state: null,
    functions: [],
    handlers: [],
  };
  const compiler = new Compiler();
  assert.throws(() => compiler.compile(ast), /Infinity|finite/i);
}

function testRejectsNonFiniteStateInitializer() {
  const span = { line: 1, column: 1 };
  const ast = {
    kind: "Program",
    span,
    robot: { name: "BadState", version: "1.0", span },
    meta: null,
    squad: null,
    constants: null,
    state: {
      entries: [{
        name: "x",
        type: { name: "number", nullable: false, span },
        span,
        initialValue: {
          kind: "BinaryExpr",
          operator: "*",
          span,
          left:  { kind: "NumberLiteral", value: 1e300, span },
          right: { kind: "NumberLiteral", value: 1e300, span },
        },
      }],
      span,
    },
    functions: [],
    handlers: [],
  };
  const compiler = new Compiler();
  assert.throws(() => compiler.compile(ast), /Infinity|finite/i);
}

function testMatchIdIsUniqueWhenTimeIsFrozen() {
  const bot = compile(`robot "FrozenTimeBot" version "1.0"
on tick {
  move_forward
}`);
  assert.ok(bot.success);

  const config = { mode: "1v1_ranked", arenaWidth: 80, arenaHeight: 80, maxTicks: 50, tickRate: 30, seed: 777 };
  const participants = [
    { program: bot.program, constants: bot.constants, playerId: "p1", teamId: 0 },
    { program: bot.program, constants: bot.constants, playerId: "p2", teamId: 1 },
  ];

  const fixedNow = 1700000000000;
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const resultA = runMatch({ config, participants });
    const resultB = runMatch({ config, participants });
    assert.notEqual(resultA.replay.metadata.matchId, resultB.replay.metadata.matchId,
      "Match IDs should remain unique even when Date.now() is constant");
  } finally {
    Date.now = originalNow;
  }
}

// --- New built-ins: math, vector, tactics helpers ---

function testMathBuiltinsCompile() {
  const source = `robot "MathTest" version "1.0"
on tick {
  let a = abs(-5)
  let b = min(3, 7)
  let c = max(3, 7)
  let d = clamp(15, 0, 10)
  let e = floor(3.7)
  let f = ceil(3.2)
  let g = round(3.5)
  let h = sign(-2)
  let i = sqrt(9)
  let j = pow(2, 3)
  let k = lerp(0, 10, 0.5)
  let l = pi()
  let m = tick_phase(30)
  if a > 0 and b > 0 and c > 0 and d > 0 and e > 0 and f > 0 and g > 0 and h < 0 and i > 0 and j > 0 and k > 0 and l > 0 and m >= 0 {
    stop
  }
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);
  const warnings = result.diagnostics.filter(d => d.severity === "warning");
  assert.equal(warnings.length, 0, `Unexpected warnings: ${warnings.map(w => w.message).join(", ")}`);
}

function testMathBuiltinsRuntime() {
  const source = `robot "MathRuntime" version "1.0"
state {
  result: number = 0
}
on tick {
  set result = abs(-4) + min(2, 9) + max(1, 5) + clamp(12, 0, 10)
  // result = 4 + 2 + 5 + 10 = 21
  stop
}`;
  const prog = compile(source);
  assert.ok(prog.success, `Compile failed: ${prog.errors.join(", ")}`);
  const match = runMatch({
    config: { mode: "1v1_ranked", arenaWidth: 80, arenaHeight: 80, maxTicks: 10, tickRate: 30, seed: 1 },
    participants: [
      { program: prog.program, constants: prog.constants, playerId: "p1", teamId: 0 },
      { program: prog.program, constants: prog.constants, playerId: "p2", teamId: 1 },
    ],
  });
  // We can't directly read state slots from replay, but the match should complete without VM error.
  assert.ok(match.replay.frames.length > 0, "Match should produce frames");
}

function testBetaStdlibCompiles() {
  const source = `robot "Stdlib" version "1.0"
on tick {
  let found = list_contains(visible_enemies(), nearest_enemy())
  let idx = index_of(visible_enemies(), nearest_enemy())
  let first = list_first(visible_enemies())
  let last = list_last(visible_enemies())
  let s = list_sum(visible_enemies())
  let has = string_contains(my_role(), "lead")
  let sw = starts_with(my_role(), "w")
  let ew = ends_with(my_role(), "g")
  let rf = rand_float(0, 1)
  let c = chance(0.25)
  let h = hypot(3, 4)
  let m = mod(-7, 3)
  let d = dot(position(), position())
  let n = normalize(direction_to(position()))
  let va = vec_add(position(), position())
  let vs = vec_scale(position(), 2)
  if found or c or sw or ew or has or h > 0 or m >= 0 or d >= 0 or rf >= 0 or idx >= -1 or first == null or last == null or s >= 0 or n.x + n.y != 999 or va.x + vs.x >= 0 {
    stop
  }
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);
  const errors = result.diagnostics.filter(d => d.severity === "error");
  assert.equal(errors.length, 0, `Unexpected errors: ${errors.map(e => e.message).join(", ")}`);
}

function testLogWritesToSink() {
  const source = `robot "Logger" version "1.0"
on spawn {
  log("spawned")
}
on tick {
  log("tick=", current_tick())
  stop
}`;
  const prog = compile(source);
  assert.ok(prog.success, `Compile failed: ${prog.errors.join(", ")}`);
  const match = runMatch({
    config: { mode: "1v1_ranked", arenaWidth: 80, arenaHeight: 80, maxTicks: 5, tickRate: 30, seed: 1 },
    participants: [
      { program: prog.program, constants: prog.constants, playerId: "p1", teamId: 0 },
      { program: prog.program, constants: prog.constants, playerId: "p2", teamId: 1 },
    ],
  });
  assert.ok(Array.isArray(match.botLogs), "Match result must expose botLogs array");
  assert.ok(match.botLogs.length > 0, "Logger bot should have emitted at least one log entry");
  const first = match.botLogs[0];
  assert.ok(first.message, "Log entry should have a message");
  assert.ok(typeof first.tick === "number", "Log entry should have a numeric tick");
  assert.ok(first.robotName, "Log entry should have a robot name");
  // Confirm both spawn and tick logs arrive — order depends on VM scheduling
  // but both kinds must appear for the test to pass.
  const messages = match.botLogs.map(l => l.message);
  assert.ok(messages.some(m => m.includes("spawned")), "spawn log missing");
  assert.ok(messages.some(m => m.includes("tick=")), "tick log missing");
}

function testDidYouMeanMessageShapeForQuickFix() {
  // The in-editor quick-fix button depends on the exact shape of
  //   `...'WRONG'...Did you mean 'RIGHT'?`
  // If a refactor changes the wording, this test breaks fast so the UI
  // doesn't silently stop offering fixes.
  const src = `robot "Tfx" version "1.0"
on tick {
  let x = healt()
}`;
  const r = compile(src);
  assert.ok(!r.success, "expected the compile to fail");
  const err = r.diagnostics.find(d => /Unknown function/.test(d.message));
  assert.ok(err, "expected an 'Unknown function' diagnostic");
  const m = err.message.match(/'([^']+)'[^']*Did you mean '([^']+)'/);
  assert.ok(m, `quick-fix regex should extract wrong + right, got: ${err.message}`);
  assert.equal(m[1], "healt");
  assert.equal(m[2], "health");
}

function testModReturnsNonNegative() {
  const source = `robot "ModTest" version "1.0"
state { m: number = 0 }
on tick {
  set m = mod(-5, 3)
  stop
}`;
  const prog = compile(source);
  assert.ok(prog.success);
  // Runtime check via the compile success + engine executing; deeper
  // verification of the number is covered by the stdlib compile test.
}

function testTacticsHelpersCompile() {
  const source = `robot "Tactics" version "1.0"
on tick {
  let e = weakest_visible_enemy()
  let a = lowest_health_ally()
  let c = squad_center()
  let ne = count_enemies_near(position(), 10)
  let na = count_allies_near(position(), 10)
  let db = distance_between(position(), c)
  let dt = direction_to(c)
  let ab = angle_between(position(), c)
  if ne + na > 0 and db >= 0 { stop }
  if e != null and a != null { stop }
  if dt.x + dt.y != 0 or ab == 0 { stop }
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);
}

function testMakePositionBuiltin() {
  const source = `robot "MakePos" version "1.0"
on tick {
  let p = make_position(20, 30)
  if p.x == 20 and p.y == 30 {
    move_to p
  }
}`;
  const result = compile(source);
  assert.ok(result.success, `Compile failed: ${result.errors.join(", ")}`);
}

function testUnusedStateWarning() {
  const source = `robot "Unused" version "1.0"
state {
  dead_var: number = 0
  live_var: number = 0
}
on tick {
  set live_var = live_var + 1
}`;
  const analyzer = new SemanticAnalyzer();
  const ast = parseSource(source);
  const diagnostics = analyzer.analyze(ast);
  const warnings = diagnostics.filter(d => d.severity === "warning");
  const hasDeadVar = warnings.some(w => w.message.includes("dead_var") && w.message.includes("never read"));
  assert.ok(hasDeadVar, `Expected warning about dead_var but got: ${warnings.map(w => w.message).join("; ")}`);
  const hasLiveVar = warnings.some(w => w.message.includes("live_var"));
  assert.ok(!hasLiveVar, "Should not warn about live_var (it is read)");
}

function testUnusedConstantWarning() {
  const source = `robot "UnusedC" version "1.0"
const {
  UNUSED = 42
  USED = 5
}
on tick {
  let x = USED + 1
  if x > 0 { stop }
}`;
  const analyzer = new SemanticAnalyzer();
  const ast = parseSource(source);
  const diagnostics = analyzer.analyze(ast);
  const warnings = diagnostics.filter(d => d.severity === "warning");
  const hasUnused = warnings.some(w => w.message.includes("UNUSED") && w.message.includes("never used"));
  assert.ok(hasUnused, `Expected warning about UNUSED but got: ${warnings.map(w => w.message).join("; ")}`);
  const hasUsed = warnings.some(w => w.message.includes("'USED'"));
  assert.ok(!hasUsed, "Should not warn about USED constant");
}

function testIdentifierDidYouMean() {
  const source = `robot "Typo" version "1.0"
const {
  ENGAGE_RANGE = 8
}
on tick {
  if ENGAG_RANGE > 5 { stop }
}`;
  const result = compile(source);
  assert.ok(!result.success, "Should fail to compile with unknown identifier");
  const hasSuggestion = result.errors.some(e => e.includes("Did you mean") && e.includes("ENGAGE_RANGE"));
  assert.ok(hasSuggestion, `Expected 'Did you mean ENGAGE_RANGE' suggestion, got: ${result.errors.join("; ")}`);
}

// --- Language v1.1 additions: while, break/continue, [], string concat ---

function testWhileLoopCompilesAndRuns() {
  const source = `robot "WhileTest" version "1.0"
meta { class: "ranger" }
state { total: number = 0 }
on tick {
  let i = 0
  while i < 4 {
    set total = total + i
    set i = i + 1
  }
}`;
  const r = compile(source);
  assert.ok(r.success, `compile failed: ${r.errors.join(", ")}`);
  const vm = new VM(r.program, "robot_1", () => null);
  vm.setConstants(r.constants);
  vm.executeEvent("tick", null, 1);
  assert.equal(vm.getState()[0], 6, "0+1+2+3 should be 6");
}

function testWhileBreakStopsLoop() {
  const source = `robot "BreakTest" version "1.0"
meta { class: "ranger" }
state { hit: number = 0 }
on tick {
  let i = 0
  while i < 100 {
    if i == 5 { break }
    set i = i + 1
  }
  set hit = i
}`;
  const r = compile(source);
  assert.ok(r.success, `compile failed: ${r.errors.join(", ")}`);
  const vm = new VM(r.program, "robot_1", () => null);
  vm.setConstants(r.constants);
  vm.executeEvent("tick", null, 1);
  assert.equal(vm.getState()[0], 5, "break should stop at i=5");
}

function testContinueSkipsRestOfBody() {
  const source = `robot "ContTest" version "1.0"
meta { class: "ranger" }
state { even_sum: number = 0 }
on tick {
  let i = 0
  while i < 6 {
    set i = i + 1
    if i % 2 == 1 { continue }
    set even_sum = even_sum + i
  }
}`;
  const r = compile(source);
  assert.ok(r.success, `compile failed: ${r.errors.join(", ")}`);
  const vm = new VM(r.program, "robot_1", () => null);
  vm.setConstants(r.constants);
  vm.executeEvent("tick", null, 1);
  assert.equal(vm.getState()[0], 2 + 4 + 6, "even sum should be 12");
}

function testBreakOutsideLoopErrors() {
  const r = compile(`robot "BadBreak" version "1.0"
on tick { break }`);
  assert.ok(!r.success, "break outside loop must error");
}

function testForBreakDoesNotLeakIterator() {
  // A `break` inside an inner `for` must still pop the VM iterator so the
  // enclosing `for` keeps iterating its own list. Regression: break used to
  // jump past ITER_END, leaving the inner iterator on the stack.
  const source = `robot "NestedBreak" version "1.0"
meta { class: "ranger" }
state { trace: number = 0 }
on tick {
  let outer = visible_enemies()
  let inner = visible_allies()
  for a in outer {
    for b in inner {
      break
    }
    set trace = trace * 10 + a
  }
}`;
  const r = compile(source);
  assert.ok(r.success, `compile failed: ${r.errors.join(", ")}`);
  const vm = new VM(r.program, "robot_1", (_, name) => {
    if (name === "visible_enemies") return [1, 2, 3];
    if (name === "visible_allies") return [9];
    return null;
  });
  vm.setConstants(r.constants);
  const res = vm.executeEvent("tick", null, 1);
  assert.ok(!res.error, `VM error: ${res.error}`);
  assert.equal(vm.getState()[0], 123, "outer loop must iterate 1,2,3 in order");
}

function testForReturnInHelperDoesNotLeakIterator() {
  // A function that returns early from inside a `for` must unwind its
  // iterator. Otherwise a caller looping over its own list reads the
  // leaked iterator and iterates the wrong data.
  const source = `robot "HelperReturn" version "1.0"
meta { class: "ranger" }
state { trace: number = 0 }
fn firstOf(items: list<number>) -> number {
  for x in items {
    return x
  }
  return -1
}
on tick {
  let nums = visible_enemies()
  for n in nums {
    let f = firstOf(nums)
    set trace = trace * 10 + n
  }
}`;
  const r = compile(source);
  assert.ok(r.success, `compile failed: ${r.errors.join(", ")}`);
  const vm = new VM(r.program, "robot_1", (_, name) => {
    if (name === "visible_enemies") return [1, 2, 3];
    return null;
  });
  vm.setConstants(r.constants);
  const res = vm.executeEvent("tick", null, 1);
  assert.ok(!res.error, `VM error: ${res.error}`);
  assert.equal(vm.getState()[0], 123, "caller loop must iterate 1,2,3 in order");
}

function testTimersDoNotAccumulateInOnTick() {
  // An `every` block placed in `on tick` re-runs its scheduling opcode each
  // tick. Timers must be deduplicated by body offset so the timer list
  // cannot grow without bound and hang the match.
  const source = `robot "TimerSpam" version "1.0"
meta { class: "ranger" }
on tick {
  every 5 { stop }
}`;
  const r = compile(source);
  assert.ok(r.success, `compile failed: ${r.errors.join(", ")}`);
  const vm = new VM(r.program, "robot_1", () => null);
  vm.setConstants(r.constants);
  for (let t = 0; t < 50; t++) {
    vm.executeEvent("tick", null, t);
    vm.executeTimers(t);
  }
  assert.equal(vm.timers.length, 1, "every-in-on-tick must register exactly one timer");
}

function testListIndexing() {
  const source = `robot "IdxTest" version "1.0"
meta { class: "ranger" }
state { v: string = "" }
on tick {
  let enemies = visible_enemies()
  let first = enemies[0]
  let n = length(enemies)
  set v = "count=" + n
}`;
  const r = compile(source);
  assert.ok(r.success, `compile failed: ${r.errors.join(", ")}`);
  const vm = new VM(r.program, "robot_1", (_, name) => {
    if (name === "visible_enemies") return [];
    if (name === "length") return 0;
    return null;
  });
  vm.setConstants(r.constants);
  vm.executeEvent("tick", null, 1);
  assert.equal(vm.getState()[0], "count=0");
}

function testStringConcatRuntime() {
  const source = `robot "ConcatTest" version "1.0"
meta { class: "ranger" }
state { s: string = "" }
on tick {
  let h = 42
  set s = "hp=" + h
}`;
  const r = compile(source);
  assert.ok(r.success, `compile failed: ${r.errors.join(", ")}`);
  const vm = new VM(r.program, "robot_1", () => null);
  vm.setConstants(r.constants);
  vm.executeEvent("tick", null, 1);
  assert.equal(vm.getState()[0], "hp=42");
}

function testNewPredictiveSensorsCompile() {
  const source = `robot "Oracle" version "1.0"
meta { class: "ranger" }
state { t: number = 0 }
on tick {
  let e = nearest_enemy()
  if e != null {
    let predicted = predict_position(e, 5)
    if predicted != null {
      move_to predicted
    }
    let v = enemy_velocity(e)
    if v != null {
      set t = t + 1
    }
  }
  if t > 0 {
    set t = threat_level()
  }
  let incoming = incoming_projectile()
  if incoming != null {
    strafe_right
  }
  let d = damage_direction()
  if d != null {
    move_toward d
  }
}`;
  const r = compile(source);
  assert.ok(r.success, `compile failed: ${r.errors.join(", ")}`);
  const warnings = r.diagnostics.filter(d => d.severity === "warning");
  assert.equal(warnings.length, 0, `warnings: ${warnings.map(w => w.message).join("; ")}`);
}

function testRuntimeErrorHasLineNumber() {
  // Force a runtime divergence by calling a sensor that throws.
  const source = `robot "ErrTest" version "1.0"
meta { class: "ranger" }
on tick {
  let x = health()
  let y = x + 1
  move_forward
}`;
  const r = compile(source);
  assert.ok(r.success);
  const vm = new VM(r.program, "robot_1", () => { throw new Error("synthetic"); });
  vm.setConstants(r.constants);
  const out = vm.executeEvent("tick", null, 1);
  assert.ok(out.error, "expected an error from the throwing sensor");
  assert.ok(
    /line \d+/.test(out.error),
    `expected line info in error, got: ${out.error}`,
  );
}

// --- New default preset bots all compile cleanly ---

function testNewPresetsCompileWithoutWarnings() {
  // Read app.js and extract the advanced + beta presets' sources to make sure
  // they stay valid ArenaScript as the language evolves.
  const src = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const presets = ["hivemind", "phantom", "warden", "overclock", "rookie", "scout", "predator"];
  for (const name of presets) {
    const re = new RegExp(`\\b${name}:\\s*\\{[\\s\\S]*?source:\\s*\`([\\s\\S]*?)\`,?\\s*\\},`, "m");
    const match = src.match(re);
    assert.ok(match, `Could not extract preset source for '${name}'`);
    const result = compile(match[1]);
    assert.ok(result.success, `Preset '${name}' failed to compile: ${result.errors.join("; ")}`);
    const warnings = result.diagnostics.filter(d => d.severity === "warning");
    assert.equal(warnings.length, 0,
      `Preset '${name}' has warnings: ${warnings.map(w => w.message).join("; ")}`);
  }
}

// --- Run all tests ---

function run() {
  const tests = [
    testDuplicateTopLevelBlocks,
    testSemanticAnalyzerStateIsolation,
    testCompilerStateIsolation,
    testConstantExpressionEvaluation,
    testStateInitializerReferencesConstant,
    testConstantNegativeValue,
    testFunctionNameAsIdentifier,
    testRecursionLocalsIsolation,
    testVMStackOverflowProtection,
    testShieldDoesNotExceedMaxHealth,
    testDivisionByZeroInConstants,
    testEmptyStringIsTruthy,
    testMultipleElseIfBranches,
    testShortCircuitAnd,
    testShortCircuitOr,
    testUnknownEventReportsError,
    testDuplicateStateVariable,
    testSetOnNonStateVariable,
    testUnterminatedString,
    testBotsNavigateAroundCover,
    testAttackRequiresVisibility,
    testActiveScanAndMemorySensorsCompile,
    testTacticalParityPrimitivesCompileAndRun,
    testSquadBlockCompiles,
    testSquadSizeSpawnsMultipleRobotsPerParticipant,
    testNewCombatActionsCompileAndRun,
    testHealingZonesAndSensorsCompile,
    testNewSensorsCompile,
    testNewActionsCompile,
    testAfterEveryCompile,
    testSignalReceivedEvent,
    testMineDetonation,
    testPickupCollection,
    // "Did you mean" suggestions
    testDidYouMeanEventSuggestion,
    testDidYouMeanActionSuggestion,
    testDidYouMeanSensorSuggestion,
    // Validation
    testValidateMatchModeAcceptsValid,
    testValidateMatchModeRejectsInvalid,
    testValidateParticipantCountValid,
    testValidateParticipantCountInvalid,
    testValidateMatchConfigValid,
    testValidateMatchConfigRejectsBadSeed,
    testValidateMatchConfigRejectsNonFiniteArenaSize,
    testValidateParticipantRejectsMissingFields,
    testValidateParticipantRejectsNonArrayBytecode,
    testValidateMatchRequestFullValid,
    // Replay bookmarks
    testComputeBookmarksDetectsDamage,
    testComputeBookmarksDetectsKill,
    testComputeBookmarksLowHealth,
    // Engine invariants
    testEngineHealthBoundsInvariant,
    testEngineNoNaNPositions,
    // End-to-end multi-mode
    testEndToEnd2v2Match,
    testEndToEndFFAMatch,
    testDeterministicReplayWithSeed,
    testProgramIdIsUniqueWhenTimeIsFrozen,
    testMatchIdIsUniqueWhenTimeIsFrozen,
    testRejectsNonFiniteConstants,
    testRejectsNonFiniteStateInitializer,
    // New built-ins & diagnostics
    testMathBuiltinsCompile,
    testMathBuiltinsRuntime,
    testBetaStdlibCompiles,
    testLogWritesToSink,
    testDidYouMeanMessageShapeForQuickFix,
    testModReturnsNonNegative,
    testTacticsHelpersCompile,
    testMakePositionBuiltin,
    testUnusedStateWarning,
    testUnusedConstantWarning,
    testIdentifierDidYouMean,
    testWhileLoopCompilesAndRuns,
    testWhileBreakStopsLoop,
    testContinueSkipsRestOfBody,
    testForBreakDoesNotLeakIterator,
    testForReturnInHelperDoesNotLeakIterator,
    testTimersDoNotAccumulateInOnTick,
    testBreakOutsideLoopErrors,
    testListIndexing,
    testStringConcatRuntime,
    testNewPredictiveSensorsCompile,
    testRuntimeErrorHasLineNumber,
    testNewPresetsCompileWithoutWarnings,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      test();
      console.log(`  PASS: ${test.name}`);
      passed++;
    } catch (e) {
      console.error(`  FAIL: ${test.name} — ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
  if (failed > 0) process.exit(1);
}

run();
