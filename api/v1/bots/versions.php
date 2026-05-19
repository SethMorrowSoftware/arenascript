<?php

declare(strict_types=1);

require_once __DIR__ . '/../../_bootstrap.php';
require_once __DIR__ . '/../../db.php';

as_bootstrap();
as_require_method('GET', 'POST');

$user = as_require_user();
$uid = (string) $user['id'];
$pdo = as_db();
$botId = (string) ($_GET['botId'] ?? '');
as_require($botId !== '', 'botId query param is required');

$ownerCheck = $pdo->prepare('SELECT id FROM bots WHERE id = :id AND owner_user_id = :uid LIMIT 1');
$ownerCheck->execute(['id' => $botId, 'uid' => $uid]);
as_require((bool) $ownerCheck->fetch(), 'Bot not found', 404);

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'GET') {
    $stmt = $pdo->prepare(
        'SELECT id, version_label, source_code, compiled_program_json, constants_json, language_version, created_at
         FROM bot_versions
         WHERE bot_id = :bot_id
         ORDER BY created_at DESC'
    );
    $stmt->execute(['bot_id' => $botId]);
    as_respond(['versions' => $stmt->fetchAll()]);
}

$body = as_body();
$sourceCode = (string) ($body['sourceCode'] ?? '');
$compiledProgram = $body['compiledProgram'] ?? null;
$constants = $body['constants'] ?? null;
$versionLabel = trim((string) ($body['versionLabel'] ?? ''));
as_require($versionLabel !== '', 'versionLabel is required');
as_require($sourceCode !== '', 'sourceCode is required');

$versionId = as_uuid();
try {
    $pdo->beginTransaction();
    $ins = $pdo->prepare(
        'INSERT INTO bot_versions
         (id, bot_id, version_label, source_code, compiled_program_json, constants_json, language_version, created_by_user_id, created_at)
         VALUES (:id, :bot_id, :version_label, :source_code, :compiled_program, :constants, :language_version, :created_by, UTC_TIMESTAMP())'
    );
    $ins->execute([
        'id' => $versionId,
        'bot_id' => $botId,
        'version_label' => $versionLabel,
        'source_code' => $sourceCode,
        'compiled_program' => $compiledProgram !== null ? json_encode($compiledProgram) : null,
        'constants' => $constants !== null ? json_encode($constants) : null,
        'language_version' => '1.0',
        'created_by' => $uid,
    ]);

    $up = $pdo->prepare('UPDATE bots SET active_version_id = :vid, updated_at = UTC_TIMESTAMP() WHERE id = :bid');
    $up->execute(['vid' => $versionId, 'bid' => $botId]);
    $pdo->commit();

    as_respond([
        'version' => [
            'id' => $versionId,
            'botId' => $botId,
            'versionLabel' => $versionLabel,
            'active' => true,
        ],
    ], 201);
} catch (PDOException $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    as_fail('Unable to create bot version', $e, 500);
}
