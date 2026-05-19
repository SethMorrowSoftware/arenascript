# Architecture Guide

Technical documentation for the ArenaScript engine internals.

## Overview

ArenaScript is composed of four layers:

```
┌──────────────────────────────────────────────┐
│  Frontend (index.html, css/, js/app.js)      │  Browser UI
├──────────────────────────────────────────────┤
│  Language Pipeline (js/lang/)                │  Source → Bytecode
├──────────────────────────────────────────────┤
│  Runtime (js/runtime/)                       │  Bytecode VM
├──────────────────────────────────────────────┤
│  Engine (js/engine/)                         │  Simulation
├──────────────────────────────────────────────┤
│  Server / API (js/server/, api/)             │  Competitive Systems
└──────────────────────────────────────────────┘
```

---

## Language Pipeline (`js/lang/`)

The compiler transforms ArenaScript source code into bytecode through four stages.

### 1. Lexer (`tokens.js`)

Converts source text into a token stream. Handles keywords, literals (numbers,
strings, booleans, null), operators, punctuation, and comments.

### 2. Parser (`parser.js`)

Recursive-descent parser with Pratt-style expression parsing. Produces an AST
of `Program`, `MetaBlock`, `ConstBlock`, `SquadBlock`, `StateBlock`,
`EventHandler`, `FunctionDecl`, statements (`Let`, `Set`, `If`, `For`,
`Return`, `Action`, `After`, `Every`, `Expression`), and expression nodes.

Action keywords are kept in a dedicated set so the parser can distinguish
`attack enemy` (action statement) from `attack()` (call expression).

### 3. Semantic Analyzer (`semantic.js`)

Validates the AST for correctness:

- Unique robot/meta/squad/const/state blocks
- Valid class names, squad sizes and roles
- Scope resolution for constants, state, and locals
- Validated event handler names (`spawn`, `tick`, `damaged`, `low_health`,
  `enemy_seen`, `enemy_lost`, `cooldown_ready`, `destroyed`, `signal_received`)
- Validated action names and sensor names (with "did you mean" suggestions)
- Function signatures and duplicate detection

Outputs a diagnostic list of errors and warnings.

### 4. Compiler (`compiler.js`)

Transforms the validated AST into a compact bytecode program:

- Emits stack-based opcodes (see `runtime/opcodes.js`)
- Builds a constant pool for literals and strings
- Maps event handlers and user functions to bytecode entry points
- Produces a `CompiledProgram` object consumed by the VM

### Pipeline Orchestrator (`pipeline.js`)

The `compile(source)` function runs all four stages in sequence and returns
`{ success, program, constants, diagnostics, errors }`.

### Shared Validation (`js/shared/validation.js`)

Match setup data is validated before execution via
`validateMatchMode`, `validateParticipantCount`, `validateMatchConfig`,
`validateParticipant`, and `validateMatchRequest`. Arena dimensions must be
finite and positive (NaN/Infinity rejected).

---

## Runtime (`js/runtime/`)

### Opcodes (`opcodes.js`)

Stack-based instruction set: stack manipulation, arithmetic, comparison,
control flow, variable load/store, function calls, builtin/sensor dispatch,
and action emission.

### VM (`vm.js`)

Stack-based bytecode interpreter:

- Fetch-decode-execute loop with instruction budget accounting
- Operand stack and local-variable window per call frame
- Sensor gateway injection for world queries (`CALL_BUILTIN` opcode)
- Action intent emission (`Op.ACTION`) — builds typed intent objects
- Event dispatch — jumps to bytecode entry points for event handlers
- Timer scheduling for `after` / `every` blocks

### Budget System (`budget.js`)

Per-tick execution limits prevent infinite loops and ensure fairness:

| Resource | Limit |
|----------|------:|
| Instructions | 1,000 |
| Function calls | 50 |
| Sensor calls | 30 |
| Memory operations | 200 |

Exceeding a budget halts that robot for the current tick only (non-fatal).

---

## Simulation Engine (`js/engine/`)

### World Model (`world.js`)

Manages all game state:

- `robots` — position, heading, health, energy, cooldowns, team, class, plus
  extended state: heat, ammo, cloak, overwatch, taunt, mines placed, active
  pickup effects, self-destruct countdown, waypoint memory, discovery memory
- `projectiles` — owner, position, velocity, damage, TTL
- `controlPoints` — capture points with owner and progress
- `covers` — static or destructible AABB obstacles
- `healingZones` / `hazards` — passive effect zones
- `mines` — placed proximity mines
- `pickups` — randomly spawned power-ups
- `depots` — **resupply depots** (refill ammo, vent heat)
- `noiseEvents` — recent audio cues (attacks, movement, grenades)
- `pendingSignals` — squad communications awaiting dispatch
- `hiveMemory` — per-team shared key/value store (`hive_set` / `hive_get`)

### Tick Loop (`tick.js`)

The core game loop runs a deterministic multi-phase tick. Each tick executes
the following phases in fixed order:

```
Phase 1    Cooldown update        - decrement all cooldowns; heat decay;
                                    overheat recovery; cloak upkeep
Phase 1b   Timer execution        - run any fired after/every blocks
Phase 1c   Pickup spawn           - periodic random pickup generation
Phase 1d   Effect expiry          - expire taunts, overwatch, pickup effects
Phase 1e   Noise decay            - prune old noise events

Phase 2-4  VM execution           - build sensor views, run tick handlers,
                                    collect movement/combat/utility intents
Phase 5    Movement resolution    - compute next positions
Phase 6    Movement apply         - apply movement + resolve collisions
Phase 7    Combat resolution      - attacks, projectile spawns, noise emit
Phase 7b   Mine detonation        - check mine trigger radii
Phase 7c   Pickup collection      - apply pickup effects
Phase 8    Damage & effects       - advance projectiles, heal/hazard zones,
                                    resupply depots, self-destruct detonation
Phase 8b   Discovery memory       - update each robot's map-feature memory
Phase 8c   Signal dispatch        - deliver pending squad signals
Phase 8d   Control point update   - process capture progress

Phase 9    Event dispatch         - fire damaged/low_health/destroyed/
                                    cooldown_ready/signal_received handlers
Phase 10   Replay capture         - record frame snapshot
Phase 11   Win condition check    - elimination / mutual destruction /
                                    sudden-death timeout resolution
```

`runMatch(setup)` runs ticks until a win condition is met or the absolute
tick cap (standard time + sudden death) is reached.

**Win conditions:**

- Elimination — only one team has alive robots remaining
- Mutual destruction — no teams have alive robots
- Timeout / sudden death — after `maxTicks` every alive robot takes
  1 damage per tick until a team is eliminated or the hard cap is hit.
  Ties are resolved by alive count → total HP → damage dealt → control
  points owned.

### Movement (`movement.js`)

Resolves movement intents into velocity updates, applies position changes,
handles robot-vs-robot and robot-vs-cover collisions via AABB tests, and
respects class-specific move speeds and arena bounds.

### Combat (`combat.js`)

Resolves all combat actions and manages the resource economy:

- **Weapons**: `attack` (melee), `fire_at` (standard ranged), `fire_light`
  (fast/weak/long-range), `fire_heavy` (slow/strong), `burst_fire` (3-shot
  spread), `grenade` (AoE), `zap` (short-range energy discharge with
  self-damage), `shield` (self-heal), `vent_heat` (trades combat slot for
  aggressive cooling)
- **Ammo**: every projectile weapon consumes ammo. Melee `attack` and `zap`
  are ammo-free. Running out of ammo disables projectile weapons until the
  robot visits a resupply depot.
- **Heat**: every combat action generates heat. At `HEAT_MAX` (100) the robot
  becomes **overheated** and cannot fire until heat drops below
  `HEAT_RECOVERY_THRESHOLD` (60). Each class has a different
  `heatDissipation` multiplier.
- **Projectile simulation**: `updateProjectiles` advances positions each
  tick, checks LOS-blocking cover hits, checks enemy-robot hits (friendly
  fire disabled), and applies damage + TTL decay.
- **Cloak state**: taking damage immediately breaks cloak; any offensive
  action also breaks cloak via `breakCloak()`.
- **Cooldown update**: decrements all per-action cooldowns, regenerates
  energy by 1/tick, applies heat decay (with optional extra cooling from
  `vent_heat`), toggles overheat recovery, and handles cloak energy drain
  and expiry.

### Line of Sight & Visibility (`los.js`)

- Ray-vs-AABB LOS tests against all cover objects
- Per-class vision range with pickup / overwatch bonuses
- Cloaked enemies are filtered out beyond `CLOAK_BREAK_DISTANCE` (4 units)
  from `getVisibleEnemies`, so `nearest_enemy`, `visible_enemies`, and
  `scan` all respect cloak

### Sensors (`sensors.js`)

Read-only gateway between robot VMs and the world (with a handful of
intentional side-effectful writes for `hive_set`). Provides 60+ sensors:

- Self: `health`, `energy`, `heat`, `ammo`, `overheated`, `is_cloaked`,
  `self_destruct_armed`, `kills`, `time_alive`, etc.
- Perception: `nearest_enemy`, `visible_enemies`, `scan`, `scan_enemies`,
  `last_seen_enemy`, `has_recent_enemy_contact`, `enemy_heading`,
  `is_enemy_facing_me`
- Allies & squad: `nearest_ally`, `visible_allies`, `ally_health`,
  `team_size`, `my_index`, `my_role`
- Map features (discovery-based): `nearest_cover`, `nearest_heal_zone`,
  `nearest_hazard`, `nearest_control_point`, `nearest_depot`, `is_on_depot`
- Hive memory: `hive_get`, `hive_set`, `hive_has`
- Audio/memory: `nearest_sound`, `recall_position`, `discovered_count`
- Geometry: `distance_to`, `angle_to`, `is_facing`, `line_of_sight`,
  `wall_ahead`, `arena_width`, `arena_height`, `spawn_position`
- Utility: `random`, `current_tick`, `has_effect`

### Actions (`actions.js`)

Collects, validates, and categorizes robot action intents:

- Movement slot: `move_*`, `turn_*`, `strafe_*`, `stop`, `retreat`
- Combat slot: `attack`, `fire_at`, `fire_light`, `fire_heavy`, `burst_fire`,
  `grenade`, `zap`, `shield`, `vent_heat`, `use_ability`
- Utility slot: `place_mine`, `send_signal`, `mark_position`, `taunt`,
  `overwatch`, `cloak`, `self_destruct`

At most one of each category executes per tick. Validation checks
cooldowns, energy, ammo, and overheat state; invalid intents are silently
dropped.

### Events (`events.js`)

Generates reactive events dispatched to `on` handlers:

- `spawn`, `tick` — lifecycle
- `damaged` — robot took damage (with source + amount)
- `low_health` — HP crossed `LOW_HEALTH_THRESHOLD` from above
- `destroyed` — HP reached 0
- `cooldown_ready` — a tracked cooldown reached 0
- `enemy_seen` / `enemy_lost` — visibility transitions
- `signal_received` — ally broadcast delivered

### Replay (`replay.js`)

Captures full deterministic match state:

- Per-frame: every robot's position, heading, HP, energy, heat, ammo,
  overheat/cloak/self-destruct flags, plus projectiles, mines, pickups,
  covers (destructible HP), control points, events, and decision traces
- Arena layout (once): covers, control points, healing zones, hazards,
  resupply depots
- `validateReplayDeterminism` can verify two replays produced by the same
  inputs are bit-identical for position/health/energy

---

## Competitive Systems

### Client-Side (`js/server/`)

JavaScript implementations of competitive features that can run in the browser:

- **matchmaking.js** — Elo-based queue pairing with expanding search range
- **ranked.js** — Elo rating calculations and rank tier assignment
- **tournament.js** — Bracket generation (single elimination, round robin, Swiss)
- **match-runner.js** — Match orchestration wrapping the tick engine
- **lobby.js** — Multiplayer lobby management (1v1, 2v2, FFA)

### Server-Side (`api/`)

A single MySQL-backed PHP API under `api/v1/*`, using bearer-token sessions:

- **config.php** — Shared game balance constants (also `GET /api/config.php`)
- **_bootstrap.php** — Shared HTTP helpers: CORS, JSON I/O, error handling,
  rate limiting
- **db.php** — MySQL connection and bearer-session authentication
- **v1/auth/** — Register, log in/out, current user
- **v1/bots/** — Saved bots and versions
- **v1/matches/report.php** — Match result reporting + Elo update
- **v1/leaderboard.php**, **v1/lobbies/**, **v1/admin/** — Ranked board,
  lobbies, admin tooling
- **install.php** — One-time shared-hosting installer

Match results are reported by the client; the server validates structure
and blocks obvious abuse but does not re-run the simulation. Matchmaking
pairing and tournament brackets run client-side (`js/server/`).

---

## Determinism

The engine is fully deterministic. Given the same compiled programs,
configuration, and seed, every match produces identical frames. This is
achieved through:

1. **Seeded PRNG** (`shared/prng.js`) — all randomness uses a deterministic seed
2. **Fixed-order processing** — robots, projectiles, and zones are iterated
   in consistent order every tick
3. **Careful numeric handling** — vector math is monomorphic and avoids
   non-deterministic ordering
4. **Replay verification** — the replay system can re-run a match and
   bit-compare frames via `validateReplayDeterminism`

---

## Configuration (`shared/config.js`)

All game balance constants live in a single file: arena dimensions, tick
rate, robot class stats (including `maxAmmo` and `heatDissipation`), combat
values, heat/ammo costs per weapon, resupply depot rates, cloak parameters,
zap and self-destruct constants, pickup effects, signal ranges, budget
limits, and ranked system parameters. The PHP backend mirrors the subset it
needs in `api/config.php`.
