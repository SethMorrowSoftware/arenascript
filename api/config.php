<?php
// ============================================================================
// Game Balance Constants & Configuration
// ----------------------------------------------------------------------------
// This file is both:
//   1. A library of PHP constants mirroring js/shared/config.js, required
//      by the other api/*.php files.
//   2. An HTTP endpoint that returns the configuration as JSON when hit
//      directly (GET /api/config.php).
// ============================================================================

// ---- Engine / Language ----
const ENGINE_VERSION   = '0.2.0';
const LANGUAGE_VERSION = '1.1';

// ---- Arena ----
const ARENA_WIDTH  = 140;
const ARENA_HEIGHT = 140;

// ---- Tick ----
const TICK_RATE = 30;    // ticks per second
const MAX_TICKS = 3000;  // 100 seconds

// ---- Robot Defaults ----
const ROBOT_BASE_HEALTH = 100;
const ROBOT_BASE_ENERGY = 100;
const ROBOT_MOVE_SPEED  = 2.0;
const ROBOT_RADIUS      = 1.0;

// ---- Combat ----
const ATTACK_DAMAGE        = 10;
const ATTACK_RANGE         = 5.0;
const ATTACK_COOLDOWN      = 5;
const ATTACK_ENERGY_COST   = 10;
const FIRE_AT_DAMAGE       = 8;
const FIRE_AT_RANGE        = 15.0;
const FIRE_AT_COOLDOWN     = 8;
const BURST_FIRE_DAMAGE    = 5;
const BURST_FIRE_RANGE     = 12.0;
const BURST_FIRE_COOLDOWN  = 10;
const BURST_FIRE_ENERGY_COST = 15;
const GRENADE_DAMAGE       = 16;
const GRENADE_RADIUS       = 3.5;
const GRENADE_RANGE        = 16.0;
const GRENADE_COOLDOWN     = 18;
const GRENADE_ENERGY_COST  = 20;
const SHIELD_ENERGY_COST   = 15;
const PROJECTILE_SPEED     = 4.0;
const PROJECTILE_TTL       = 20;

// ---- Perception ----
const LOS_RANGE               = 150.0;
const DEFAULT_VISION_RANGE    = 35.0;
const LOW_HEALTH_THRESHOLD    = 25;
const ACTIVE_SCAN_RANGE       = 22.0;
const ACTIVE_SCAN_MEMORY_TICKS = 45;

// ---- Abilities ----
const SHIELD_DURATION = 3;
const SHIELD_COOLDOWN = 30;
const DASH_DISTANCE   = 5.0;
const DASH_COOLDOWN   = 20;

// ---- Budget ----
const BUDGET_INSTRUCTIONS   = 1000;
const BUDGET_FUNCTION_CALLS = 50;
const BUDGET_SENSOR_CALLS   = 30;
const BUDGET_MEMORY_OPS     = 200;

// ---- Capture ----
const CAPTURE_RATE          = 0.02;
const CAPTURE_RADIUS        = 3.0;
const CAPTURE_WIN_THRESHOLD = 1.0;
const HEAL_ZONE_RADIUS      = 4.0;
const HEAL_ZONE_TICK_RATE   = 2;

// ---- Hazards ----
const HAZARD_ZONE_RADIUS    = 3.5;
const HAZARD_DAMAGE_PER_TICK = 1;

// ---- Procedural Arena ----
const MIN_COVER_COUNT   = 6;
const MAX_COVER_COUNT   = 12;
const MIN_HEAL_ZONES    = 2;
const MAX_HEAL_ZONES    = 4;
const MIN_HAZARD_ZONES  = 1;
const MAX_HAZARD_ZONES  = 3;
const SPAWN_CLEAR_RADIUS = 15;

// ---- Mines ----
const MINE_DAMAGE         = 25;
const MINE_TRIGGER_RADIUS = 2.0;
const MINE_MAX_PER_ROBOT  = 3;
const MINE_COOLDOWN       = 40;
const MINE_ENERGY_COST    = 15;
const MINE_VISIBLE_RANGE  = 5.0;

// ---- Pickups ----
const PICKUP_SPAWN_INTERVAL   = 150;
const PICKUP_MAX_ACTIVE       = 4;
const PICKUP_COLLECT_RADIUS   = 2.0;
const PICKUP_EFFECT_DURATION  = 90;
const PICKUP_SPEED_MULTIPLIER = 1.5;
const PICKUP_DAMAGE_MULTIPLIER = 1.4;
const PICKUP_VISION_BONUS     = 15.0;
const PICKUP_ENERGY_RESTORE   = 50;

// ---- Noise ----
const NOISE_ATTACK_RADIUS  = 25.0;
const NOISE_MOVE_RADIUS    = 8.0;
const NOISE_GRENADE_RADIUS = 35.0;
const NOISE_DECAY_TICKS    = 15;

// ---- Signals ----
const SIGNAL_RANGE    = 50.0;
const SIGNAL_COOLDOWN = 10;

// ---- Overwatch ----
const OVERWATCH_DURATION     = 30;
const OVERWATCH_COOLDOWN     = 45;
const OVERWATCH_VISION_BONUS = 15.0;
const OVERWATCH_RANGE_BONUS  = 4.0;
const OVERWATCH_ENERGY_COST  = 20;

// ---- Taunt ----
const TAUNT_DURATION    = 30;
const TAUNT_COOLDOWN    = 50;
const TAUNT_RANGE       = 12.0;
const TAUNT_ENERGY_COST = 15;

// ---- Destructible Cover ----
const DESTRUCTIBLE_COVER_HP    = 50;
const DESTRUCTIBLE_COVER_RATIO = 0.3;

// ---- Heat System ----
const HEAT_MAX                 = 100;
const HEAT_RECOVERY_THRESHOLD  = 60;
const HEAT_DECAY_PER_TICK      = 2;
const HEAT_DECAY_VENT          = 6;
const HEAT_ATTACK              = 6;
const HEAT_FIRE_AT             = 10;
const HEAT_FIRE_LIGHT          = 5;
const HEAT_FIRE_HEAVY          = 20;
const HEAT_BURST_FIRE          = 18;
const HEAT_GRENADE             = 28;
const HEAT_SHIELD              = 8;
const HEAT_ZAP                 = 14;
const HEAT_CLOAK_PER_TICK      = 1;

// ---- Ammo System ----
const AMMO_FIRE_AT     = 2;
const AMMO_FIRE_LIGHT  = 1;
const AMMO_FIRE_HEAVY  = 4;
const AMMO_BURST_FIRE  = 6;
const AMMO_GRENADE     = 8;

// ---- Resupply Depots ----
const DEPOT_COUNT             = 2;
const DEPOT_RADIUS            = 3.0;
const DEPOT_AMMO_PER_TICK     = 3;
const DEPOT_HEAT_VENT_PER_TICK = 4;

// ---- Cloak ----
const CLOAK_DURATION       = 60;
const CLOAK_COOLDOWN       = 90;
const CLOAK_ENERGY_COST    = 20;
const CLOAK_BREAK_DISTANCE = 4.0;

// ---- Zap ----
const ZAP_RADIUS      = 4.0;
const ZAP_DAMAGE      = 18;
const ZAP_SELF_DAMAGE = 5;
const ZAP_COOLDOWN    = 16;
const ZAP_ENERGY_COST = 25;

// ---- Self-Destruct ----
const SELF_DESTRUCT_COUNTDOWN        = 30;
const SELF_DESTRUCT_RADIUS           = 7.0;
const SELF_DESTRUCT_DAMAGE           = 60;
const SELF_DESTRUCT_HEALTH_THRESHOLD = 0.35;

// ---- Fire power variants ----
const FIRE_LIGHT_DAMAGE   = 4;
const FIRE_LIGHT_RANGE    = 18.0;
const FIRE_LIGHT_SPEED    = 6.0;
const FIRE_LIGHT_COOLDOWN = 4;
const FIRE_HEAVY_DAMAGE   = 22;
const FIRE_HEAVY_RANGE    = 14.0;
const FIRE_HEAVY_SPEED    = 2.2;
const FIRE_HEAVY_COOLDOWN = 14;

// ---- Hive Memory ----
const HIVE_MAX_KEYS = 32;

// ---- Ranked ----
const INITIAL_ELO        = 1000;
const ELO_K_FACTOR       = 32;
const ELO_K_FACTOR_HIGH  = 16;

const RANK_THRESHOLDS = [
    'bronze'   => 0,
    'silver'   => 1000,
    'gold'     => 1200,
    'platinum' => 1400,
    'diamond'  => 1600,
    'champion' => 1800,
];

// ---- Robot Class Stats ----
const CLASS_STATS = [
    'brawler' => [
        'health'          => 120,
        'energy'          => 80,
        'moveSpeed'       => 2.2,
        'attackDamage'    => 14,
        'attackRange'     => 3.5,
        'attackCooldown'  => 4,
        'visionRange'     => 28.0,
        'maxAmmo'         => 50,
        'heatDissipation' => 2.2,
    ],
    'ranger' => [
        'health'          => 80,
        'energy'          => 100,
        'moveSpeed'       => 2.0,
        'attackDamage'    => 10,
        'attackRange'     => 8.0,
        'attackCooldown'  => 6,
        'visionRange'     => 40.0,
        'maxAmmo'         => 100,
        'heatDissipation' => 1.0,
    ],
    'tank' => [
        'health'          => 150,
        'energy'          => 60,
        'moveSpeed'       => 1.5,
        'attackDamage'    => 8,
        'attackRange'     => 4.0,
        'attackCooldown'  => 5,
        'visionRange'     => 24.0,
        'maxAmmo'         => 80,
        'heatDissipation' => 0.7,
    ],
    'support' => [
        'health'          => 90,
        'energy'          => 120,
        'moveSpeed'       => 1.8,
        'attackDamage'    => 6,
        'attackRange'     => 6.0,
        'attackCooldown'  => 7,
        'visionRange'     => 32.0,
        'maxAmmo'         => 70,
        'heatDissipation' => 1.5,
    ],
];

// ----------------------------------------------------------------------------
// HTTP entry point — only runs when this file is the request target.
// Other api/*.php files `require_once` this file for the constants above,
// and that require happens BEFORE their own HTTP dispatch, so we use the
// `SCRIPT_FILENAME` check to make sure we don't emit a response during a
// transitive include.
// ----------------------------------------------------------------------------
if (PHP_SAPI !== 'cli' && realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    require_once __DIR__ . '/_bootstrap.php';
    as_bootstrap();
    as_require_method('GET');
    as_respond([
        'engineVersion'   => ENGINE_VERSION,
        'languageVersion' => LANGUAGE_VERSION,
        'arena'           => ['width' => ARENA_WIDTH, 'height' => ARENA_HEIGHT],
        'tick'            => ['rate' => TICK_RATE, 'maxTicks' => MAX_TICKS],
        'budget'          => [
            'instructions'   => BUDGET_INSTRUCTIONS,
            'functionCalls'  => BUDGET_FUNCTION_CALLS,
            'sensorCalls'    => BUDGET_SENSOR_CALLS,
            'memoryOps'      => BUDGET_MEMORY_OPS,
        ],
        'ranked' => [
            'initialElo'     => INITIAL_ELO,
            'kFactor'        => ELO_K_FACTOR,
            'kFactorHigh'    => ELO_K_FACTOR_HIGH,
            'rankThresholds' => RANK_THRESHOLDS,
        ],
        'classStats' => CLASS_STATS,
    ]);
}
