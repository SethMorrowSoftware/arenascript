<?php
// ============================================================================
// ArenaScript MySQL Database Utilities
// ============================================================================

declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';

function as_load_local_env(): void
{
    static $loaded = false;
    if ($loaded) {
        return;
    }
    $loaded = true;

    $path = __DIR__ . '/.env.local';
    if (!is_file($path)) {
        return;
    }
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (!is_array($lines)) {
        return;
    }
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) {
            continue;
        }
        $parts = explode('=', $line, 2);
        if (count($parts) !== 2) {
            continue;
        }
        $key = trim($parts[0]);
        $value = trim($parts[1]);
        // A double-quoted value preserves leading/trailing spaces and other
        // characters that bare values would lose — cPanel auto-generates DB
        // passwords with such characters. Escapes: \" \\ \n.
        if (strlen($value) >= 2 && $value[0] === '"' && $value[strlen($value) - 1] === '"') {
            $value = strtr(substr($value, 1, -1), ['\\n' => "\n", '\\"' => '"', '\\\\' => '\\']);
        }
        if ($key === '') {
            continue;
        }
        if (getenv($key) === false) {
            putenv($key . '=' . $value);
            $_ENV[$key] = $value;
            $_SERVER[$key] = $value;
        }
    }
}

function as_env(string $key, ?string $default = null): ?string
{
    as_load_local_env();
    $value = getenv($key);
    if ($value === false || $value === '') {
        return $default;
    }
    return $value;
}

function as_db_enabled(): bool
{
    return as_env('ARENA_DB_ENABLED', '0') === '1';
}

function as_db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    as_require(as_db_enabled(), 'MySQL mode is not enabled on this host', 503);

    $host = as_env('ARENA_DB_HOST', '127.0.0.1');
    $port = as_env('ARENA_DB_PORT', '3306');
    $name = as_env('ARENA_DB_NAME', 'arenascript');
    $user = as_env('ARENA_DB_USER', 'root');
    $pass = as_env('ARENA_DB_PASS', '');

    $dsn = sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', $host, $port, $name);

    try {
        $pdo = new PDO($dsn, $user, $pass, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
    } catch (PDOException $e) {
        // Never echo the PDO message — it contains the DSN (host, db name).
        as_fail('Database unavailable', $e, 503);
    }

    return $pdo;
}

function as_now(): string
{
    return gmdate('Y-m-d H:i:s');
}

function as_uuid(): string
{
    $hex = bin2hex(random_bytes(16));
    return sprintf(
        '%s-%s-%s-%s-%s',
        substr($hex, 0, 8),
        substr($hex, 8, 4),
        substr($hex, 12, 4),
        substr($hex, 16, 4),
        substr($hex, 20, 12),
    );
}

function as_password_hash(string $password): string
{
    $hash = password_hash($password, PASSWORD_ARGON2ID);
    if (!is_string($hash)) {
        as_error('Unable to hash password', 500);
    }
    return $hash;
}

function as_session_token(): string
{
    return bin2hex(random_bytes(32));
}

function as_session_token_hash(string $token): string
{
    return hash('sha256', $token);
}

function as_bearer_token(): ?string
{
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!is_string($header) || $header === '') {
        return null;
    }
    if (!preg_match('/^Bearer\s+([A-Za-z0-9_\-\.~]{20,})$/', $header, $m)) {
        return null;
    }
    return $m[1];
}

function as_current_user(): ?array
{
    $token = as_bearer_token();
    if ($token === null) {
        return null;
    }

    $pdo = as_db();
    $sql = <<<SQL
SELECT u.id, u.email, u.username, u.status
FROM sessions s
JOIN users u ON u.id = s.user_id
WHERE s.token_hash = :token_hash
  AND s.revoked_at IS NULL
  AND s.expires_at > UTC_TIMESTAMP()
LIMIT 1
SQL;
    $stmt = $pdo->prepare($sql);
    $stmt->execute(['token_hash' => as_session_token_hash($token)]);
    $user = $stmt->fetch();
    if (!$user) {
        return null;
    }

    if (($user['status'] ?? 'active') !== 'active') {
        return null;
    }

    return $user;
}

function as_require_user(): array
{
    $user = as_current_user();
    if ($user === null) {
        as_error('Unauthorized', 401);
    }
    return $user;
}

function as_user_roles(string $userId): array
{
    $pdo = as_db();
    $stmt = $pdo->prepare(
        'SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = :uid'
    );
    $stmt->execute(['uid' => $userId]);
    return array_map(static fn(array $r): string => (string) $r['name'], $stmt->fetchAll());
}

function as_require_role(string $role): array
{
    $user = as_require_user();
    $roles = as_user_roles((string) $user['id']);
    if (!in_array($role, $roles, true)) {
        as_error('Forbidden', 403);
    }
    $user['roles'] = $roles;
    return $user;
}

function as_issue_session(string $userId): array
{
    $pdo = as_db();
    $token = as_session_token();
    $tokenHash = as_session_token_hash($token);
    $id = as_uuid();
    $ip = substr((string) ($_SERVER['REMOTE_ADDR'] ?? ''), 0, 64);
    $ua = substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255);
    $ttlHours = max(1, (int) (as_env('ARENA_SESSION_TTL_HOURS', '336')));

    $stmt = $pdo->prepare(
        'INSERT INTO sessions (id, user_id, token_hash, ip, user_agent, expires_at, created_at)
         VALUES (:id, :uid, :hash, :ip, :ua, DATE_ADD(UTC_TIMESTAMP(), INTERVAL :ttl HOUR), UTC_TIMESTAMP())'
    );
    $stmt->bindValue('id', $id);
    $stmt->bindValue('uid', $userId);
    $stmt->bindValue('hash', $tokenHash);
    $stmt->bindValue('ip', $ip);
    $stmt->bindValue('ua', $ua);
    $stmt->bindValue('ttl', $ttlHours, PDO::PARAM_INT);
    $stmt->execute();

    return [
        'sessionId' => $id,
        'token' => $token,
        'expiresInHours' => $ttlHours,
    ];
}
