<?php
// ============================================================================
// ArenaScript API Bootstrap
// ----------------------------------------------------------------------------
// Shared helpers used by every api/*.php HTTP endpoint:
//
//   - as_bootstrap()              Set CORS + JSON content-type, install a
//                                 JSON error handler, and parse the request
//                                 body (if any) into $_REQUEST_JSON.
//   - as_require_method(...$m)    Reject any HTTP method not in the list.
//   - as_body()                   Return the parsed JSON request body.
//   - as_respond($data, $status)  Emit JSON response and exit.
//   - as_error($msg, $status)     Emit JSON error and exit.
//   - as_require($cond, $msg)     Assert-style 400 on failure.
//   - as_fail($msg, $e, $status)  Log an exception, emit a generic error.
//
// Persistence:
//   - JsonStore                   File-backed JSON key/value store, used
//                                 only by the rate limiter (api/.storage/).
//
// Real authentication lives in db.php (MySQL-backed bearer sessions); this
// file is `require_once`'d by every endpoint and dispatches nothing itself.
// ============================================================================

declare(strict_types=1);

if (defined('AS_BOOTSTRAP_LOADED')) {
    return;
}
define('AS_BOOTSTRAP_LOADED', true);

// ----------------------------------------------------------------------------
// Storage layout
// ----------------------------------------------------------------------------

const AS_STORAGE_DIR = __DIR__ . '/.storage';

function as_storage_dir(): string
{
    if (!is_dir(AS_STORAGE_DIR)) {
        // Best-effort: 0700 so it's not world-readable if the host misconfigures
        // the docroot to serve api/. Web endpoints should never expose this dir.
        @mkdir(AS_STORAGE_DIR, 0700, true);
    }
    // Defense-in-depth: drop an Apache deny file and an empty index.html so
    // even if a host serves api/.storage/ directly (e.g. AllowOverride None
    // on api/.htaccess), the contents can't be walked by a crawler.
    $htaccess = AS_STORAGE_DIR . '/.htaccess';
    if (!is_file($htaccess)) {
        @file_put_contents($htaccess, "Require all denied\nOrder allow,deny\nDeny from all\n");
    }
    $index = AS_STORAGE_DIR . '/index.html';
    if (!is_file($index)) {
        @file_put_contents($index, '');
    }
    return AS_STORAGE_DIR;
}

// ----------------------------------------------------------------------------
// Bootstrap — headers, error handling, body parsing
// ----------------------------------------------------------------------------

/**
 * Install the standard response headers, JSON error handler, and parse
 * JSON request bodies. Call this at the top of every HTTP endpoint.
 */
function as_bootstrap(): void
{
    if (PHP_SAPI === 'cli') {
        return;
    }

    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');

    // CORS: default-deny. This is a state-mutating API, so an unconfigured
    // host emits no Access-Control-Allow-Origin at all (same-origin requests
    // — how the shipped app talks to it — do not need one). Cross-origin
    // access requires an explicit ARENA_CORS_ORIGIN allowlist.
    $corsOrigin = as_resolve_cors_origin();
    if ($corsOrigin !== null) {
        header('Access-Control-Allow-Origin: ' . $corsOrigin);
        if ($corsOrigin !== '*') {
            header('Vary: Origin');
        }
    }
    header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    header('Access-Control-Max-Age: 600');

    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
        http_response_code(204);
        exit;
    }

    // Error handlers log the real detail server-side and return a generic
    // message — internal paths and messages must never reach the client.
    set_error_handler(function (int $severity, string $message, string $file, int $line): bool {
        if (!(error_reporting() & $severity)) {
            return false;
        }
        error_log("ArenaScript PHP error: $message in $file:$line");
        as_error('Internal server error', 500);
        return true;
    });

    set_exception_handler(function (Throwable $e): void {
        error_log('ArenaScript uncaught exception: ' . $e);
        as_error('Internal server error', 500);
    });

    // Parse JSON body once and stash it for later retrieval.
    $body = null;
    if (
        ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' ||
        ($_SERVER['REQUEST_METHOD'] ?? '') === 'DELETE'
    ) {
        $raw = file_get_contents('php://input') ?: '';
        if ($raw === '') {
            $body = [];
        } else {
            // 1MB cap on request body — nothing we accept should ever be larger
            // than a compiled bot (200KB source / 65KB bytecode) plus a replay.
            if (strlen($raw) > 1_048_576) {
                as_error('Request body exceeds 1MB limit', 413);
            }
            $decoded = json_decode($raw, true);
            if (json_last_error() !== JSON_ERROR_NONE) {
                as_error('Invalid JSON: ' . json_last_error_msg(), 400);
            }
            if (!is_array($decoded)) {
                as_error('Request body must be a JSON object', 400);
            }
            $body = $decoded;
        }
    }
    $GLOBALS['AS_REQUEST_BODY'] = $body ?? [];
}

/**
 * Basic fixed-window rate limiter backed by JsonStore.
 * Returns true when allowed, false when limit exceeded.
 */
function as_rate_limit(string $bucket, int $maxRequests, int $windowSeconds): bool
{
    if ($maxRequests <= 0 || $windowSeconds <= 0) {
        return true;
    }
    $now = time();
    $window = intdiv($now, $windowSeconds);
    $key = $bucket . ':' . $window;
    $store = new JsonStore('ratelimits');

    return $store->mutate(function (array $state) use ($key, $maxRequests, $now, $window): array {
        // Drop expired fixed-window buckets so the store cannot grow without
        // bound. The window number is always the segment after the last ':'.
        $cutoff = $window - 2;
        foreach (array_keys($state) as $k) {
            $colon = strrpos((string) $k, ':');
            if ($colon !== false && (int) substr((string) $k, $colon + 1) < $cutoff) {
                unset($state[$k]);
            }
        }

        $state[$key] ??= ['count' => 0, 'updatedAt' => $now];
        $state[$key]['count'] = (int) ($state[$key]['count'] ?? 0) + 1;
        $state[$key]['updatedAt'] = $now;

        $allowed = $state[$key]['count'] <= $maxRequests;
        return [$state, $allowed];
    });
}

/** @return array<string, mixed> */
function as_body(): array
{
    return $GLOBALS['AS_REQUEST_BODY'] ?? [];
}

function as_require_method(string ...$allowed): void
{
    $m = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if (!in_array($m, $allowed, true)) {
        header('Allow: ' . implode(', ', $allowed));
        as_error("Method $m not allowed", 405);
    }
}

/**
 * Emit a JSON response and exit. Accepts any JSON-serialisable value.
 */
function as_respond(mixed $data, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * Emit an error response. Always includes { error, status }.
 */
function as_error(string $message, int $status = 400): never
{
    http_response_code($status);
    echo json_encode(
        ['error' => $message, 'status' => $status],
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE,
    );
    exit;
}

function as_require(bool $cond, string $message, int $status = 400): void
{
    if (!$cond) {
        as_error($message, $status);
    }
}

/**
 * Resolve the Access-Control-Allow-Origin value for this request, or null
 * to send no CORS header at all. ARENA_CORS_ORIGIN may be "*", a single
 * origin, or a comma-separated allowlist. With nothing configured only
 * loopback dev origins are reflected — never a wildcard.
 */
function as_resolve_cors_origin(): ?string
{
    $origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
    $configured = getenv('ARENA_CORS_ORIGIN');

    if ($configured === '*') {
        return '*';
    }
    if (is_string($configured) && $configured !== '') {
        $allow = array_map('trim', explode(',', $configured));
        return in_array($origin, $allow, true) ? $origin : null;
    }
    if ($origin !== '' && preg_match('#^https?://(localhost|127\.0\.0\.1)(:\d+)?$#', $origin) === 1) {
        return $origin;
    }
    return null;
}

/**
 * Log an exception server-side and emit a generic error to the client.
 * Internal exception text routinely leaks SQL fragments, table/column
 * names and connection details, so it must never reach the HTTP response.
 */
function as_fail(string $publicMessage, Throwable $e, int $status = 500): never
{
    error_log('ArenaScript: ' . $publicMessage . ' :: ' . $e);
    as_error($publicMessage, $status);
}

// ----------------------------------------------------------------------------
// JsonStore — file-backed key/value persistence
// ----------------------------------------------------------------------------
//
// The single MySQL-backed v1 API is authoritative for all real state. The
// only remaining JsonStore use is the fixed-window rate limiter, which keeps
// a small, self-pruning counter file under api/.storage/ — deliberately not
// in the database so a rate-limit check never depends on a DB round-trip.
//
// Each named store is a single JSON file under api/.storage/<name>.json.
// Reads are lock-free; writes take an exclusive flock for the duration of
// the read-modify-write cycle.
// ============================================================================

final class JsonStore
{
    private string $path;

    public function __construct(string $name)
    {
        if (!preg_match('/^[a-z0-9_-]+$/i', $name)) {
            throw new InvalidArgumentException("Invalid store name: $name");
        }
        $this->path = as_storage_dir() . "/$name.json";
    }

    /** @return array<string, mixed> */
    public function readAll(): array
    {
        if (!file_exists($this->path)) {
            return [];
        }
        $raw = file_get_contents($this->path);
        if ($raw === false || $raw === '') {
            return [];
        }
        $data = json_decode($raw, true);
        return is_array($data) ? $data : [];
    }

    /**
     * Read-modify-write under an exclusive lock. The callback receives the
     * current state and must return the new state. The new state is written
     * back atomically via a temp file rename so a crash in the middle of a
     * write cannot corrupt the store.
     *
     * @template T
     * @param callable(array<string, mixed>): array{0: array<string, mixed>, 1: T} $fn
     * @return T
     */
    public function mutate(callable $fn): mixed
    {
        $fh = fopen($this->path, 'c+');
        if ($fh === false) {
            throw new RuntimeException("Unable to open store: $this->path");
        }
        try {
            if (!flock($fh, LOCK_EX)) {
                throw new RuntimeException("Unable to lock store: $this->path");
            }
            $raw = stream_get_contents($fh);
            $current = [];
            if (is_string($raw) && $raw !== '') {
                $decoded = json_decode($raw, true);
                if (is_array($decoded)) {
                    $current = $decoded;
                }
            }
            [$next, $result] = $fn($current);
            $encoded = json_encode($next, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
            if ($encoded === false) {
                throw new RuntimeException('Failed to encode store state');
            }
            // Atomic replace: write to temp file in the same dir, then rename.
            $tmp = $this->path . '.tmp.' . bin2hex(random_bytes(4));
            if (file_put_contents($tmp, $encoded) === false) {
                throw new RuntimeException("Failed to write temp store: $tmp");
            }
            if (!rename($tmp, $this->path)) {
                @unlink($tmp);
                throw new RuntimeException("Failed to commit store: $this->path");
            }
            return $result;
        } finally {
            flock($fh, LOCK_UN);
            fclose($fh);
        }
    }
}

// ----------------------------------------------------------------------------
// Structural validation helpers for client-submitted payloads
// ----------------------------------------------------------------------------

/**
 * Validate a compiled program sent from the JS client. We can't re-run the
 * compiler here (the compiler is in JS), but we can sanity-check the shape
 * so that garbage submissions can't poison the lobby/tournament state.
 *
 * Returns an array of error strings (empty = valid).
 *
 * @return string[]
 */
function as_validate_program(mixed $program): array
{
    $errors = [];
    if (!is_array($program)) {
        return ['program must be an object'];
    }
    foreach (['programId', 'robotName', 'robotClass'] as $key) {
        if (!isset($program[$key]) || !is_string($program[$key]) || $program[$key] === '') {
            $errors[] = "program.$key must be a non-empty string";
        }
    }
    if (isset($program['robotClass']) && !in_array($program['robotClass'], ['brawler', 'ranger', 'tank', 'support'], true)) {
        $errors[] = "program.robotClass must be one of brawler|ranger|tank|support";
    }
    if (!isset($program['bytecode']) || !is_array($program['bytecode'])) {
        $errors[] = 'program.bytecode must be an array of bytes';
    } elseif (count($program['bytecode']) > 65535) {
        $errors[] = 'program.bytecode exceeds maximum size of 65535 bytes';
    } else {
        foreach ($program['bytecode'] as $b) {
            if (!is_int($b) || $b < 0 || $b > 255) {
                $errors[] = 'program.bytecode must contain only bytes (0-255)';
                break;
            }
        }
    }
    // Squad size is enforced client-side by the compiler (1..5). Re-check
    // here so a tampered client can't spawn an unbalanced match.
    if (isset($program['squad'])) {
        if (!is_array($program['squad'])) {
            $errors[] = 'program.squad must be an object';
        } else {
            $size = $program['squad']['size'] ?? 1;
            if (!is_int($size) || $size < 1 || $size > 5) {
                $errors[] = 'program.squad.size must be an integer from 1 to 5';
            }
            $roles = $program['squad']['roles'] ?? [];
            if (!is_array($roles)) {
                $errors[] = 'program.squad.roles must be an array';
            } elseif (count($roles) > 5) {
                $errors[] = 'program.squad.roles cannot exceed 5 entries';
            }
        }
    }
    return $errors;
}

/**
 * Validate a single participant payload from the client.
 *
 * @return string[]
 */
function as_validate_participant(mixed $p): array
{
    if (!is_array($p)) {
        return ['participant must be an object'];
    }
    $errors = [];
    if (!isset($p['playerId']) || !is_string($p['playerId']) || $p['playerId'] === '') {
        $errors[] = 'participant.playerId must be a non-empty string';
    }
    if (!isset($p['teamId']) || !is_int($p['teamId']) || $p['teamId'] < 0) {
        $errors[] = 'participant.teamId must be a non-negative integer';
    }
    $errors = array_merge($errors, array_map(
        fn(string $e): string => "participant.$e",
        as_validate_program($p['program'] ?? null),
    ));
    return $errors;
}

/**
 * Validate a client-submitted match result. We require the JS engine's
 * deterministic seed + outcome so we can detect obviously-malformed
 * submissions. Anti-cheat beyond that (e.g., re-running the match on the
 * server) is out of scope for beta.
 *
 * @return string[]
 */
function as_validate_match_result(mixed $result): array
{
    if (!is_array($result)) {
        return ['result must be an object'];
    }
    $errors = [];
    if (!array_key_exists('winner', $result) || !(is_int($result['winner']) || $result['winner'] === null)) {
        $errors[] = 'result.winner must be an integer team id or null for a draw';
    }
    if (!isset($result['tickCount']) || !is_int($result['tickCount']) || $result['tickCount'] < 0) {
        $errors[] = 'result.tickCount must be a non-negative integer';
    }
    if (!isset($result['reason']) || !is_string($result['reason'])) {
        $errors[] = 'result.reason must be a string';
    }
    if (!isset($result['seed']) || !is_int($result['seed']) || $result['seed'] < 0) {
        $errors[] = 'result.seed must be a non-negative integer';
    }
    return $errors;
}
