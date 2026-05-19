<?php

declare(strict_types=1);

require_once __DIR__ . '/../../_bootstrap.php';
require_once __DIR__ . '/../../db.php';

as_bootstrap();
as_require_method('GET', 'POST', 'DELETE');

$pdo = as_db();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    $stmt = $pdo->prepare(
        'SELECT l.id, l.name, l.mode, l.status, l.host_user_id, u.username AS host_username, l.created_at, l.updated_at,
                (SELECT COUNT(*) FROM lobby_players lp WHERE lp.lobby_id = l.id) AS player_count
         FROM lobbies l
         JOIN users u ON u.id = l.host_user_id
         WHERE l.status IN ("waiting", "ready")
         ORDER BY l.updated_at DESC
         LIMIT 200'
    );
    $stmt->execute();
    as_respond(['lobbies' => $stmt->fetchAll()]);
}

$user = as_require_user();
$uid = (string) $user['id'];

if ($method === 'POST') {
    $body = as_body();
    $action = (string) ($body['action'] ?? '');

    if ($action === 'create') {
        $name = trim((string) ($body['name'] ?? 'Untitled Lobby'));
        $mode = (string) ($body['mode'] ?? '1v1_unranked');
        $settings = $body['settings'] ?? [];

        as_require($name !== '', 'name is required');
        as_require(in_array($mode, ['1v1_unranked', '1v1_ranked', '2v2', 'squad_2v2', 'ffa'], true), 'Unsupported mode');

        $id = as_uuid();
        $pdo->beginTransaction();
        try {
            $ins = $pdo->prepare(
                'INSERT INTO lobbies (id, host_user_id, name, mode, status, settings_json, created_at, updated_at)
                 VALUES (:id, :host, :name, :mode, :status, :settings, UTC_TIMESTAMP(), UTC_TIMESTAMP())'
            );
            $ins->execute([
                'id' => $id,
                'host' => $uid,
                'name' => mb_substr($name, 0, 120),
                'mode' => $mode,
                'status' => 'waiting',
                'settings' => json_encode($settings),
            ]);

            $lp = $pdo->prepare(
                'INSERT INTO lobby_players (lobby_id, user_id, slot_index, ready_state, submitted_bot_version_id, joined_at)
                 VALUES (:lobby_id, :user_id, 0, 0, NULL, UTC_TIMESTAMP())'
            );
            $lp->execute(['lobby_id' => $id, 'user_id' => $uid]);

            $pdo->commit();
            as_respond(['ok' => true, 'lobbyId' => $id], 201);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            as_fail('Unable to create lobby', $e, 500);
        }
    }

    if ($action === 'join') {
        $lobbyId = (string) ($body['lobbyId'] ?? '');
        as_require($lobbyId !== '', 'lobbyId is required');

        $sel = $pdo->prepare('SELECT id, mode, status FROM lobbies WHERE id = :id LIMIT 1');
        $sel->execute(['id' => $lobbyId]);
        $lobby = $sel->fetch();
        as_require((bool) $lobby, 'Lobby not found', 404);
        as_require(in_array($lobby['status'], ['waiting', 'ready'], true), 'Lobby is not joinable', 409);

        $countStmt = $pdo->prepare('SELECT COUNT(*) AS c FROM lobby_players WHERE lobby_id = :id');
        $countStmt->execute(['id' => $lobbyId]);
        $count = (int) (($countStmt->fetch()['c'] ?? 0));

        $max = $lobby['mode'] === 'ffa' ? 8 : ($lobby['mode'] === 'squad_2v2' ? 8 : ($lobby['mode'] === '2v2' ? 4 : 2));
        as_require($count < $max, 'Lobby is full', 409);

        $join = $pdo->prepare(
            'INSERT INTO lobby_players (lobby_id, user_id, slot_index, ready_state, submitted_bot_version_id, joined_at)
             VALUES (:lobby_id, :user_id, :slot_index, 0, NULL, UTC_TIMESTAMP())'
        );
        try {
            $join->execute(['lobby_id' => $lobbyId, 'user_id' => $uid, 'slot_index' => $count]);
            $touch = $pdo->prepare('UPDATE lobbies SET updated_at = UTC_TIMESTAMP() WHERE id = :id');
            $touch->execute(['id' => $lobbyId]);
            as_respond(['ok' => true]);
        } catch (PDOException $e) {
            if ((int) $e->getCode() === 23000) {
                as_error('Already in this lobby', 409);
            }
            as_fail('Unable to join lobby', $e, 500);
        }
    }

    as_error('Unsupported action', 400);
}

$body = as_body();
$lobbyId = (string) ($body['lobbyId'] ?? '');
as_require($lobbyId !== '', 'lobbyId is required');

$delete = $pdo->prepare('DELETE FROM lobby_players WHERE lobby_id = :lobby_id AND user_id = :user_id');
$delete->execute(['lobby_id' => $lobbyId, 'user_id' => $uid]);
as_require($delete->rowCount() > 0, 'You are not in this lobby', 404);

$remainingStmt = $pdo->prepare('SELECT COUNT(*) AS c FROM lobby_players WHERE lobby_id = :id');
$remainingStmt->execute(['id' => $lobbyId]);
$remaining = (int) (($remainingStmt->fetch()['c'] ?? 0));

if ($remaining === 0) {
    $drop = $pdo->prepare('DELETE FROM lobbies WHERE id = :id');
    $drop->execute(['id' => $lobbyId]);
} else {
    $touch = $pdo->prepare('UPDATE lobbies SET updated_at = UTC_TIMESTAMP() WHERE id = :id');
    $touch->execute(['id' => $lobbyId]);
}

as_respond(['ok' => true, 'remainingPlayers' => $remaining]);
