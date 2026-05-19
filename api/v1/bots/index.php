<?php

declare(strict_types=1);

require_once __DIR__ . '/../../_bootstrap.php';
require_once __DIR__ . '/../../db.php';

as_bootstrap();
as_require_method('GET', 'POST');

$user = as_require_user();
$uid = (string) $user['id'];
$pdo = as_db();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    $stmt = $pdo->prepare(
        'SELECT b.id, b.name, b.slug, b.visibility, b.active_version_id, b.created_at, b.updated_at,
                bv.version_label AS active_version_label, bv.created_at AS active_version_created_at
         FROM bots b
         LEFT JOIN bot_versions bv ON bv.id = b.active_version_id
         WHERE b.owner_user_id = :uid
         ORDER BY b.updated_at DESC'
    );
    $stmt->execute(['uid' => $uid]);
    as_respond(['bots' => $stmt->fetchAll()]);
}

$body = as_body();
$name = trim((string) ($body['name'] ?? ''));
$slug = trim((string) ($body['slug'] ?? ''));
$visibility = (string) ($body['visibility'] ?? 'private');
$sourceCode = (string) ($body['sourceCode'] ?? '');
$compiledProgram = $body['compiledProgram'] ?? null;
$constants = $body['constants'] ?? null;
$versionLabel = trim((string) ($body['versionLabel'] ?? 'v1'));

as_require($name !== '', 'name is required');
if ($slug === '') {
    $slug = strtolower(trim(preg_replace('/[^a-z0-9]+/i', '-', $name) ?? ''));
    $slug = trim($slug, '-');
}
as_require(preg_match('/^[a-z0-9][a-z0-9-]{1,120}$/', $slug) === 1, 'slug must be lowercase letters, numbers, and dashes');
as_require(in_array($visibility, ['private', 'unlisted', 'public'], true), 'Invalid visibility');
as_require($sourceCode !== '', 'sourceCode is required');

$botId = as_uuid();
$versionId = as_uuid();

try {
    $pdo->beginTransaction();

    $insertBot = $pdo->prepare(
        'INSERT INTO bots (id, owner_user_id, name, slug, visibility, active_version_id, created_at, updated_at)
         VALUES (:id, :owner, :name, :slug, :visibility, NULL, UTC_TIMESTAMP(), UTC_TIMESTAMP())'
    );
    $insertBot->execute([
        'id' => $botId,
        'owner' => $uid,
        'name' => $name,
        'slug' => $slug,
        'visibility' => $visibility,
    ]);

    $insertVersion = $pdo->prepare(
        'INSERT INTO bot_versions
         (id, bot_id, version_label, source_code, compiled_program_json, constants_json, language_version, created_by_user_id, created_at)
         VALUES (:id, :bot_id, :version_label, :source_code, :compiled_program, :constants, :language_version, :created_by, UTC_TIMESTAMP())'
    );
    $insertVersion->execute([
        'id' => $versionId,
        'bot_id' => $botId,
        'version_label' => $versionLabel,
        'source_code' => $sourceCode,
        'compiled_program' => $compiledProgram !== null ? json_encode($compiledProgram) : null,
        'constants' => $constants !== null ? json_encode($constants) : null,
        'language_version' => '1.0',
        'created_by' => $uid,
    ]);

    $activate = $pdo->prepare('UPDATE bots SET active_version_id = :version_id, updated_at = UTC_TIMESTAMP() WHERE id = :bot_id');
    $activate->execute(['version_id' => $versionId, 'bot_id' => $botId]);

    $pdo->commit();

    as_respond([
        'bot' => [
            'id' => $botId,
            'name' => $name,
            'slug' => $slug,
            'visibility' => $visibility,
            'activeVersionId' => $versionId,
        ],
    ], 201);
} catch (PDOException $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    if ((int) $e->getCode() === 23000) {
        as_error('Bot slug already exists for this user', 409);
    }
    as_fail('Unable to create bot', $e, 500);
}
