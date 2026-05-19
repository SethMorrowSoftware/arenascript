# API Reference

Documentation for the PHP backend API and JavaScript module APIs.

## PHP Backend (`api/`)

The backend is a single MySQL-backed API under `api/v1/*`, using bearer-token
sessions. The full endpoint reference — auth, bots, matches, leaderboard,
lobbies, admin — lives in **[api/README.md](../api/README.md)**.

Match results are reported by the client (the deterministic engine runs in
the browser); the server validates structure and blocks obvious abuse but
does not re-run the simulation. Matchmaking-queue pairing and tournament
bracket generation run client-side in `js/server/` — see the JavaScript
module APIs below.

---

## JavaScript Modules (`js/`)

### Compilation Pipeline

```javascript
import { compile } from "./lang/pipeline.js";

const result = compile(sourceCode);

if (result.success) {
  // result.program   - CompiledProgram object
  // result.constants - Constant pool array
  // result.diagnostics - Warning diagnostics
} else {
  // result.errors - Array of error message strings
  // result.diagnostics - Error and warning diagnostics
}
```

### Match Execution

```javascript
import { runMatch } from "./engine/tick.js";

const result = runMatch({
  config: {
    mode: "1v1_ranked",
    arenaWidth: 100,
    arenaHeight: 100,
    maxTicks: 3000,
    tickRate: 30,
    seed: 12345,
  },
  participants: [
    {
      program: compiledProgram1,
      constants: constants1,
      playerId: "player1",
      teamId: 0,
    },
    {
      program: compiledProgram2,
      constants: constants2,
      playerId: "player2",
      teamId: 1,
    },
  ],
});

// result.winner     - Winning team index (0, 1) or null for draw
// result.reason     - Win condition string
// result.tickCount  - Total ticks played
// result.replay     - Replay data with frames array
// result.robotStats - Map of robot stats (damageDealt, damageTaken, kills)
```

Before calling `runMatch`, validate payloads with:

```javascript
import { validateMatchRequest } from "./shared/validation.js";

const validation = validateMatchRequest(request);
if (!validation.valid) {
  console.error(validation.errors);
}
```

Validation rejects invalid mode/count combinations and malformed config values including non-finite arena dimensions.

### Replay Data

Each replay frame contains the full simulation state for that tick:

```javascript
{
  tick: number,
  robots: [
    {
      id: string,
      teamId: number,
      robotClass: string,
      position: { x: number, y: number },
      heading:  { x: number, y: number },
      health: number,
      energy: number,
      heat: number,
      ammo: number,
      overheated: boolean,
      cloaked: boolean,
      selfDestructing: boolean,
      alive: boolean,
      action: ActionIntent | undefined,
    }
  ],
  projectiles: [ { id, position } ],
  mines: [ { id, teamId, position } ],
  pickups: [ { id, type, position } ],
  covers: [ { id, x, y, w, h, destructible, health } ],
  controlPoints: [ { id, owner, captureProgress } ],
  events: Event[],
  traces: DecisionTrace[],  // optional — one per robot per tick
}
```

The replay's metadata also includes the arena layout (covers, control
points, heal zones, hazards, and **depots**) captured once at match start:

```javascript
replay.metadata.arenaLayout = {
  covers:         [...],
  controlPoints:  [...],
  healingZones:   [...],
  hazards:        [...],
  depots:         [ { x, y, radius } ],
};
```

### Configuration Constants

```javascript
import {
  ARENA_WIDTH, ARENA_HEIGHT,
  TICK_RATE, MAX_TICKS,
  ATTACK_DAMAGE, ATTACK_RANGE,
  CLASS_STATS, ENGINE_VERSION,
} from "./shared/config.js";
```

### Vector Math

```javascript
import { distance, normalize, add, subtract, scale } from "./shared/vec2.js";

const dist = distance({ x: 0, y: 0 }, { x: 3, y: 4 }); // 5
```

### Seeded PRNG

```javascript
import { SeededRNG } from "./shared/prng.js";

const rng = new SeededRNG(42);
const value = rng.next();      // float in [0, 1)
const int = rng.nextInt(1, 6); // integer in [1, 6]
```
