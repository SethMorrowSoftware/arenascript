# ArenaScript

A deterministic robot arena combat engine with a custom domain-specific language (DSL) for programming autonomous robot behaviors. Write code in the ArenaScript language, compile it to bytecode, and watch your bots fight in a live arena visualization.

> **Engine v0.2 · Language v1.1** — Adds `while` loops, list indexing (`list[i]`),
> runtime string concatenation, predictive perception sensors
> (`predict_position`, `incoming_projectile`, `damage_direction`,
> `threat_level`), better runtime error messages with source-line info,
> an in-app command palette (Ctrl+K), language reference drawer (Ctrl+/),
> keyboard shortcut help (Shift+?), match-simulation loading overlay,
> local match history, and two new reference bots (Oracle, Zealot)
> showcasing the new features.

## Features

### Language (v1.1)
- **Custom DSL** — lexer, parser, semantic analyzer, bytecode compiler
- **Sandboxed VM** — stack-based bytecode interpreter with budget metering (no runaway loops)
- **`while` loops** with `break` / `continue`
- **List indexing** (`list[i]`, supports negative indices, out-of-bounds returns `null`)
- **String concatenation** via `+` when either side is a string
- **Runtime errors carry source line/column info**, surfaced in diagnostics

### Engine (v0.2)
- **Deterministic** multi-phase tick loop with seeded PRNG for reproducible matches
- **Resource economy** — heat + ammo + energy + HP create strategic tradeoffs every tick
- **Predictive perception** — `enemy_velocity`, `predict_position`, `incoming_projectile`,
  `damage_direction`, `threat_level` let bots lead shots and dodge
- **Resupply depots** — contested neutrals that refill ammo and vent heat
- **Information warfare** — cloaking with break-on-damage/attack + directional scan
- **Hive memory** — shared team key/value store for squad coordination
- **Advanced combat** — light/heavy projectiles, short-range zap, armed self-destruct
- **6 hand-crafted arenas** — Crucible, Inferno, Fortress, Gauntlet, Plains, and
  the radially-symmetric free-for-all arena, The Nexus
- **4 robot classes** — Brawler, Ranger, Tank, Support with distinct stats & heat profiles
- **Match formats** — 1v1, 2v2, 3v3, 4v4, 5v5 team battles and battle royale
  (free-for-all, up to 20 bots, last one standing)

### UI
- **Team Builder** — assemble custom rosters: two squads (up to 5v5) or a
  battle royale field of up to 20, fielding your own editor bot, presets, or
  library bots, with one-click auto-fill
- **Match broadcast mode** — when a match runs the arena takes over the screen
  with a cinematic intro, a broadcast scoreboard, and a live combatant HUD
  (per-team rosters with real-time HP bars)
- **Match scorecard** — winner banner + team comparison, revealed when the
  replay finishes so the live match stays spoiler-free
- **Command palette** (Ctrl+K) — jump between bots, views, docs, and actions
- **Keyboard shortcut help** (Shift+?) — full binding reference in-app
- **Language reference drawer** (Ctrl+/) — searchable, sectioned quick-lookup
- **Match loading overlay** — visible progress during simulation
- **Match history panel** — recent runs persisted to localStorage
- **Live arena rendering** — bots, projectiles, hazards, depots, control points, cover, pickups
- **Replay system** — scrubber, bookmarks (1st damage / 1st kill), variable speed

### Competitive infrastructure
- **Ranked** — Elo-based matchmaking, Bronze → Champion tiers
- **Tournaments** — single-elim, round-robin, Swiss formats
- **PHP backend** — matchmaking, lobbies, rankings, tournaments

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla JavaScript (ES2022 modules), HTML, CSS |
| Backend | PHP |
| Build | None required - runs directly in the browser |

No build tools, no bundlers, no package managers needed.

## Quick Start

1. Serve the project with any web server:
   ```bash
   # PHP built-in server
   php -S localhost:8000

   # Python
   python3 -m http.server 8000

   # Node.js (npx)
   npx serve .
   ```

2. Open `http://localhost:8000` in your browser

3. Select a bot preset or write your own ArenaScript program

4. Click **Compile**, then **Run Match**

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Compile |
| `Ctrl+Shift+Enter` | Compile & run match |
| `Ctrl+S` | Save current editor program to library |
| `Ctrl+K` | Command palette |
| `Ctrl+/` | Open language reference |
| `Shift+?` | Show keyboard shortcut help |
| `Tab` | Insert 2 spaces in editor |
| `Space` | Play / pause replay (in Arena view) |
| `←` / `→` | Step replay frame (in Arena view) |
| `Esc` | Close modal / exit full-screen match |

## Project Structure

```
arenascript/
├── index.html              # Landing / marketing front page
├── app.html                # Single-page app (builder, arena, library, ...)
├── learn.html              # Step-by-step ArenaScript tutorial
├── community.html          # Public bot gallery (standalone page)
├── css/
│   └── style.css           # Dark theme UI stylesheet
├── js/
│   ├── app.js              # Main frontend application
│   ├── demo.js             # Node.js CLI demo
│   ├── lang/               # DSL compiler pipeline
│   │   ├── tokens.js       # Lexer / tokenizer
│   │   ├── ast.js          # AST node definitions
│   │   ├── parser.js       # Recursive descent parser
│   │   ├── semantic.js     # Type checking & scope resolution
│   │   ├── compiler.js     # AST → bytecode compiler
│   │   └── pipeline.js     # High-level compile orchestrator
│   ├── runtime/            # Bytecode execution
│   │   ├── opcodes.js      # Instruction set definitions
│   │   ├── vm.js           # Stack-based bytecode VM
│   │   └── budget.js       # Execution budget accounting
│   ├── engine/             # Simulation engine
│   │   ├── world.js        # World state (entities, positions, health)
│   │   ├── tick.js         # 11-phase tick loop (core game loop)
│   │   ├── actions.js      # Action intent collection
│   │   ├── sensors.js      # Perception layer (fog-of-war)
│   │   ├── movement.js     # Movement & AABB collision detection
│   │   ├── combat.js       # Attack resolution & damage
│   │   ├── los.js          # Line-of-sight computation
│   │   ├── events.js       # Event generation & dispatch
│   │   └── replay.js       # Deterministic replay writer/reader
│   ├── server/             # Competitive systems
│   │   ├── matchmaking.js  # Queue management & Elo pairing
│   │   ├── ranked.js       # Elo ratings & rank tiers
│   │   ├── tournament.js   # Tournament brackets
│   │   ├── match-runner.js # Server-side match execution
│   │   └── lobby.js        # Multiplayer lobby management
│   └── shared/             # Common utilities
│       ├── config.js       # Game balance constants
│       ├── types.js        # Core type definitions
│       ├── prng.js         # Seeded deterministic PRNG
│       └── vec2.js         # 2D vector math
└── api/                    # PHP backend endpoints
    ├── config.php          # Game configuration
    ├── matchmaking.php     # Queue management & pairing
    ├── ranked.php          # Elo rating calculations
    ├── tournament.php      # Tournament bracket generation
    ├── match-runner.php    # Match execution & result storage
    └── lobby.php           # Lobby creation & joining
```

## ArenaScript Language

ArenaScript is a domain-specific language for programming robot behaviors. Programs are event-driven: you define handlers that execute each tick.

### Program Structure

```
robot "MyBot" version "1.0"

meta {
  author: "YourName"
  class: "brawler"
}

const {
  ENGAGE_RANGE = 8
}

state {
  mode: string = "hunt"
}

on spawn {
  set mode = "hunt"
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
    move_to nearest_control_point()
  }
}

on damaged(event) {
  set mode = "fight"
}
```

### Language Features

| Feature | Description |
|---------|-------------|
| **Types** | `number`, `boolean`, `string`, `id`, `vector`, `position`, `list<T>`, nullable `T?` |
| **Declarations** | `let` for locals, `set` for state mutations, `const` for constants, `state` block for persistent vars |
| **Control Flow** | `if`/`else if`/`else`, `for`...`in` loops, `return`, `after`/`every` timer blocks |
| **Operators** | `+`, `-`, `*`, `/`, `%`, `==`, `!=`, `<`, `>`, `<=`, `>=`, `and`, `or`, `not` |
| **Events** | `on spawn`, `on tick`, `on damaged`, `on low_health`, `on destroyed`, `on enemy_seen`, `on enemy_lost`, `on cooldown_ready`, `on signal_received` |
| **Movement** | `move_to`, `move_toward`, `move_forward`, `move_backward`, `turn_left`, `turn_right`, `strafe_left`, `strafe_right`, `stop`, `retreat` |
| **Combat** | `attack`, `fire_at`, `fire_light`, `fire_heavy`, `burst_fire`, `grenade`, `zap`, `shield`, `vent_heat` |
| **Utility** | `cloak`, `self_destruct`, `place_mine`, `send_signal`, `mark_position`, `taunt`, `overwatch`, `capture`, `ping` |
| **Perception sensors** | `nearest_enemy`, `visible_enemies`, `scan`, `scan_enemies`, `last_seen_enemy`, `enemy_heading`, `is_enemy_facing_me`, `nearest_ally`, `visible_allies`, `nearest_sound` |
| **Resource sensors** | `health`, `energy`, `heat`, `ammo`, `heat_percent`, `ammo_percent`, `overheated` |
| **State sensors** | `is_cloaked`, `cloak_remaining`, `self_destruct_armed`, `self_destruct_remaining`, `is_taunted`, `is_in_overwatch`, `has_effect` |
| **Map sensors** | `nearest_depot`, `is_on_depot`, `nearest_control_point`, `nearest_cover`, `nearest_heal_zone`, `nearest_hazard`, `nearest_mine`, `nearest_pickup` |
| **Team memory** | `hive_get(key)`, `hive_set(key, value)`, `hive_has(key)` — shared per-team key/value store |
| **Functions** | `fn name(params) { ... }` for custom helper functions |

See [docs/language-reference.md](docs/language-reference.md) for the full sensor and command reference with examples.

### Robot Classes

| Class | HP | Energy | Speed | Damage | Range | Ammo | Heat Dissipation | Playstyle |
|-------|---:|-------:|------:|-------:|------:|-----:|-----------------:|-----------|
| **Brawler** | 120 | 80 | 2.2 | 14 | 3.5 | 50 | 2.2x (fastest) | Aggressive melee, rarely overheats |
| **Ranger** | 80 | 100 | 2.0 | 10 | 8.0 | 100 | 1.0x (baseline) | Ranged kiting, largest ammo pool |
| **Tank** | 150 | 60 | 1.5 | 8 | 4.0 | 80 | 0.7x (slowest) | Defensive holding, overheats fast |
| **Support** | 90 | 120 | 1.8 | 6 | 6.0 | 70 | 1.5x | Team support, good heat management |

### Resource Economy

Beyond HP and energy, every combat action feeds into a **heat + ammo** resource model:

- **Heat** builds from firing and ability use. At 100 the robot is *overheated* and cannot fire until it cools below 60.
- **Ammo** is finite per-spawn and only refills at **resupply depots** placed neutrally in the middle of each arena.
- **Melee attack** and **zap** cost no ammo — close-quarters options when ranged runs dry.
- **vent_heat** trades the combat slot this tick for aggressive cooling.

This creates a constant "fight-now vs. retreat-to-resupply vs. conserve-and-cool" decision loop that runs on top of normal positioning and target selection.

## Engine Architecture

The simulation runs a deterministic multi-phase tick loop. Each tick processes, in order:

1. **Cooldown + heat update** — decrement cooldowns, decay heat, handle overheat recovery, upkeep cloak
2. **Timer execution** — fire any elapsed `after` / `every` blocks
3. **Pickup spawn + effect expiry + noise decay** — passive world tick
4. **VM execution** — run each robot's `on tick` handler and collect intents
5. **Movement resolution** — apply velocity, resolve collisions
6. **Combat resolution** — attacks, projectile spawns, noise emission
7. **Mine detonation + pickup collection**
8. **Damage & effects** — advance projectiles, apply heal/hazard zones, apply resupply depots, resolve armed self-destructs
9. **Discovery + signal dispatch + control point capture**
10. **Event dispatch** — fire `damaged` / `low_health` / `destroyed` / etc. handlers
11. **Replay capture + win condition check** (with sudden-death timeout resolution)

See [docs/architecture.md](docs/architecture.md) for full details on each phase.

### Key Constants

| Setting | Value |
|---------|-------|
| Arena Size | 140 x 140 units |
| Tick Rate | 30 ticks/sec |
| Max Match Duration | 3000 ticks (100 seconds) + up to 900 ticks sudden death |
| CPU Budget | 1000 instructions/tick/robot |
| LOS Range | 150 units |
| Heat Cap | 100 (recovery threshold 60) |

## Ranked System

The competitive system uses Elo ratings with the following tiers:

| Tier | Rating |
|------|-------:|
| Bronze | 0+ |
| Silver | 1000+ |
| Gold | 1200+ |
| Platinum | 1400+ |
| Diamond | 1600+ |
| Champion | 1800+ |

K-factor is 32 for ratings below 2400, and 16 above.

## PHP API

The backend provides REST endpoints for multiplayer features:

| Endpoint | Purpose |
|----------|---------|
| `api/config.php` | Retrieve game balance configuration |
| `api/matchmaking.php` | Enqueue players and find Elo-based pairings |
| `api/ranked.php` | Calculate and update Elo ratings |
| `api/tournament.php` | Generate brackets (single-elim, round-robin, Swiss) |
| `api/match-runner.php` | Execute matches server-side and store results |
| `api/lobby.php` | Create/join lobbies, supports 1v1, 2v2, and FFA modes |

## Deployment

### cPanel / Shared Hosting

ArenaScript is designed to drop straight into a cPanel `public_html` directory,
including into a **subdirectory** such as `public_html/arenascript/`.

1. Upload the project contents into the target directory (root or subdirectory).
2. Ensure the host runs **PHP 8.1 or newer** (uses `strict_types`, `mixed`,
   `never` return types, Argon2id password hashing).
3. In cPanel, create a MySQL database + user and grant the user full
   privileges on that database.
4. Visit `api/install.php` in a browser (locally, or after temporarily setting
   `ARENA_ALLOW_INSTALLER=1` in the host's environment). Fill in the DB
   credentials and the admin account — the installer writes `api/.env.local`,
   runs the migrations, and creates the admin user.
5. **Delete `api/install.php`** after a successful install. The installer
   self-locks via `api/.installed.lock`, but removing the file entirely is
   safer.
6. Confirm the app loads and that you can sign in. API calls resolve their
   base URL dynamically from the module location (`import.meta.url`), so the
   app will work whether it's at `https://example.com/` or
   `https://example.com/arenascript/`.

The shipped `api/.htaccess` blocks direct web access to `.env.local`,
`.installed.lock`, `.storage/`, and `.sql` migration files. If your host
runs `AllowOverride None`, the PHP bootstrap also drops a secondary
`.htaccess` and an empty `index.html` into `api/.storage/` at runtime as
defense in depth.

### Production Hardening Checklist

Before opening beta to real users:

- [ ] Set `ARENA_CORS_ORIGIN` to your real origin (e.g.
      `https://arena.example.com`). The default `*` is only safe for local dev.
- [ ] Set `ARENA_DB_ENABLED=1` and confirm DB credentials are populated.
- [ ] Delete `api/install.php` after first-time setup.
- [ ] Force HTTPS at the web server or in cPanel (Let's Encrypt + redirect).
- [ ] Verify `api/.env.local` is mode 0600 (`chmod 600 api/.env.local`).

## License

All rights reserved.
