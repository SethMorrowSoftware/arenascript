<?php

declare(strict_types=1);

require_once __DIR__ . '/../../_bootstrap.php';
require_once __DIR__ . '/../../db.php';

as_bootstrap();
as_require_method('POST');

$actor = as_require_role('admin');
$body = as_body();
$targetUserId = (string) ($body['userId'] ?? '');
$reason = trim((string) ($body['reason'] ?? ''));

as_require($targetUserId !== '', 'userId is required');
as_require($reason !== '', 'reason is required');

$pdo = as_db();

try {
    $pdo->beginTransaction();

    $suspend = $pdo->prepare('UPDATE users SET status = :status, updated_at = UTC_TIMESTAMP() WHERE id = :id');
    $suspend->execute(['status' => 'suspended', 'id' => $targetUserId]);
    as_require($suspend->rowCount() > 0, 'User not found', 404);

    $revoke = $pdo->prepare('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = :uid AND revoked_at IS NULL');
    $revoke->execute(['uid' => $targetUserId]);

    $audit = $pdo->prepare(
        'INSERT INTO admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (:actor, :action, :entity_type, :entity_id, :metadata, UTC_TIMESTAMP())'
    );
    $audit->execute([
        'actor' => $actor['id'],
        'action' => 'user_suspend',
        'entity_type' => 'user',
        'entity_id' => $targetUserId,
        'metadata' => json_encode(['reason' => $reason]),
    ]);

    $pdo->commit();
    as_respond(['ok' => true]);
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    as_fail('Unable to suspend user', $e, 500);
}
