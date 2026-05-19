// ============================================================================
// Tournament System — Single Elimination, Round Robin, Swiss
// ============================================================================
import { runMatch } from "../engine/tick.js";
import { SeededRNG } from "../shared/prng.js";
import { ARENA_WIDTH, ARENA_HEIGHT, MAX_TICKS, TICK_RATE } from "../shared/config.js";

// Monotonic counter so two tournaments created in the same millisecond with
// the same seed cannot collide on their id (which keys the tournaments Map).
let nextTournamentSequence = 0;

export class TournamentManager {
    tournaments = new Map();
    createTournament(name, format, entries, seed = Date.now()) {
        const id = `tournament_${seed}_${Date.now()}_${++nextTournamentSequence}`;
        const rng = new SeededRNG(seed);
        // Seed participants by Elo (highest first)
        const sorted = [...entries].sort((a, b) => b.elo - a.elo);
        const participants = sorted.map((e, i) => ({
            playerId: e.playerId,
            programId: e.program.programId,
            seed: i + 1,
            wins: 0,
            losses: 0,
            eliminated: false,
            // Participant indices already faced — used by Swiss pairing to
            // avoid rematches.
            opponents: [],
        }));
        const tournament = {
            id,
            name,
            format,
            status: "in_progress",
            participants,
            rounds: [],
            createdAt: Date.now(),
        };
        this.tournaments.set(id, {
            tournament,
            entries: sorted,
            rng,
            currentRound: 0,
        });
        // Generate first round
        this.generateNextRound(id);
        return tournament;
    }
    /** Generate pairings for the next round */
    generateNextRound(tournamentId) {
        const state = this.tournaments.get(tournamentId);
        if (!state)
            return null;
        const { tournament, rng } = state;
        const active = tournament.participants.filter(p => !p.eliminated);
        if (active.length < 2)
            return null;
        let matches;
        switch (tournament.format) {
            case "single_elimination":
                matches = this.generateSingleEliminationPairings(active, rng);
                break;
            case "round_robin":
                matches = this.generateRoundRobinPairings(tournament, state.currentRound);
                break;
            case "swiss":
                matches = this.generateSwissPairings(active, rng);
                break;
            default:
                return null;
        }
        const round = {
            roundNumber: state.currentRound + 1,
            matches,
            completed: false,
        };
        tournament.rounds.push(round);
        state.currentRound++;
        return round;
    }
    /** Run all matches in the current round */
    runCurrentRound(tournamentId) {
        const state = this.tournaments.get(tournamentId);
        if (!state)
            return null;
        const { tournament, entries, rng } = state;
        const currentRound = tournament.rounds[tournament.rounds.length - 1];
        if (!currentRound || currentRound.completed)
            return null;
        for (const match of currentRound.matches) {
            if (match.completed)
                continue;
            const entry1 = entries[match.participant1Index];
            const entry2 = entries[match.participant2Index];
            if (!entry1 || !entry2)
                continue;
            const setup = {
                config: {
                    mode: "tournament",
                    arenaWidth: ARENA_WIDTH,
                    arenaHeight: ARENA_HEIGHT,
                    maxTicks: MAX_TICKS,
                    tickRate: TICK_RATE,
                    seed: rng.nextInt(0, 2147483647),
                },
                participants: [
                    {
                        program: entry1.program,
                        constants: entry1.constants,
                        playerId: entry1.playerId,
                        teamId: 0,
                    },
                    {
                        program: entry2.program,
                        constants: entry2.constants,
                        playerId: entry2.playerId,
                        teamId: 1,
                    },
                ],
            };
            const result = runMatch(setup);
            match.matchId = `tmatch_${rng.nextInt(0, 2147483647)}_${state.currentRound}`;
            match.completed = true;
            // Record the pairing so Swiss can avoid rematches in later rounds.
            tournament.participants[match.participant1Index].opponents.push(match.participant2Index);
            tournament.participants[match.participant2Index].opponents.push(match.participant1Index);
            if (result.winner === 0) {
                match.winner = match.participant1Index;
                tournament.participants[match.participant1Index].wins++;
                tournament.participants[match.participant2Index].losses++;
                if (tournament.format === "single_elimination") {
                    tournament.participants[match.participant2Index].eliminated = true;
                }
            }
            else if (result.winner === 1) {
                match.winner = match.participant2Index;
                tournament.participants[match.participant2Index].wins++;
                tournament.participants[match.participant1Index].losses++;
                if (tournament.format === "single_elimination") {
                    tournament.participants[match.participant1Index].eliminated = true;
                }
            }
            else {
                // Draw — in single elimination, give it to higher seed
                match.winner = match.participant1Index;
                tournament.participants[match.participant1Index].wins++;
                tournament.participants[match.participant2Index].losses++;
                if (tournament.format === "single_elimination") {
                    tournament.participants[match.participant2Index].eliminated = true;
                }
            }
        }
        currentRound.completed = true;
        // Check if tournament is over
        const active = tournament.participants.filter(p => !p.eliminated);
        if (tournament.format === "single_elimination" && active.length <= 1) {
            tournament.status = "completed";
        }
        else if (tournament.format === "round_robin") {
            // A round-robin needs n-1 rounds for an even field and n rounds
            // for an odd field (one player takes a bye each round).
            const n = tournament.participants.length;
            const totalRounds = n % 2 === 0 ? n - 1 : n;
            if (tournament.rounds.length >= totalRounds) {
                tournament.status = "completed";
            }
            else {
                this.generateNextRound(tournamentId);
            }
        }
        else if (tournament.format === "swiss") {
            // Swiss typically runs log2(n) rounds
            const totalRounds = Math.ceil(Math.log2(tournament.participants.length));
            if (tournament.rounds.length >= totalRounds) {
                tournament.status = "completed";
            }
            else {
                this.generateNextRound(tournamentId);
            }
        }
        // Generate next round if not complete
        if (tournament.status === "in_progress" && tournament.format === "single_elimination") {
            this.generateNextRound(tournamentId);
        }
        return currentRound;
    }
    /** Get tournament standings */
    getStandings(tournamentId) {
        const state = this.tournaments.get(tournamentId);
        if (!state)
            return [];
        return [...state.tournament.participants].sort((a, b) => {
            if (a.eliminated && !b.eliminated)
                return 1;
            if (!a.eliminated && b.eliminated)
                return -1;
            return b.wins - a.wins || a.losses - b.losses || a.seed - b.seed;
        });
    }
    getTournament(id) {
        return this.tournaments.get(id)?.tournament;
    }
    // --- Pairing Generators ---
    generateSingleEliminationPairings(active, rng) {
        const matches = [];
        // Pair by seed: 1v(n), 2v(n-1), etc.
        const sorted = [...active].sort((a, b) => a.seed - b.seed);
        for (let i = 0; i < Math.floor(sorted.length / 2); i++) {
            const p1 = sorted[i];
            const p2 = sorted[sorted.length - 1 - i];
            matches.push({
                matchId: "",
                participant1Index: p1.seed - 1,
                participant2Index: p2.seed - 1,
                completed: false,
            });
        }
        // Bye for odd participant (auto-advance highest remaining seed = lowest seed number)
        if (sorted.length % 2 !== 0) {
            const byePlayer = sorted[sorted.length - 1];
            byePlayer.wins++;
        }
        return matches;
    }
    generateRoundRobinPairings(tournament, roundIndex) {
        const realN = tournament.participants.length;
        // Odd fields get a phantom "bye" slot (index === realN) so the circle
        // method stays balanced; a real player drawn against it takes a bye.
        const n = realN % 2 === 0 ? realN : realN + 1;
        const matches = [];
        // Circle method: fix player 0, rotate the rest (indices 1..n-1).
        const fixed = 0;
        const rest = Array.from({ length: n - 1 }, (_, i) => i + 1);
        const rotateBy = rest.length > 0 ? roundIndex % rest.length : 0;
        const rotated = [
            ...rest.slice(rest.length - rotateBy),
            ...rest.slice(0, rest.length - rotateBy),
        ];
        const indices = [fixed, ...rotated];
        for (let i = 0; i < Math.floor(n / 2); i++) {
            const a = indices[i];
            const b = indices[n - 1 - i];
            // A pairing that includes the phantom slot is a bye for the real
            // player; no match is scheduled.
            if (a >= realN || b >= realN) {
                const realPlayer = a >= realN ? b : a;
                if (realPlayer < realN) {
                    tournament.participants[realPlayer].wins++;
                }
                continue;
            }
            matches.push({
                matchId: "",
                participant1Index: a,
                participant2Index: b,
                completed: false,
            });
        }
        return matches;
    }
    generateSwissPairings(active, rng) {
        // Sort by wins (desc), then by seed
        const sorted = [...active].sort((a, b) => b.wins - a.wins || a.seed - b.seed);
        const matches = [];
        const paired = new Set();
        for (let i = 0; i < sorted.length; i++) {
            const p1 = sorted[i];
            if (paired.has(p1.seed - 1))
                continue;
            let opponent = null;
            // Prefer an opponent this player has not already faced.
            for (let j = i + 1; j < sorted.length; j++) {
                const p2 = sorted[j];
                if (paired.has(p2.seed - 1))
                    continue;
                if (p1.opponents && p1.opponents.includes(p2.seed - 1))
                    continue;
                opponent = p2;
                break;
            }
            // No unfaced opponent remains — fall back to the nearest-ranked
            // available player even though it is a rematch, so two players
            // do not both end up with an undeserved bye.
            if (!opponent) {
                for (let j = i + 1; j < sorted.length; j++) {
                    const p2 = sorted[j];
                    if (paired.has(p2.seed - 1))
                        continue;
                    opponent = p2;
                    break;
                }
            }
            if (opponent) {
                matches.push({
                    matchId: "",
                    participant1Index: p1.seed - 1,
                    participant2Index: opponent.seed - 1,
                    completed: false,
                });
                paired.add(p1.seed - 1);
                paired.add(opponent.seed - 1);
            }
            else {
                // Genuine odd one out — award a bye for this round.
                paired.add(p1.seed - 1);
                p1.wins++;
            }
        }
        return matches;
    }
}
