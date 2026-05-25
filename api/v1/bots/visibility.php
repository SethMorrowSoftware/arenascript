<?php

declare(strict_types=1);

require_once __DIR__ . '/../../_bootstrap.php';
require_once __DIR__ . '/../../db.php';

as_bootstrap();
as_require_method('POST');

$user = as_require_user();
$uid = (string) $user['id'];

$body = as_body();
$id = trim((string) ($body['id'] ?? ($_GET['id'] ?? '')));
$visibility = (string) ($body['visibility'] ?? '');

as_require($id !== '', 'id is required');
as_require(preg_match('/^[A-Za-z0-9\-]{8,64}$/', $id) === 1, 'Invalid bot id');
as_require(in_array($visibility, ['private', 'unlisted', 'public'], true), 'Invalid visibility');

$pdo = as_db();

// Confirm ownership before mutating — never allow a user to change another
// user's bot visibility.
$stmt = $pdo->prepare('SELECT id, owner_user_id, visibility FROM bots WHERE id = :id LIMIT 1');
$stmt->execute(['id' => $id]);
$bot = $stmt->fetch();
if (!$bot) {
    as_error('Bot not found', 404);
}
if ((string) $bot['owner_user_id'] !== $uid) {
    as_error('You do not own this bot', 403);
}

$update = $pdo->prepare('UPDATE bots SET visibility = :v, updated_at = UTC_TIMESTAMP() WHERE id = :id');
$update->execute(['v' => $visibility, 'id' => $id]);

as_respond([
    'bot' => [
        'id' => $id,
        'visibility' => $visibility,
    ],
]);
