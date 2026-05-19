<?php

declare(strict_types=1);

require_once __DIR__ . '/../../_bootstrap.php';
require_once __DIR__ . '/../../db.php';
require_once __DIR__ . '/../_rating.php';

as_bootstrap();
as_require_method('POST');
as_require(
    as_rate_limit('match_report:' . ($_SERVER['REMOTE_ADDR'] ?? 'unknown'), 120, 60),
    'Match report rate limit exceeded',
    429,
);

$reporter = as_require_user();
$body = as_body();

$config = $body['config'] ?? null;
$participants = $body['participants'] ?? null;
$result = $body['result'] ?? null;
$replay = $body['replay'] ?? null;

as_require(is_array($config), 'config is required');
as_require(is_array($participants) && count($participants) >= 2, 'participants must contain at least two players');
as_require(is_array($result), 'result is required');

$mode = (string) ($config['mode'] ?? '');
$seed = (int) ($config['seed'] ?? -1);
$tickCount = (int) ($result['tickCount'] ?? -1);
$winnerTeam = $result['winner'] ?? null;
$reason = trim((string) ($result['reason'] ?? 'unknown'));
$resultSeed = (int) ($result['seed'] ?? -2);

as_require($mode !== '', 'config.mode is required');
as_require($seed >= 0, 'config.seed must be >= 0');
as_require($tickCount >= 0, 'result.tickCount must be >= 0');
as_require($seed === $resultSeed, 'result.seed must equal config.seed');

$reporterId = (string) $reporter['id'];
$participantIds = [];
foreach ($participants as $p) {
    as_require(is_array($p), 'participant must be an object');
    $pid = (string) ($p['userId'] ?? '');
    $teamId = $p['teamId'] ?? null;
    as_require($pid !== '', 'participant.userId is required');
    as_require(is_int($teamId) || is_float($teamId), 'participant.teamId is required');
    $participantIds[] = $pid;
}
as_require(in_array($reporterId, $participantIds, true), 'Reporter must be one of the participants', 403);

$pdo = as_db();

// Every named participant must be a real account — a result (and any
// rating change it carries) cannot be filed against a user id that does
// not exist.
$uniqueIds = array_values(array_unique($participantIds));
$placeholders = implode(',', array_fill(0, count($uniqueIds), '?'));
$existsStmt = $pdo->prepare("SELECT COUNT(*) FROM users WHERE id IN ($placeholders)");
$existsStmt->execute($uniqueIds);
as_require(
    (int) $existsStmt->fetchColumn() === count($uniqueIds),
    'One or more participants are not registered users',
    422,
);

// Ranked anti-farm: a seed identifies one match, so refuse to re-report a
// ranked seed — otherwise a player could replay the same win to inflate
// Elo. Cheat-proofing beyond this needs server-side re-simulation, which a
// JavaScript engine cannot provide; this blocks the trivial replay exploit.
if ($mode === '1v1_ranked') {
    $dupStmt = $pdo->prepare('SELECT COUNT(*) FROM matches WHERE mode = :mode AND seed = :seed');
    $dupStmt->execute(['mode' => $mode, 'seed' => $seed]);
    as_require(
        (int) $dupStmt->fetchColumn() === 0,
        'This ranked match has already been reported',
        409,
    );
}

$matchId = as_uuid();

try {
    $pdo->beginTransaction();

    $insertMatch = $pdo->prepare(
        'INSERT INTO matches
         (id, mode, seed, tick_count, winner_team, reason, reported_by_user_id, result_json, replay_json, created_at)
         VALUES (:id, :mode, :seed, :tick_count, :winner_team, :reason, :reporter, :result_json, :replay_json, UTC_TIMESTAMP())'
    );
    $insertMatch->execute([
        'id' => $matchId,
        'mode' => $mode,
        'seed' => $seed,
        'tick_count' => $tickCount,
        'winner_team' => is_int($winnerTeam) ? $winnerTeam : null,
        'reason' => $reason,
        'reporter' => $reporterId,
        'result_json' => json_encode($result),
        'replay_json' => $replay !== null ? json_encode($replay) : null,
    ]);

    $ratingChanges = [];
    if ($mode === '1v1_ranked' && count($participants) === 2 && is_int($winnerTeam)) {
        $a = $participants[0];
        $b = $participants[1];
        $aUser = (string) $a['userId'];
        $bUser = (string) $b['userId'];
        $aTeam = (int) $a['teamId'];
        $bTeam = (int) $b['teamId'];

        $ratingA = as_get_or_create_rating($pdo, $aUser, '1v1_ranked');
        $ratingB = as_get_or_create_rating($pdo, $bUser, '1v1_ranked');

        if ($winnerTeam === $aTeam) {
            $elo = as_calculate_elo_change((float) $ratingA['elo'], (float) $ratingB['elo']);
            as_apply_rating_update($pdo, $aUser, '1v1_ranked', $elo['winnerNew'], 1, 0, 0);
            as_apply_rating_update($pdo, $bUser, '1v1_ranked', $elo['loserNew'], 0, 1, 0);
            $ratingChanges = [
                $aUser => ['before' => (int) $ratingA['elo'], 'after' => $elo['winnerNew']],
                $bUser => ['before' => (int) $ratingB['elo'], 'after' => $elo['loserNew']],
            ];
        } elseif ($winnerTeam === $bTeam) {
            $elo = as_calculate_elo_change((float) $ratingB['elo'], (float) $ratingA['elo']);
            as_apply_rating_update($pdo, $bUser, '1v1_ranked', $elo['winnerNew'], 1, 0, 0);
            as_apply_rating_update($pdo, $aUser, '1v1_ranked', $elo['loserNew'], 0, 1, 0);
            $ratingChanges = [
                $aUser => ['before' => (int) $ratingA['elo'], 'after' => $elo['loserNew']],
                $bUser => ['before' => (int) $ratingB['elo'], 'after' => $elo['winnerNew']],
            ];
        }
    }

    $insertParticipant = $pdo->prepare(
        'INSERT INTO match_participants
         (match_id, user_id, team_id, bot_version_id, result, elo_before, elo_after)
         VALUES (:match_id, :user_id, :team_id, :bot_version_id, :result, :elo_before, :elo_after)'
    );

    foreach ($participants as $p) {
        $userId = (string) $p['userId'];
        $teamId = (int) $p['teamId'];
        $winner = is_int($winnerTeam) ? $winnerTeam : null;
        $resultValue = 'draw';
        if ($winner !== null) {
            $resultValue = $teamId === $winner ? 'win' : 'loss';
        }
        $before = $ratingChanges[$userId]['before'] ?? null;
        $after = $ratingChanges[$userId]['after'] ?? null;

        $insertParticipant->execute([
            'match_id' => $matchId,
            'user_id' => $userId,
            'team_id' => $teamId,
            'bot_version_id' => $p['botVersionId'] ?? null,
            'result' => $resultValue,
            'elo_before' => $before,
            'elo_after' => $after,
        ]);
    }

    $pdo->commit();

    as_respond([
        'ok' => true,
        'matchId' => $matchId,
        'ratingChanges' => $ratingChanges,
    ], 201);
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    as_fail('Unable to report match', $e, 500);
}

function as_get_or_create_rating(PDO $pdo, string $userId, string $queue): array
{
    $select = $pdo->prepare('SELECT user_id, queue, elo, wins, losses, draws, provisional_games FROM ratings WHERE user_id = :uid AND queue = :queue LIMIT 1');
    $select->execute(['uid' => $userId, 'queue' => $queue]);
    $row = $select->fetch();
    if (is_array($row)) {
        return $row;
    }

    $insert = $pdo->prepare(
        'INSERT INTO ratings (user_id, queue, elo, wins, losses, draws, provisional_games, updated_at)
         VALUES (:uid, :queue, 1000, 0, 0, 0, 0, UTC_TIMESTAMP())'
    );
    $insert->execute(['uid' => $userId, 'queue' => $queue]);

    return [
        'user_id' => $userId,
        'queue' => $queue,
        'elo' => 1000,
        'wins' => 0,
        'losses' => 0,
        'draws' => 0,
        'provisional_games' => 0,
    ];
}

function as_apply_rating_update(PDO $pdo, string $userId, string $queue, int $newElo, int $winsInc, int $lossesInc, int $drawsInc): void
{
    $upd = $pdo->prepare(
        'UPDATE ratings
         SET elo = :elo,
             wins = wins + :wins,
             losses = losses + :losses,
             draws = draws + :draws,
             provisional_games = provisional_games + 1,
             updated_at = UTC_TIMESTAMP()
         WHERE user_id = :uid AND queue = :queue'
    );
    $upd->execute([
        'elo' => $newElo,
        'wins' => $winsInc,
        'losses' => $lossesInc,
        'draws' => $drawsInc,
        'uid' => $userId,
        'queue' => $queue,
    ]);
}
