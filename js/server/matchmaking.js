// ============================================================================
// Matchmaking — Elo-based queue pairing
// ============================================================================
import { ARENA_WIDTH, ARENA_HEIGHT, MAX_TICKS, TICK_RATE } from "../shared/config.js";
import { validateParticipant } from "../shared/validation.js";
import { SeededRNG } from "../shared/prng.js";
const ELO_RANGE_BASE = 100;
const ELO_RANGE_EXPANSION_PER_SEC = 10;
const MAX_ELO_RANGE = 500;
export class MatchmakingQueue {
    queue = [];
    ratingStore;
    rng;
    constructor(ratingStore, seed) {
        this.ratingStore = ratingStore;
        // A queue-owned PRNG keeps generated match seeds reproducible: pass an
        // explicit `seed` for deterministic behaviour, otherwise it falls back
        // to a time-based seed. Match seeds are returned on the config so an
        // individual match is always replayable regardless.
        this.rng = new SeededRNG((seed ?? Date.now()) >>> 0);
    }
    /** Add a player to the matchmaking queue. Returns {ok, errors?}. */
    enqueue(playerId, program, constants, mode = "1v1_ranked") {
        // Validate before mutating queue state so malformed requests can't
        // DoS the matchmaker or reach the engine later with garbage programs.
        const result = validateParticipant({ program, constants, playerId, teamId: 0 });
        if (!result.valid) {
            return { ok: false, errors: result.errors };
        }
        // Remove any existing entry for this player
        this.queue = this.queue.filter(e => e.playerId !== playerId);
        const rating = this.ratingStore.getOrCreate(playerId);
        this.queue.push({
            playerId,
            program,
            constants,
            elo: rating.elo,
            enqueuedAt: Date.now(),
            mode,
        });
        return { ok: true };
    }
    /** Remove a player from the queue */
    dequeue(playerId) {
        this.queue = this.queue.filter(e => e.playerId !== playerId);
    }
    /** Try to find a valid match pairing */
    tryMatch() {
        if (this.queue.length < 2)
            return null;
        const now = Date.now();
        // Sort by queue time (FIFO priority)
        this.queue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
        for (let i = 0; i < this.queue.length; i++) {
            const p1 = this.queue[i];
            const waitTime = (now - p1.enqueuedAt) / 1000;
            const eloRange = Math.min(ELO_RANGE_BASE + waitTime * ELO_RANGE_EXPANSION_PER_SEC, MAX_ELO_RANGE);
            for (let j = i + 1; j < this.queue.length; j++) {
                const p2 = this.queue[j];
                if (p1.mode !== p2.mode)
                    continue;
                // Also consider p2's wait time for range expansion (match if either side's range covers the gap)
                const p2WaitTime = (now - p2.enqueuedAt) / 1000;
                const p2EloRange = Math.min(ELO_RANGE_BASE + p2WaitTime * ELO_RANGE_EXPANSION_PER_SEC, MAX_ELO_RANGE);
                const effectiveRange = Math.max(eloRange, p2EloRange);
                const eloDiff = Math.abs(p1.elo - p2.elo);
                if (eloDiff <= effectiveRange) {
                    // Match found — remove both from queue
                    this.queue.splice(j, 1);
                    this.queue.splice(i, 1);
                    return {
                        player1: p1,
                        player2: p2,
                        config: {
                            mode: p1.mode,
                            arenaWidth: ARENA_WIDTH,
                            arenaHeight: ARENA_HEIGHT,
                            maxTicks: MAX_TICKS,
                            tickRate: TICK_RATE,
                            seed: this.rng.nextInt(0, 2147483647),
                        },
                    };
                }
            }
        }
        return null;
    }
    getQueueSize() {
        return this.queue.length;
    }
    getQueuedPlayers() {
        return this.queue.map(e => e.playerId);
    }
}
