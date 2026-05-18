# API Reference

Documentation for the PHP backend API and JavaScript module APIs.

## PHP Backend (`api/`)

The PHP backend provides server-authoritative implementations for multiplayer features. All endpoints use `require_once` for dependency management and share constants from `config.php`.

### config.php

Shared game balance constants mirroring `js/shared/config.js`. Included by all other API files.

Key constants:
- Arena: `ARENA_WIDTH`, `ARENA_HEIGHT`
- Tick: `TICK_RATE`, `MAX_TICKS`
- Combat: `ATTACK_DAMAGE`, `ATTACK_RANGE`, `ATTACK_COOLDOWN`
- Budget: `BUDGET_INSTRUCTIONS`, `BUDGET_FUNCTION_CALLS`, `BUDGET_SENSOR_CALLS`
- Ranked: `INITIAL_ELO`, `ELO_K_FACTOR`, `RANK_THRESHOLDS`
- Classes: `CLASS_STATS` (brawler, ranger, tank, support)

### ranked.php

Elo rating system with rank tier progression.

**Functions:**

| Function | Parameters | Returns | Description |
|----------|-----------|---------|-------------|
| `expectedScore` | `$ratingA`, `$ratingB` | `float` | Standard Elo expected score |
| `getKFactor` | `$rating` | `int` | K-factor (32 or 16 for >2400) |
| `calculateEloChange` | `$winnerRating`, `$loserRating` | `array` | New ratings and deltas |
| `getRankTier` | `$rating` | `string` | Rank name for rating |

**RatingStore class:**

| Method | Description |
|--------|-------------|
| `getRating($playerId)` | Get player's current Elo rating |
| `setRating($playerId, $rating)` | Update player's rating |
| `getLeaderboard($limit)` | Top players by rating |

### matchmaking.php

Elo-based queue management and pairing.

**Constants:**
- `ELO_RANGE_BASE` = 100 (initial search range)
- `ELO_RANGE_EXPANSION_PER_SEC` = 10 (range grows over time)
- `MAX_ELO_RANGE` = 500

**MatchmakingQueue class:**

| Method | Description |
|--------|-------------|
| `enqueue($playerId, $program, $constants, $mode)` | Add player to queue |
| `dequeue($playerId)` | Remove player from queue |
| `findMatch()` | Find a valid Elo-range pairing |
| `getQueueSize()` | Current queue length |

### tournament.php

Tournament bracket generation supporting three formats.

**SeededRNG class:** Deterministic PRNG matching the JavaScript implementation for reproducible brackets.

**TournamentManager class:**

| Method | Description |
|--------|-------------|
| `createTournament($name, $format, $participants, $seed)` | Create a new tournament |
| `advanceMatch($tournamentId, $matchId, $winnerId)` | Record match result |
| `getTournament($tournamentId)` | Get tournament state |

**Supported formats:**
- `single_elimination` - Standard bracket, losers eliminated
- `round_robin` - Every participant plays every other
- `swiss` - Swiss-system pairing by current standings

### match-runner.php

Server-side match execution and result storage.

**MatchRunner class:**

| Method | Description |
|--------|-------------|
| `runRankedMatch($request)` | Execute 1v1 ranked orchestration and apply Elo updates |
| `runUnrankedMatch($request)` | Execute unranked two-player orchestration |
| `runUnrankedMatchWithParticipants($request)` | Execute unranked match with any participant count |
| `getMatchHistory($limit)` | Retrieve recent match records |
| `getReplay($matchId)` | Retrieve stored replay payload by id |
| `getMatchCount()` | Return number of recorded matches |

Notes:
- The PHP class currently uses a `runMatchEngine()` hook stub for actual simulation execution.
- `runRankedMatch()` applies Elo only when mode is `1v1_ranked`.

### lobby.php

Multiplayer lobby lifecycle management.

**LobbyManager class:**

| Method | Description |
|--------|-------------|
| `createLobby($hostId, $name, $mode)` | Create a new lobby |
| `joinLobby($lobbyId, $playerId)` | Join an existing lobby |
| `leaveLobby($lobbyId, $playerId)` | Leave a lobby |
| `submitProgram($lobbyId, $playerId, $program, $constants)` | Submit compiled bot and mark player ready |
| `startMatch($lobbyId)` | Start the match when ready |
| `listLobbies()` | Get all open lobbies |
| `getLobby($id)` | Get lobby data by id |

**Supported modes:**
- `1v1_unranked` (2 players)
- `1v1_ranked` (2 players)
- `2v2` (4 players)
- `ffa` (up to 8 players)

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
