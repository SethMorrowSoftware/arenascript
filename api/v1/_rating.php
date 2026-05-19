<?php

declare(strict_types=1);

function as_expected_score(float $ratingA, float $ratingB): float
{
    return 1.0 / (1.0 + pow(10, ($ratingB - $ratingA) / 400));
}

function as_k_factor(float $rating): int
{
    return $rating > 2400 ? 16 : 32;
}

/** @return array{winnerNew:int, loserNew:int, winnerDelta:int, loserDelta:int} */
function as_calculate_elo_change(float $winnerRating, float $loserRating): array
{
    $expectedWin = as_expected_score($winnerRating, $loserRating);
    $k = (as_k_factor($winnerRating) + as_k_factor($loserRating)) / 2;

    $winnerDelta = (int) round($k * (1 - $expectedWin));
    // A decisive result must always move the ladder — a wide skill gap
    // would otherwise round the transfer to zero. Mirrors js/server/ranked.js.
    if ($winnerDelta < 1) {
        $winnerDelta = 1;
    }
    if ($loserRating - $winnerDelta < 0) {
        $winnerDelta = (int) $loserRating;
    }
    $loserDelta = -$winnerDelta;

    return [
        'winnerNew' => (int) ($winnerRating + $winnerDelta),
        'loserNew' => (int) ($loserRating + $loserDelta),
        'winnerDelta' => $winnerDelta,
        'loserDelta' => $loserDelta,
    ];
}
