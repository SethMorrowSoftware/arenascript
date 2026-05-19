// ============================================================================
// API Contract Tests — Lobby, Matchmaking, Ranked, Validation, and E2E
// ============================================================================

import assert from "node:assert/strict";
import { compile } from "../lang/pipeline.js";
import { runMatch } from "../engine/tick.js";
import { LobbyManager } from "../server/lobby.js";
import { MatchmakingQueue } from "../server/matchmaking.js";
import { RatingStore, calculateEloChange, calculateEloDraw, getRankTier } from "../server/ranked.js";
import { validateMatchMode, validateParticipantCount, validateMatchConfig, validateMatchRequest } from "../shared/validation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeBot = (cls) =>
  `robot "Bot" version "1.0"\nmeta { class: "${cls}" }\non tick {\n  let e = nearest_enemy()\n  if e != null { if can_attack(e) { attack e } else { move_toward e.position } }\n  else { move_forward }\n}`;

function compileBot(cls) {
  const result = compile(makeBot(cls));
  assert.ok(result.success, `Failed to compile ${cls} bot: ${result.errors.join(", ")}`);
  return result;
}

// ---------------------------------------------------------------------------
// Lobby Contract Tests
// ---------------------------------------------------------------------------

function test_lobby_create() {
  const mgr = new LobbyManager(null, null);
  const lobby = mgr.createLobby("host1", "Test Room", "1v1_unranked");

  assert.ok(lobby.id, "Lobby must have an id");
  assert.equal(lobby.name, "Test Room");
  assert.equal(lobby.host, "host1");
  assert.equal(lobby.mode, "1v1_unranked");
  assert.equal(lobby.status, "waiting");
  assert.equal(lobby.maxPlayers, 2);
  assert.equal(lobby.players.length, 1);
  assert.equal(lobby.players[0].playerId, "host1");
}

function test_lobby_join() {
  const mgr = new LobbyManager(null, null);
  const lobby = mgr.createLobby("host1", "Room", "1v1_unranked");
  const updated = mgr.joinLobby(lobby.id, "player2");

  assert.ok(updated, "joinLobby should return the lobby on success");
  assert.equal(updated.players.length, 2);
  assert.equal(updated.players[1].playerId, "player2");
}

function test_lobby_join_full_returns_null() {
  const mgr = new LobbyManager(null, null);
  const lobby = mgr.createLobby("h", "Room", "1v1_unranked");
  mgr.joinLobby(lobby.id, "p2");
  const result = mgr.joinLobby(lobby.id, "p3");

  assert.equal(result, null, "Joining a full lobby should return null");
}

function test_lobby_join_duplicate_returns_null() {
  const mgr = new LobbyManager(null, null);
  const lobby = mgr.createLobby("h", "Room", "1v1_unranked");
  const result = mgr.joinLobby(lobby.id, "h");

  assert.equal(result, null, "Duplicate join should return null");
}

function test_lobby_leave() {
  const mgr = new LobbyManager(null, null);
  const lobby = mgr.createLobby("h", "Room", "2v2");
  mgr.joinLobby(lobby.id, "p2");

  const left = mgr.leaveLobby(lobby.id, "p2");
  assert.equal(left, true);
  assert.equal(lobby.players.length, 1);
}

function test_lobby_leave_host_reassigns() {
  const mgr = new LobbyManager(null, null);
  const lobby = mgr.createLobby("h", "Room", "2v2");
  mgr.joinLobby(lobby.id, "p2");
  mgr.leaveLobby(lobby.id, "h");

  assert.equal(lobby.host, "p2", "Host should transfer to next player");
}

function test_lobby_leave_last_player_deletes() {
  const mgr = new LobbyManager(null, null);
  const lobby = mgr.createLobby("h", "Room", "1v1_unranked");
  mgr.leaveLobby(lobby.id, "h");

  assert.equal(mgr.listLobbies().length, 0, "Lobby should be deleted when empty");
}

function test_lobby_submit_program_and_ready() {
  const mgr = new LobbyManager(null, null);
  const lobby = mgr.createLobby("h", "Room", "1v1_unranked");
  mgr.joinLobby(lobby.id, "p2");

  const bot = compileBot("warrior");

  const s1 = mgr.submitProgram(lobby.id, "h", bot.program, bot.constants);
  assert.equal(s1, true);
  assert.equal(lobby.status, "waiting", "Not all players ready yet");

  const s2 = mgr.submitProgram(lobby.id, "p2", bot.program, bot.constants);
  assert.equal(s2, true);
  assert.equal(lobby.status, "ready", "All players ready => status should be ready");
}

function test_lobby_list_only_waiting() {
  const mgr = new LobbyManager(null, null);
  const l1 = mgr.createLobby("a", "Room A", "1v1_unranked");
  mgr.createLobby("b", "Room B", "1v1_unranked");
  mgr.joinLobby(l1.id, "a2");

  const bot = compileBot("warrior");
  mgr.submitProgram(l1.id, "a", bot.program, bot.constants);
  mgr.submitProgram(l1.id, "a2", bot.program, bot.constants);
  // l1 is now "ready", l2 is still "waiting"

  const waiting = mgr.listLobbies();
  assert.equal(waiting.length, 1, "Only waiting lobbies should be listed");
  assert.equal(waiting[0].name, "Room B");
}

// ---------------------------------------------------------------------------
// Matchmaking Contract Tests
// ---------------------------------------------------------------------------

function test_matchmaking_enqueue_and_size() {
  const store = new RatingStore();
  const queue = new MatchmakingQueue(store);
  const bot = compileBot("warrior");

  queue.enqueue("p1", bot.program, bot.constants, "1v1_ranked");
  assert.equal(queue.getQueueSize(), 1);

  queue.enqueue("p2", bot.program, bot.constants, "1v1_ranked");
  assert.equal(queue.getQueueSize(), 2);
}

function test_matchmaking_dequeue() {
  const store = new RatingStore();
  const queue = new MatchmakingQueue(store);
  const bot = compileBot("warrior");

  queue.enqueue("p1", bot.program, bot.constants);
  queue.dequeue("p1");
  assert.equal(queue.getQueueSize(), 0, "Player should be removed from queue");
}

function test_matchmaking_try_match_within_elo() {
  const store = new RatingStore();
  // Both players start at 1000 Elo (within the 100 base range)
  const queue = new MatchmakingQueue(store);
  const bot = compileBot("warrior");

  queue.enqueue("p1", bot.program, bot.constants, "1v1_ranked");
  queue.enqueue("p2", bot.program, bot.constants, "1v1_ranked");

  const match = queue.tryMatch();
  assert.ok(match, "Players with similar Elo should be matched");
  assert.ok(match.player1, "Match should have player1");
  assert.ok(match.player2, "Match should have player2");
  assert.ok(match.config, "Match should have config");
  assert.equal(queue.getQueueSize(), 0, "Matched players removed from queue");
}

function test_matchmaking_no_match_different_modes() {
  const store = new RatingStore();
  const queue = new MatchmakingQueue(store);
  const bot = compileBot("warrior");

  queue.enqueue("p1", bot.program, bot.constants, "1v1_ranked");
  queue.enqueue("p2", bot.program, bot.constants, "1v1_unranked");

  const match = queue.tryMatch();
  assert.equal(match, null, "Different modes should not match");
  assert.equal(queue.getQueueSize(), 2, "Both players should remain in queue");
}

function test_matchmaking_no_match_single_player() {
  const store = new RatingStore();
  const queue = new MatchmakingQueue(store);
  const bot = compileBot("warrior");

  queue.enqueue("p1", bot.program, bot.constants);
  const match = queue.tryMatch();
  assert.equal(match, null, "Cannot match with only one player");
}

// ---------------------------------------------------------------------------
// Ranked / Elo Contract Tests
// ---------------------------------------------------------------------------

function test_elo_change_winner_gains_loser_loses() {
  const result = calculateEloChange(1000, 1000);
  assert.ok(result.winnerDelta > 0, "Winner should gain Elo");
  assert.ok(result.loserDelta < 0, "Loser should lose Elo");
  assert.equal(result.winnerNew, 1000 + result.winnerDelta);
  assert.equal(result.loserNew, 1000 + result.loserDelta);
}

function test_elo_change_symmetric_at_equal_ratings() {
  const result = calculateEloChange(1000, 1000);
  // At equal ratings, the magnitudes should be equal
  assert.equal(Math.abs(result.winnerDelta), Math.abs(result.loserDelta),
    "At equal ratings, gains and losses should be symmetric");
}

function test_elo_never_below_zero() {
  // A player with very low Elo losing to a high-rated player
  const result = calculateEloChange(2000, 5);
  assert.ok(result.loserNew >= 0, "Elo should never go below 0");
}

function test_elo_draw_at_equal_ratings() {
  const result = calculateEloDraw(1000, 1000);
  // Equal-rated players drawing should have near-zero changes
  assert.equal(result.deltaA, 0, "Draw at equal ratings => deltaA ~ 0");
  assert.equal(result.deltaB, 0, "Draw at equal ratings => deltaB ~ 0");
}

function test_elo_draw_higher_rated_loses_points() {
  const result = calculateEloDraw(1500, 1000);
  // The higher-rated player should lose points in a draw against a weaker opponent
  assert.ok(result.deltaA < 0, "Higher-rated player should lose Elo on draw");
  assert.ok(result.deltaB > 0, "Lower-rated player should gain Elo on draw");
}

function test_rank_tiers() {
  assert.equal(getRankTier(0), "bronze");
  assert.equal(getRankTier(999), "bronze");
  assert.equal(getRankTier(1000), "silver");
  assert.equal(getRankTier(1200), "gold");
  assert.equal(getRankTier(1400), "platinum");
  assert.equal(getRankTier(1600), "diamond");
  assert.equal(getRankTier(1800), "champion");
  assert.equal(getRankTier(3000), "champion");
}

function test_rating_store_get_or_create() {
  const store = new RatingStore();
  const rating = store.getOrCreate("newplayer");
  assert.equal(rating.elo, 1000, "New player should start at 1000 Elo");
  assert.equal(rating.tier, "silver");
  assert.equal(rating.wins, 0);
  assert.equal(rating.losses, 0);
  assert.equal(rating.draws, 0);
}

function test_rating_store_record_result() {
  const store = new RatingStore();
  store.getOrCreate("winner1");
  store.getOrCreate("loser1");

  store.recordResult("winner1", "loser1", "match_1");

  const w = store.getOrCreate("winner1");
  const l = store.getOrCreate("loser1");
  assert.ok(w.elo > 1000, "Winner Elo should increase");
  assert.ok(l.elo < 1000, "Loser Elo should decrease");
  assert.equal(w.wins, 1);
  assert.equal(l.losses, 1);
  assert.ok(w.matchHistory.includes("match_1"));
  assert.ok(l.matchHistory.includes("match_1"));
}

function test_rating_store_record_draw() {
  const store = new RatingStore();
  store.recordDraw("a", "b", "match_2");

  const a = store.getOrCreate("a");
  const b = store.getOrCreate("b");
  assert.equal(a.draws, 1);
  assert.equal(b.draws, 1);
}

function test_rating_store_leaderboard() {
  const store = new RatingStore();
  // Create several players and record results to differentiate Elo
  store.recordResult("top", "low", "m1");
  store.recordResult("top", "mid", "m2");
  store.recordResult("mid", "low", "m3");

  const board = store.getLeaderboard();
  assert.ok(board.length >= 3);
  assert.equal(board[0].playerId, "top", "Highest-rated player should be first");
  assert.ok(board[0].elo > board[1].elo, "Leaderboard should be sorted descending by Elo");
}

// ---------------------------------------------------------------------------
// Validation Contract Tests
// ---------------------------------------------------------------------------

function test_validate_match_mode_valid() {
  for (const mode of [
    "1v1_ranked", "1v1_unranked", "2v2", "ffa", "duel_1v1", "squad_2v2",
    "team_3v3", "team_4v4", "team_5v5", "battle_royale", "test",
  ]) {
    const result = validateMatchMode(mode);
    assert.equal(result.valid, true, `Mode "${mode}" should be valid`);
  }
}

function test_validate_match_mode_invalid() {
  const result = validateMatchMode("not_a_real_mode");
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
}

function test_validate_participant_count_correct() {
  assert.equal(validateParticipantCount("1v1_ranked", 2).valid, true);
  assert.equal(validateParticipantCount("2v2", 4).valid, true);
  assert.equal(validateParticipantCount("ffa", 4).valid, true);
  assert.equal(validateParticipantCount("ffa", 8).valid, true);
}

function test_validate_participant_count_incorrect() {
  assert.equal(validateParticipantCount("1v1_ranked", 3).valid, false);
  assert.equal(validateParticipantCount("1v1_ranked", 0).valid, false);
  assert.equal(validateParticipantCount("ffa", 1).valid, false);
}

function test_validate_match_config_valid() {
  const result = validateMatchConfig({
    mode: "1v1_ranked",
    arenaWidth: 140,
    arenaHeight: 140,
    maxTicks: 3000,
    tickRate: 30,
    seed: 42,
  });
  assert.equal(result.valid, true);
}

function test_validate_match_config_missing_fields() {
  const result = validateMatchConfig({});
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 1, "Should report errors for missing fields");
}

function test_validate_match_config_negative_values() {
  const result = validateMatchConfig({
    mode: "1v1_ranked",
    arenaWidth: -10,
    arenaHeight: 140,
    maxTicks: 3000,
    tickRate: 30,
    seed: 42,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("arenaWidth")));
}

function test_validate_match_config_nan_values() {
  const result = validateMatchConfig({
    mode: "1v1_ranked",
    arenaWidth: NaN,
    arenaHeight: 140,
    maxTicks: 3000,
    tickRate: 30,
    seed: 42,
  });
  assert.equal(result.valid, false);
}

function test_validate_match_request_valid() {
  const bot = compileBot("warrior");
  const result = validateMatchRequest({
    config: {
      mode: "1v1_ranked",
      arenaWidth: 140,
      arenaHeight: 140,
      maxTicks: 3000,
      tickRate: 30,
      seed: 42,
    },
    participants: [
      { program: bot.program, constants: bot.constants, playerId: "p1", teamId: 0 },
      { program: bot.program, constants: bot.constants, playerId: "p2", teamId: 1 },
    ],
  });
  assert.equal(result.valid, true);
}

function test_validate_match_request_null() {
  const result = validateMatchRequest(null);
  assert.equal(result.valid, false);
}

// ---------------------------------------------------------------------------
// E2E: Full 2v2 Match
// ---------------------------------------------------------------------------

function test_e2e_2v2_match() {
  const p1 = compileBot("warrior");
  const p2 = compileBot("scout");
  const p3 = compileBot("tank");
  const p4 = compileBot("sniper");

  const setup = {
    config: {
      mode: "squad_2v2",
      arenaWidth: 140,
      arenaHeight: 140,
      maxTicks: 1000,
      tickRate: 30,
      seed: 42,
    },
    participants: [
      { program: p1.program, constants: p1.constants, playerId: "a1", teamId: 0 },
      { program: p2.program, constants: p2.constants, playerId: "a2", teamId: 0 },
      { program: p3.program, constants: p3.constants, playerId: "b1", teamId: 1 },
      { program: p4.program, constants: p4.constants, playerId: "b2", teamId: 1 },
    ],
  };

  const result = runMatch(setup);

  // Match must complete
  assert.ok(result, "runMatch should return a result");
  assert.ok(result.tickCount > 0, "Match should run at least one tick");

  // Must have a winner or be a draw
  assert.ok(result.reason, "Result must have a reason");
  assert.ok(
    result.winner !== undefined,
    "Result must specify winner (possibly null for draw)"
  );

  // Replay integrity
  assert.ok(result.replay, "Result must include a replay");
  assert.ok(result.replay.frames, "Replay must have frames");
  assert.ok(result.replay.frames.length > 0, "Replay must have at least one frame");

  // All 4 robots should appear in the match
  assert.ok(result.robotStats, "Result should include robotStats");
  assert.ok(result.robotStats.size >= 4, "All 4 robots should appear in stats");
}

// ---------------------------------------------------------------------------
// E2E: Full FFA Match
// ---------------------------------------------------------------------------

function test_e2e_ffa_match() {
  const p1 = compileBot("warrior");
  const p2 = compileBot("scout");
  const p3 = compileBot("tank");
  const p4 = compileBot("sniper");

  const setup = {
    config: {
      mode: "ffa",
      arenaWidth: 140,
      arenaHeight: 140,
      maxTicks: 1000,
      tickRate: 30,
      seed: 99,
    },
    participants: [
      { program: p1.program, constants: p1.constants, playerId: "f1", teamId: 0 },
      { program: p2.program, constants: p2.constants, playerId: "f2", teamId: 1 },
      { program: p3.program, constants: p3.constants, playerId: "f3", teamId: 2 },
      { program: p4.program, constants: p4.constants, playerId: "f4", teamId: 3 },
    ],
  };

  const result = runMatch(setup);

  assert.ok(result, "runMatch should return a result");
  assert.ok(result.tickCount > 0, "Match should run at least one tick");
  assert.ok(result.reason, "Result must have a reason");

  // Replay integrity
  assert.ok(result.replay, "Result must include a replay");
  assert.ok(result.replay.frames, "Replay must have frames");
  assert.ok(result.replay.frames.length > 0, "Replay must have at least one frame");

  // All 4 robots should appear
  assert.ok(result.robotStats, "Result should include robotStats");
  assert.ok(result.robotStats.size >= 4, "All 4 robots should appear in FFA stats");
}

// ---------------------------------------------------------------------------
// Test Runner
// ---------------------------------------------------------------------------

const tests = [
  // Lobby
  test_lobby_create,
  test_lobby_join,
  test_lobby_join_full_returns_null,
  test_lobby_join_duplicate_returns_null,
  test_lobby_leave,
  test_lobby_leave_host_reassigns,
  test_lobby_leave_last_player_deletes,
  test_lobby_submit_program_and_ready,
  test_lobby_list_only_waiting,
  // Matchmaking
  test_matchmaking_enqueue_and_size,
  test_matchmaking_dequeue,
  test_matchmaking_try_match_within_elo,
  test_matchmaking_no_match_different_modes,
  test_matchmaking_no_match_single_player,
  // Ranked / Elo
  test_elo_change_winner_gains_loser_loses,
  test_elo_change_symmetric_at_equal_ratings,
  test_elo_never_below_zero,
  test_elo_draw_at_equal_ratings,
  test_elo_draw_higher_rated_loses_points,
  test_rank_tiers,
  test_rating_store_get_or_create,
  test_rating_store_record_result,
  test_rating_store_record_draw,
  test_rating_store_leaderboard,
  // Validation
  test_validate_match_mode_valid,
  test_validate_match_mode_invalid,
  test_validate_participant_count_correct,
  test_validate_participant_count_incorrect,
  test_validate_match_config_valid,
  test_validate_match_config_missing_fields,
  test_validate_match_config_negative_values,
  test_validate_match_config_nan_values,
  test_validate_match_request_valid,
  test_validate_match_request_null,
  // E2E
  test_e2e_2v2_match,
  test_e2e_ffa_match,
];

console.log("API Contract & E2E Tests");
console.log("========================\n");

let passed = 0;
let failed = 0;

for (const test of tests) {
  try {
    test();
    passed++;
    console.log(`  PASS: ${test.name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${test.name}: ${e.message}`);
  }
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
