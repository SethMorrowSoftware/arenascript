<?php
// ============================================================================
// Daily Challenge — cloud leaderboard
// ============================================================================
//
// GET  ?day=YYYY-MM-DD            list top finishers (auth optional, public)
// POST { day, ticks, won }        record a result (auth required)
//
// Stores results in the file-backed JsonStore (api/.storage/daily.json):
//   {
//     "YYYY-MM-DD": [
//       { username, ticks, won, ts }, ...
//     ]
//   }
// Only the best winning submission per (day, username) is kept.
// ============================================================================

declare(strict_types=1);

require_once __DIR__ . '/../../_bootstrap.php';
require_once __DIR__ . '/../../db.php';

as_bootstrap();
as_require_method('GET', 'POST');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

function as_valid_day(string $d): bool
{
    return (bool) preg_match('/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/', $d);
}

$store = new JsonStore('daily');

if ($method === 'GET') {
    $day = (string) ($_GET['day'] ?? '');
    if ($day === '') {
        // Default to UTC "today" so callers can omit the parameter.
        $day = gmdate('Y-m-d');
    }
    as_require(as_valid_day($day), 'Invalid day; expected YYYY-MM-DD');

    $state = $store->readAll();
    $entries = $state[$day] ?? [];
    if (!is_array($entries)) {
        $entries = [];
    }
    // Filter winning entries, sort ascending by ticks. Top 50 are returned.
    $winners = array_values(array_filter($entries, fn($e) => !empty($e['won'])));
    usort($winners, fn($a, $b) => ((int) $a['ticks']) <=> ((int) $b['ticks']));
    $top = array_slice($winners, 0, 50);

    as_respond([
        'day' => $day,
        'count' => count($winners),
        'leaders' => $top,
    ]);
}

// --- POST (auth required) ---------------------------------------------------

$user = as_require_user();
$username = (string) ($user['username'] ?? '');
as_require($username !== '', 'User has no username');

if (!as_rate_limit('daily-post:' . (string) $user['id'], 12, 60)) {
    as_error('Too many submissions; slow down.', 429);
}

$body = as_body();
$day = trim((string) ($body['day'] ?? ''));
$ticks = $body['ticks'] ?? null;
$won = !empty($body['won']);

as_require(as_valid_day($day), 'Invalid day; expected YYYY-MM-DD');
as_require(is_int($ticks) && $ticks > 0 && $ticks <= 100000, 'ticks must be a positive integer (<=100000)');

// Sanity: don't accept submissions for days too far in the future or far in
// the past — protects the leaderboard from clock-skew abuse.
$today = gmdate('Y-m-d');
$yest  = gmdate('Y-m-d', strtotime('-2 day'));
$tom   = gmdate('Y-m-d', strtotime('+1 day'));
as_require($day >= $yest && $day <= $tom, 'Day out of acceptable submission window');

$resp = $store->mutate(function (array $state) use ($day, $username, $ticks, $won): array {
    $existing = isset($state[$day]) && is_array($state[$day]) ? $state[$day] : [];
    $userIdx = -1;
    foreach ($existing as $i => $row) {
        if (isset($row['username']) && $row['username'] === $username) { $userIdx = $i; break; }
    }
    $now = time();
    if ($userIdx === -1) {
        $existing[] = ['username' => $username, 'ticks' => $ticks, 'won' => $won, 'ts' => $now];
    } else {
        $prev = $existing[$userIdx];
        // Only overwrite when the new submission is strictly better:
        //  * a winning submission beats a non-winning one
        //  * a winning submission with fewer ticks beats a previous win
        $shouldUpdate =
            ($won && empty($prev['won'])) ||
            ($won && !empty($prev['won']) && $ticks < ((int) ($prev['ticks'] ?? PHP_INT_MAX))) ||
            (!$won && empty($prev['won'])); // record an attempt at all
        if ($shouldUpdate) {
            $existing[$userIdx] = ['username' => $username, 'ticks' => $ticks, 'won' => $won, 'ts' => $now];
        }
    }
    $state[$day] = $existing;
    return [$state, ['ok' => true]];
});

as_respond(['ok' => true]);
