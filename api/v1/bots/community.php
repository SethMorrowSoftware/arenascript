<?php

declare(strict_types=1);

require_once __DIR__ . '/../../_bootstrap.php';
require_once __DIR__ . '/../../db.php';

as_bootstrap();
as_require_method('GET');

$pdo = as_db();
$id = isset($_GET['id']) ? trim((string) $_GET['id']) : '';

if ($id !== '') {
    // Single bot detail — must be public. Returns source code so callers can
    // install it into their local library and play with it.
    as_require(preg_match('/^[A-Za-z0-9\-]{8,64}$/', $id) === 1, 'Invalid bot id');

    $stmt = $pdo->prepare(
        'SELECT b.id, b.name, b.slug, b.visibility, b.updated_at, b.created_at,
                u.username AS author_username,
                bv.source_code, bv.version_label, bv.language_version, bv.created_at AS version_created_at
         FROM bots b
         JOIN users u ON u.id = b.owner_user_id
         LEFT JOIN bot_versions bv ON bv.id = b.active_version_id
         WHERE b.id = :id AND b.visibility = "public"
         LIMIT 1'
    );
    $stmt->execute(['id' => $id]);
    $row = $stmt->fetch();
    if (!$row) {
        as_error('Bot not found or not public', 404);
    }
    as_respond(['bot' => $row]);
}

// Listing — paginated. No auth required; this is the community gallery.
$limit = (int) ($_GET['limit'] ?? 50);
if ($limit < 1) {
    $limit = 50;
} elseif ($limit > 100) {
    $limit = 100;
}
$offset = (int) ($_GET['offset'] ?? 0);
if ($offset < 0) {
    $offset = 0;
}

$search = trim((string) ($_GET['q'] ?? ''));
$sort = (string) ($_GET['sort'] ?? 'recent');
$orderBy = match ($sort) {
    'name' => 'b.name ASC',
    'oldest' => 'b.updated_at ASC',
    default => 'b.updated_at DESC',
};

$where = ['b.visibility = "public"'];
$params = [];
if ($search !== '') {
    $where[] = '(b.name LIKE :q OR u.username LIKE :q)';
    $params['q'] = '%' . $search . '%';
}
$whereSql = implode(' AND ', $where);

$sql = "SELECT b.id, b.name, b.slug, b.updated_at, b.created_at,
               u.username AS author_username,
               bv.source_code, bv.version_label, bv.created_at AS version_created_at
        FROM bots b
        JOIN users u ON u.id = b.owner_user_id
        LEFT JOIN bot_versions bv ON bv.id = b.active_version_id
        WHERE $whereSql
        ORDER BY $orderBy
        LIMIT :lim OFFSET :off";

$stmt = $pdo->prepare($sql);
foreach ($params as $k => $v) {
    $stmt->bindValue($k, $v);
}
$stmt->bindValue('lim', $limit, PDO::PARAM_INT);
$stmt->bindValue('off', $offset, PDO::PARAM_INT);
$stmt->execute();
$rows = $stmt->fetchAll();

$countStmt = $pdo->prepare("SELECT COUNT(*) AS n FROM bots b JOIN users u ON u.id = b.owner_user_id WHERE $whereSql");
foreach ($params as $k => $v) {
    $countStmt->bindValue($k, $v);
}
$countStmt->execute();
$total = (int) ($countStmt->fetchColumn() ?: 0);

as_respond([
    'bots' => $rows,
    'total' => $total,
    'limit' => $limit,
    'offset' => $offset,
]);
