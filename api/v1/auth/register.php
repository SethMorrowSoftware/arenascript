<?php

declare(strict_types=1);

require_once __DIR__ . '/../../_bootstrap.php';
require_once __DIR__ . '/../../db.php';

as_bootstrap();
as_require_method('POST');
as_require(
    as_rate_limit('auth_register:' . ($_SERVER['REMOTE_ADDR'] ?? 'unknown'), 10, 300),
    'Too many registrations from this IP. Try again later.',
    429,
);

$body = as_body();
$email = strtolower(trim((string) ($body['email'] ?? '')));
$username = trim((string) ($body['username'] ?? ''));
$password = (string) ($body['password'] ?? '');

as_require(filter_var($email, FILTER_VALIDATE_EMAIL) !== false, 'Valid email is required');
as_require(preg_match('/^[a-zA-Z0-9_]{3,24}$/', $username) === 1, 'Username must be 3-24 chars: letters, numbers, underscore');
as_require(strlen($password) >= 10, 'Password must be at least 10 characters');

$pdo = as_db();
$userId = as_uuid();
$now = as_now();
$hash = as_password_hash($password);

try {
    $pdo->beginTransaction();

    $stmt = $pdo->prepare(
        'INSERT INTO users (id, email, username, password_hash, status, created_at, updated_at)
         VALUES (:id, :email, :username, :hash, :status, :now, :now)'
    );
    $stmt->execute([
        'id' => $userId,
        'email' => $email,
        'username' => $username,
        'hash' => $hash,
        'status' => 'active',
        'now' => $now,
    ]);

    $roleStmt = $pdo->prepare(
        'INSERT INTO user_roles (user_id, role_id)
         SELECT :uid, id FROM roles WHERE name = :role LIMIT 1'
    );
    $roleStmt->execute([
        'uid' => $userId,
        'role' => 'user',
    ]);

    $session = as_issue_session($userId);

    $pdo->commit();

    as_respond([
        'user' => [
            'id' => $userId,
            'email' => $email,
            'username' => $username,
            'status' => 'active',
            'roles' => ['user'],
        ],
        'session' => $session,
    ], 201);
} catch (PDOException $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    if ((int) $e->getCode() === 23000) {
        as_error('Email or username is already in use', 409);
    }
    as_fail('Registration failed', $e, 500);
}
