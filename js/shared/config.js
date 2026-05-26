// ============================================================================
// Game Balance Constants & Configuration
// ============================================================================
export const ENGINE_VERSION = "0.2.0";
export const LANGUAGE_VERSION = "1.1";
// --- Arena ---
export const ARENA_WIDTH = 140;
export const ARENA_HEIGHT = 140;
// --- Tick ---
export const TICK_RATE = 30; // ticks per second
export const MAX_TICKS = 3000; // 100 seconds
// --- Robot Defaults ---
export const ROBOT_BASE_HEALTH = 100;
export const ROBOT_BASE_ENERGY = 100;
export const ROBOT_MOVE_SPEED = 2.0; // units per tick
export const ROBOT_RADIUS = 1.0;
// --- Combat ---
export const ATTACK_DAMAGE = 10;
export const ATTACK_RANGE = 5.0;
export const ATTACK_COOLDOWN = 5; // ticks
export const ATTACK_ENERGY_COST = 10;
export const FIRE_AT_DAMAGE = 8;
export const FIRE_AT_RANGE = 15.0;
export const FIRE_AT_COOLDOWN = 8;
export const BURST_FIRE_DAMAGE = 5;
export const BURST_FIRE_RANGE = 12.0;
export const BURST_FIRE_COOLDOWN = 10;
export const GRENADE_DAMAGE = 16;
export const GRENADE_RADIUS = 3.5;
export const GRENADE_RANGE = 16.0;
export const GRENADE_COOLDOWN = 18;
export const BURST_FIRE_ENERGY_COST = 15;
export const GRENADE_ENERGY_COST = 20;
export const SHIELD_ENERGY_COST = 15;
export const PROJECTILE_SPEED = 4.0;
export const PROJECTILE_TTL = 20; // ticks
// --- Perception ---
export const LOS_RANGE = 150.0;
export const DEFAULT_VISION_RANGE = 35.0;
export const LOW_HEALTH_THRESHOLD = 25;
export const ACTIVE_SCAN_RANGE = 22.0;
export const ACTIVE_SCAN_MEMORY_TICKS = 45;
// --- Abilities ---
// While shielded, incoming damage is multiplied by (1 - SHIELD_DAMAGE_REDUCTION).
// Duration is short enough that a bot must time it to a known incoming burst.
export const SHIELD_DURATION = 12; // ticks
export const SHIELD_COOLDOWN = 30;
export const SHIELD_DAMAGE_REDUCTION = 0.6; // 60% damage taken while shielded
export const DASH_DISTANCE = 5.0;
export const DASH_COOLDOWN = 20;
// --- Budget ---
export const BUDGET_INSTRUCTIONS = 1000;
export const BUDGET_FUNCTION_CALLS = 50;
export const BUDGET_SENSOR_CALLS = 30;
export const BUDGET_MEMORY_OPS = 200;
// --- Capture ---
export const CAPTURE_RATE = 0.02; // per tick while in range
export const CAPTURE_RADIUS = 3.0;
export const CAPTURE_WIN_THRESHOLD = 1.0;
export const HEAL_ZONE_RADIUS = 4.0;
export const HEAL_ZONE_TICK_RATE = 2;
// --- Hazards ---
export const HAZARD_ZONE_RADIUS = 3.5;
export const HAZARD_DAMAGE_PER_TICK = 1;
// --- Procedural Arena ---
export const MIN_COVER_COUNT = 6;
export const MAX_COVER_COUNT = 12;
export const MIN_HEAL_ZONES = 2;
export const MAX_HEAL_ZONES = 4;
export const MIN_HAZARD_ZONES = 1;
export const MAX_HAZARD_ZONES = 3;
export const SPAWN_CLEAR_RADIUS = 15; // keep area around spawns clear of obstacles
// --- Mines ---
export const MINE_DAMAGE = 25;
export const MINE_TRIGGER_RADIUS = 2.0;
export const MINE_MAX_PER_ROBOT = 3;
export const MINE_COOLDOWN = 40;
export const MINE_ENERGY_COST = 15;
export const MINE_VISIBLE_RANGE = 5.0; // enemies can see mines within this range
// --- Pickups ---
export const PICKUP_SPAWN_INTERVAL = 150; // ticks between pickup spawns
export const PICKUP_MAX_ACTIVE = 4;
export const PICKUP_COLLECT_RADIUS = 2.0;
export const PICKUP_EFFECT_DURATION = 90; // ticks
export const PICKUP_SPEED_MULTIPLIER = 1.5;
export const PICKUP_DAMAGE_MULTIPLIER = 1.4;
export const PICKUP_VISION_BONUS = 15.0;
export const PICKUP_ENERGY_RESTORE = 50;
// --- Noise ---
export const NOISE_ATTACK_RADIUS = 25.0;
export const NOISE_MOVE_RADIUS = 8.0;
export const NOISE_GRENADE_RADIUS = 35.0;
export const NOISE_DECAY_TICKS = 15; // how long noise persists
// --- Signals ---
export const SIGNAL_RANGE = 50.0; // how far signals travel
export const SIGNAL_COOLDOWN = 10;
// --- Overwatch ---
export const OVERWATCH_DURATION = 30;
export const OVERWATCH_COOLDOWN = 45;
export const OVERWATCH_VISION_BONUS = 15.0;
export const OVERWATCH_RANGE_BONUS = 4.0;
export const OVERWATCH_ENERGY_COST = 20;
// --- Taunt ---
export const TAUNT_DURATION = 30;
export const TAUNT_COOLDOWN = 50;
export const TAUNT_RANGE = 12.0;
export const TAUNT_ENERGY_COST = 15;
// --- Destructible Cover ---
export const DESTRUCTIBLE_COVER_HP = 50;
export const DESTRUCTIBLE_COVER_RATIO = 0.3; // fraction of covers that are destructible
// --- Heat System ---
// Heat accumulates from combat/ability use. At HEAT_MAX the robot is "overheated"
// and cannot use combat actions until heat drops below HEAT_RECOVERY_THRESHOLD.
export const HEAT_MAX = 100;
export const HEAT_RECOVERY_THRESHOLD = 60;
export const HEAT_DECAY_PER_TICK = 2;
export const HEAT_DECAY_VENT = 6;      // when 'vent_heat' is the combat action
export const HEAT_ATTACK = 6;          // melee attack
export const HEAT_FIRE_AT = 10;        // standard ranged
export const HEAT_FIRE_LIGHT = 5;      // low-power rapid fire
export const HEAT_FIRE_HEAVY = 20;     // high-power slow shot
export const HEAT_BURST_FIRE = 18;
export const HEAT_GRENADE = 28;
export const HEAT_SHIELD = 8;
export const HEAT_ZAP = 14;
export const HEAT_CLOAK_PER_TICK = 1;  // heat generated each tick while cloaked
// --- Ammo System ---
// Ammo is a finite per-spawn resource, replenished by resupply depots.
export const AMMO_FIRE_AT = 2;
export const AMMO_FIRE_LIGHT = 1;
export const AMMO_FIRE_HEAVY = 4;
export const AMMO_BURST_FIRE = 6;
export const AMMO_GRENADE = 8;
// Melee attack, zap, shield, self_destruct cost no ammo.
// --- Resupply Depots ---
export const DEPOT_COUNT = 2;           // per match (one per half)
export const DEPOT_RADIUS = 3.0;
export const DEPOT_AMMO_PER_TICK = 3;   // ammo restored each tick inside
export const DEPOT_HEAT_VENT_PER_TICK = 4; // heat removed each tick inside
// --- Cloak ---
export const CLOAK_DURATION = 60;       // max ticks of cloak
export const CLOAK_COOLDOWN = 90;
export const CLOAK_ENERGY_COST = 20;
export const CLOAK_BREAK_DISTANCE = 4.0; // enemies within this range see through cloak
// --- Zap (short-range energy discharge) ---
export const ZAP_RADIUS = 4.0;
export const ZAP_DAMAGE = 18;
export const ZAP_SELF_DAMAGE = 5;
export const ZAP_COOLDOWN = 16;
export const ZAP_ENERGY_COST = 25;
// --- Self-Destruct ---
export const SELF_DESTRUCT_COUNTDOWN = 30;   // ticks from command to detonation
export const SELF_DESTRUCT_RADIUS = 7.0;
export const SELF_DESTRUCT_DAMAGE = 60;
export const SELF_DESTRUCT_HEALTH_THRESHOLD = 0.35; // only available at <=35% HP
// --- Fire power variants (bullet speed/damage tradeoff) ---
export const FIRE_LIGHT_DAMAGE = 4;
export const FIRE_LIGHT_RANGE = 18.0;
export const FIRE_LIGHT_SPEED = 6.0;
export const FIRE_LIGHT_COOLDOWN = 4;
export const FIRE_HEAVY_DAMAGE = 22;
export const FIRE_HEAVY_RANGE = 14.0;
export const FIRE_HEAVY_SPEED = 2.2;
export const FIRE_HEAVY_COOLDOWN = 14;
// --- Hive Memory (shared team key/value store) ---
export const HIVE_MAX_KEYS = 32;
// --- Ranked ---
export const INITIAL_ELO = 1000;
export const ELO_K_FACTOR = 32;
export const ELO_K_FACTOR_HIGH = 16; // for ratings > 2400
export const RANK_THRESHOLDS = {
    bronze: 0,
    silver: 1000,
    gold: 1200,
    platinum: 1400,
    diamond: 1600,
    champion: 1800,
};
export const CLASS_STATS = {
    brawler: {
        health: 120,
        energy: 80,
        moveSpeed: 2.2,
        attackDamage: 14,
        attackRange: 3.5,
        attackCooldown: 4,
        visionRange: 28.0,
        maxAmmo: 50,
        heatDissipation: 2.2,  // multiplier on HEAT_DECAY_PER_TICK
    },
    ranger: {
        health: 80,
        energy: 100,
        moveSpeed: 2.0,
        attackDamage: 10,
        attackRange: 8.0,
        attackCooldown: 6,
        visionRange: 40.0,
        maxAmmo: 100,
        heatDissipation: 1.0,
    },
    tank: {
        health: 150,
        energy: 60,
        moveSpeed: 1.5,
        attackDamage: 8,
        attackRange: 4.0,
        attackCooldown: 5,
        visionRange: 24.0,
        maxAmmo: 80,
        heatDissipation: 0.7,   // tanks overheat more easily (bigger guns)
    },
    support: {
        health: 90,
        energy: 120,
        moveSpeed: 1.8,
        attackDamage: 6,
        attackRange: 6.0,
        attackCooldown: 7,
        visionRange: 32.0,
        maxAmmo: 70,
        heatDissipation: 1.5,
    },
};
