<?php
// ArenaScript Shared-Hosting Installer

declare(strict_types=1);

$lockPath = __DIR__ . '/.installed.lock';
$envPath = __DIR__ . '/.env.local';
$migrations = [
    __DIR__ . '/migrations/001_mysql_core.sql',
    __DIR__ . '/migrations/002_competitive_core.sql',
];

function h(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

$errors = [];
$success = [];
$remoteAddr = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
$isLocal = in_array($remoteAddr, ['127.0.0.1', '::1', ''], true);
$installerEnabled = getenv('ARENA_ALLOW_INSTALLER') === '1';

if (!$isLocal && !$installerEnabled) {
    $errors[] = 'Installer is disabled for non-local requests. Set ARENA_ALLOW_INSTALLER=1 to enable temporarily.';
}

if (is_file($lockPath)) {
    // The lock is absolute: there is deliberately no web-facing override.
    // Re-running requires filesystem access (cPanel File Manager / SSH),
    // which keeps a stranger from re-pointing the install at their own DB.
    $errors[] = 'Installer is locked — this host is already installed. To re-run, delete api/.installed.lock via your file manager or SSH.';
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST' && count($errors) === 0) {
    $host = trim((string) ($_POST['db_host'] ?? '127.0.0.1'));
    $port = trim((string) ($_POST['db_port'] ?? '3306'));
    $name = trim((string) ($_POST['db_name'] ?? 'arenascript'));
    $user = trim((string) ($_POST['db_user'] ?? ''));
    $pass = (string) ($_POST['db_pass'] ?? '');

    $adminEmail = strtolower(trim((string) ($_POST['admin_email'] ?? '')));
    $adminUser = trim((string) ($_POST['admin_username'] ?? ''));
    $adminPass = (string) ($_POST['admin_password'] ?? '');

    if ($host === '' || $port === '' || $name === '' || $user === '') {
        $errors[] = 'Database host, port, name, and user are required.';
    }
    if (!filter_var($adminEmail, FILTER_VALIDATE_EMAIL)) {
        $errors[] = 'Admin email is invalid.';
    }
    if (!preg_match('/^[a-zA-Z0-9_]{3,24}$/', $adminUser)) {
        $errors[] = 'Admin username must be 3-24 chars (letters, numbers, underscore).';
    }
    if (strlen($adminPass) < 10) {
        $errors[] = 'Admin password must be at least 10 characters.';
    }

    if (count($errors) === 0) {
        $dsn = sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', $host, $port, $name);
        try {
            $pdo = new PDO($dsn, $user, $pass, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
            ]);

            foreach ($migrations as $migration) {
                if (!is_file($migration)) {
                    throw new RuntimeException('Missing migration file: ' . $migration);
                }
                $sql = file_get_contents($migration);
                if (!is_string($sql) || trim($sql) === '') {
                    throw new RuntimeException('Migration file is empty: ' . $migration);
                }
                $pdo->exec($sql);
            }

            $adminId = bin2hex(random_bytes(16));
            $adminUuid = sprintf(
                '%s-%s-%s-%s-%s',
                substr($adminId, 0, 8),
                substr($adminId, 8, 4),
                substr($adminId, 12, 4),
                substr($adminId, 16, 4),
                substr($adminId, 20, 12),
            );
            $hash = password_hash($adminPass, PASSWORD_ARGON2ID);
            if (!is_string($hash)) {
                throw new RuntimeException('Unable to hash admin password.');
            }

            $pdo->beginTransaction();
            $insertAdmin = $pdo->prepare(
                'INSERT INTO users (id, email, username, password_hash, status, created_at, updated_at)
                 VALUES (:id, :email, :username, :hash, :status, UTC_TIMESTAMP(), UTC_TIMESTAMP())
                 ON DUPLICATE KEY UPDATE updated_at = UTC_TIMESTAMP()'
            );
            $insertAdmin->execute([
                'id' => $adminUuid,
                'email' => $adminEmail,
                'username' => $adminUser,
                'hash' => $hash,
                'status' => 'active',
            ]);

            $findAdmin = $pdo->prepare('SELECT id FROM users WHERE email = :email LIMIT 1');
            $findAdmin->execute(['email' => $adminEmail]);
            $adminRow = $findAdmin->fetch();
            if (!is_array($adminRow)) {
                throw new RuntimeException('Unable to create/find admin user.');
            }
            $adminUserId = (string) $adminRow['id'];

            $roleAssign = $pdo->prepare(
                'INSERT IGNORE INTO user_roles (user_id, role_id)
                 SELECT :uid, id FROM roles WHERE name IN ("user", "admin")'
            );
            $roleAssign->execute(['uid' => $adminUserId]);
            $pdo->commit();

            // Quote every value so credentials with spaces or special
            // characters (cPanel auto-generates such passwords) round-trip
            // intact through the .env.local parser in db.php.
            $envQuote = static fn(string $v): string =>
                '"' . strtr($v, ['\\' => '\\\\', '"' => '\\"', "\n" => '\\n']) . '"';
            $envContent = implode("\n", [
                'ARENA_DB_ENABLED=1',
                'ARENA_DB_HOST=' . $envQuote($host),
                'ARENA_DB_PORT=' . $envQuote($port),
                'ARENA_DB_NAME=' . $envQuote($name),
                'ARENA_DB_USER=' . $envQuote($user),
                'ARENA_DB_PASS=' . $envQuote($pass),
                'ARENA_SESSION_TTL_HOURS=336',
                '',
            ]);

            if (file_put_contents($envPath, $envContent) === false) {
                throw new RuntimeException('Failed to write api/.env.local');
            }
            @chmod($envPath, 0600);

            if (file_put_contents($lockPath, 'installed ' . gmdate('c')) === false) {
                throw new RuntimeException('Failed to write install lock file.');
            }

            $success[] = 'Installation complete.';
            $success[] = 'Created/updated admin user: ' . $adminEmail;
            $success[] = 'Saved DB config to api/.env.local and locked installer at api/.installed.lock.';
        } catch (Throwable $e) {
            if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
                $pdo->rollBack();
            }
            $errors[] = $e->getMessage();
        }
    }
}
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ArenaScript Installer</title>
  <style>
    body { font-family: system-ui, Arial, sans-serif; margin: 0; background: #0f1220; color: #f3f4f6; }
    .wrap { max-width: 900px; margin: 40px auto; padding: 24px; background: #161a2e; border-radius: 12px; }
    h1 { margin-top: 0; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    label { display: block; font-size: 14px; margin-bottom: 6px; }
    input { width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid #374151; border-radius: 8px; background: #0b0f1f; color: #f3f4f6; }
    .full { grid-column: 1 / -1; }
    button { margin-top: 14px; padding: 12px 16px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; cursor: pointer; font-weight: 700; }
    .msg { padding: 10px 12px; border-radius: 8px; margin: 10px 0; }
    .err { background: #3b1620; border: 1px solid #7f1d1d; }
    .ok { background: #10281a; border: 1px solid #166534; }
    .tip { color: #cbd5e1; font-size: 14px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>ArenaScript one-click installer</h1>
    <p class="tip">For cPanel/shared hosting: create a MySQL database and user in cPanel first, then run this page once.</p>

    <?php foreach ($errors as $e): ?>
      <div class="msg err"><?= h($e) ?></div>
    <?php endforeach; ?>

    <?php foreach ($success as $s): ?>
      <div class="msg ok"><?= h($s) ?></div>
    <?php endforeach; ?>

    <form method="post">
      <div class="grid">
        <div>
          <label>DB Host</label>
          <input name="db_host" value="<?= h((string)($_POST['db_host'] ?? 'localhost')) ?>" required>
        </div>
        <div>
          <label>DB Port</label>
          <input name="db_port" value="<?= h((string)($_POST['db_port'] ?? '3306')) ?>" required>
        </div>
        <div>
          <label>DB Name</label>
          <input name="db_name" value="<?= h((string)($_POST['db_name'] ?? '')) ?>" required>
        </div>
        <div>
          <label>DB User</label>
          <input name="db_user" value="<?= h((string)($_POST['db_user'] ?? '')) ?>" required>
        </div>
        <div class="full">
          <label>DB Password</label>
          <input name="db_pass" type="password" value="<?= h((string)($_POST['db_pass'] ?? '')) ?>">
        </div>

        <div class="full"><hr style="border-color:#374151"></div>

        <div>
          <label>Admin Email</label>
          <input name="admin_email" type="email" value="<?= h((string)($_POST['admin_email'] ?? '')) ?>" required>
        </div>
        <div>
          <label>Admin Username</label>
          <input name="admin_username" value="<?= h((string)($_POST['admin_username'] ?? 'admin')) ?>" required>
        </div>
        <div class="full">
          <label>Admin Password</label>
          <input name="admin_password" type="password" required>
        </div>
      </div>

      <button type="submit">Run Installer</button>
    </form>
  </div>
</body>
</html>
