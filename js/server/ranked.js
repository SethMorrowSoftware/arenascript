// ============================================================================
// Ranked System — Elo Ratings and Rank Tiers
// ============================================================================
import { INITIAL_ELO, ELO_K_FACTOR, ELO_K_FACTOR_HIGH, RANK_THRESHOLDS } from "../shared/config.js";
/** Calculate expected score using standard Elo formula */
function expectedScore(ratingA, ratingB) {
    return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}
/** Get K-factor based on rating (higher-rated players change slower) */
function getKFactor(rating) {
    return rating > 2400 ? ELO_K_FACTOR_HIGH : ELO_K_FACTOR;
}
/** Calculate new Elo ratings after a match */
export function calculateEloChange(winnerRating, loserRating) {
    const expectedWin = expectedScore(winnerRating, loserRating);
    // Use the average K-factor for both players to maintain zero-sum
    const kWinner = getKFactor(winnerRating);
    const kLoser = getKFactor(loserRating);
    const k = (kWinner + kLoser) / 2;
    let winnerDelta = Math.round(k * (1 - expectedWin));
    // A decisive result must always move the ladder. Across a large skill
    // gap `k * (1 - expectedWin)` rounds to 0, which would freeze the top of
    // the ladder entirely — floor the transfer at 1 point.
    if (winnerDelta < 1) {
        winnerDelta = 1;
    }
    // Enforce a rating floor of 0 without breaking zero-sum: if the loser
    // would drop below zero, cap the transfer at whatever they actually have.
    // Previously the loser was clamped but the winner still received the full
    // delta, which quietly inflated total Elo on the ladder over time.
    if (loserRating - winnerDelta < 0) {
        winnerDelta = loserRating;
    }
    const loserDelta = -winnerDelta;
    return {
        winnerNew: winnerRating + winnerDelta,
        loserNew: loserRating + loserDelta,
        winnerDelta,
        loserDelta,
    };
}
/** Calculate Elo change for a draw */
export function calculateEloDraw(ratingA, ratingB) {
    const expectedA = expectedScore(ratingA, ratingB);
    const expectedB = expectedScore(ratingB, ratingA);
    const kA = getKFactor(ratingA);
    const kB = getKFactor(ratingB);
    const deltaA = Math.round(kA * (0.5 - expectedA));
    const deltaB = Math.round(kB * (0.5 - expectedB));
    return {
        newA: Math.max(0, ratingA + deltaA),
        newB: Math.max(0, ratingB + deltaB),
        deltaA,
        deltaB,
    };
}
/** Determine rank tier from Elo rating */
export function getRankTier(elo) {
    if (elo >= RANK_THRESHOLDS.champion)
        return "champion";
    if (elo >= RANK_THRESHOLDS.diamond)
        return "diamond";
    if (elo >= RANK_THRESHOLDS.platinum)
        return "platinum";
    if (elo >= RANK_THRESHOLDS.gold)
        return "gold";
    if (elo >= RANK_THRESHOLDS.silver)
        return "silver";
    return "bronze";
}
/** In-memory player rating store (for PoC — production would use a database) */
export class RatingStore {
    ratings = new Map();
    getOrCreate(playerId) {
        if (!this.ratings.has(playerId)) {
            this.ratings.set(playerId, {
                playerId,
                elo: INITIAL_ELO,
                tier: getRankTier(INITIAL_ELO),
                wins: 0,
                losses: 0,
                draws: 0,
                matchHistory: [],
            });
        }
        return this.ratings.get(playerId);
    }
    /** Update ratings after a match with a winner */
    recordResult(winnerId, loserId, matchId) {
        const winner = this.getOrCreate(winnerId);
        const loser = this.getOrCreate(loserId);
        const { winnerNew, loserNew } = calculateEloChange(winner.elo, loser.elo);
        winner.elo = winnerNew;
        winner.tier = getRankTier(winnerNew);
        winner.wins++;
        winner.matchHistory.push(matchId);
        if (winner.matchHistory.length > 200) winner.matchHistory.shift();
        loser.elo = loserNew;
        loser.tier = getRankTier(loserNew);
        loser.losses++;
        loser.matchHistory.push(matchId);
        if (loser.matchHistory.length > 200) loser.matchHistory.shift();
        return { winnerRating: winner, loserRating: loser };
    }
    /** Update ratings after a draw */
    recordDraw(playerAId, playerBId, matchId) {
        const a = this.getOrCreate(playerAId);
        const b = this.getOrCreate(playerBId);
        const { newA, newB } = calculateEloDraw(a.elo, b.elo);
        a.elo = newA;
        a.tier = getRankTier(newA);
        a.draws++;
        a.matchHistory.push(matchId);
        if (a.matchHistory.length > 200) a.matchHistory.shift();
        b.elo = newB;
        b.tier = getRankTier(newB);
        b.draws++;
        b.matchHistory.push(matchId);
        if (b.matchHistory.length > 200) b.matchHistory.shift();
    }
    /** Get leaderboard sorted by Elo descending */
    getLeaderboard(limit = 100) {
        return [...this.ratings.values()]
            .sort((a, b) => b.elo - a.elo)
            .slice(0, limit);
    }
    getPlayerCount() {
        return this.ratings.size;
    }
}
