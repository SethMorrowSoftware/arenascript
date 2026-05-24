// ============================================================================
// Achievements — milestone tracking with toast unlock celebrations
// ============================================================================
//
// Each achievement is keyed by a stable id and progresses via fact() calls
// from the rest of the app. Progress + unlock state lives in localStorage so
// it survives reloads and works offline.
// ============================================================================

const STORAGE_KEY = "arenascript.achievements.v1";

const ACHIEVEMENTS = [
  // Battle milestones
  { id: "first_blood",   icon: "🩸", title: "First Blood",       desc: "Win your first match." },
  { id: "five_wins",     icon: "🔥", title: "On Fire",           desc: "Win 5 matches total.",   target: 5 },
  { id: "ten_wins",      icon: "🏆", title: "Veteran",           desc: "Win 10 matches total.",  target: 10 },
  { id: "win_streak_3",  icon: "⚡", title: "Hat Trick",         desc: "Win 3 matches in a row.", target: 3 },
  { id: "play_count_10", icon: "🎯", title: "Persistence",       desc: "Play 10 matches.",       target: 10 },

  // Class & strategy
  { id: "class_master",  icon: "🛡️", title: "Class Master",      desc: "Win with each of the four classes.", target: 4 },
  { id: "squad_leader",  icon: "🤝", title: "Squad Leader",      desc: "Win a 3v3 or larger team battle." },
  { id: "royale_king",   icon: "👑", title: "Last Bot Standing", desc: "Win a Battle Royale." },
  { id: "untouchable",   icon: "💎", title: "Untouchable",       desc: "Win a match without taking any damage." },
  { id: "speedrun",      icon: "💨", title: "Speedrun",          desc: "Win in under 15 seconds (450 ticks)." },

  // Community + library
  { id: "code_warrior",  icon: "💾", title: "Code Warrior",      desc: "Save 5 bots to your library.", target: 5 },
  { id: "sharing_caring",icon: "🌐", title: "Sharing is Caring", desc: "Publish a bot to the community." },
  { id: "trendspotter",  icon: "⭐", title: "Trendspotter",      desc: "Install a community bot." },

  // Daily
  { id: "daily_first",   icon: "📅", title: "Daily Devotion",    desc: "Beat the Daily Challenge." },
  { id: "daily_speed",   icon: "🚀", title: "Daily Speedster",   desc: "Beat the Daily Challenge in under 20 seconds." },

  // Tournament
  { id: "bracket_champ", icon: "🏆", title: "Bracket Champion",  desc: "Win a tournament." },
  { id: "cinderella",    icon: "🥂", title: "Cinderella Run",    desc: "Win a tournament from the lower half of seeds." },
];

const listeners = new Set();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...(parsed && typeof parsed === "object" ? parsed : {}) };
  } catch {
    return defaultState();
  }
}

function defaultState() {
  return {
    unlocked: {},     // { achievementId: timestamp }
    progress: {},     // { achievementId: number }
    matchesPlayed: 0,
    matchesWon: 0,
    currentStreak: 0,
    classesWon: {},   // { brawler: true, ... }
  };
}

function saveState(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
  for (const fn of listeners) {
    try { fn(s); } catch (e) { console.error("achievement listener error", e); }
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAchievements() {
  return ACHIEVEMENTS.map((a) => ({ ...a }));
}

export function getState() {
  return loadState();
}

export function isUnlocked(id) {
  return !!loadState().unlocked[id];
}

export function progressFor(id) {
  const s = loadState();
  const def = ACHIEVEMENTS.find((a) => a.id === id);
  if (!def) return { current: 0, target: 1, percent: 0 };
  if (s.unlocked[id]) return { current: def.target || 1, target: def.target || 1, percent: 100 };
  const current = s.progress[id] || 0;
  const target = def.target || 1;
  return { current, target, percent: Math.min(100, Math.round((current / target) * 100)) };
}

function unlock(state, id) {
  if (state.unlocked[id]) return false;
  state.unlocked[id] = Date.now();
  return true;
}

function celebrate(id) {
  const def = ACHIEVEMENTS.find((a) => a.id === id);
  if (!def) return;
  // Emit a custom event so the host page can show its own UI;
  // also drop a toast via the global function if available.
  try {
    document.dispatchEvent(new CustomEvent("achievement-unlocked", { detail: def }));
  } catch {}
}

/**
 * Record an event. Event types and payloads:
 *   match_ended  { won, ffa, perTeamMax, durationTicks, damageTaken, robotClass }
 *   bot_saved    { count }   — total bots in user's local library after save
 *   bot_shared   {}
 *   bot_installed{}
 *   daily_won    { durationTicks }
 */
export function fact(type, data = {}) {
  const s = loadState();
  const unlockedThisCall = [];

  if (type === "match_ended") {
    s.matchesPlayed++;
    if (data.won) {
      s.matchesWon++;
      s.currentStreak++;
    } else {
      s.currentStreak = 0;
    }
    if (data.won && data.robotClass && ["brawler","ranger","tank","support"].includes(data.robotClass)) {
      s.classesWon[data.robotClass] = true;
    }

    // Simple wins
    if (data.won && unlock(s, "first_blood")) unlockedThisCall.push("first_blood");

    // Counters
    bumpCounter(s, "play_count_10", s.matchesPlayed, unlockedThisCall);
    if (data.won) {
      bumpCounter(s, "five_wins", s.matchesWon, unlockedThisCall);
      bumpCounter(s, "ten_wins", s.matchesWon, unlockedThisCall);
    }
    bumpCounter(s, "win_streak_3", s.currentStreak, unlockedThisCall);

    // Class master
    const classesWonCount = Object.keys(s.classesWon).length;
    bumpCounter(s, "class_master", classesWonCount, unlockedThisCall);

    if (data.won && (data.perTeamMax ?? 1) >= 3 && unlock(s, "squad_leader")) unlockedThisCall.push("squad_leader");
    if (data.won && data.ffa && unlock(s, "royale_king")) unlockedThisCall.push("royale_king");
    if (data.won && data.damageTaken === 0 && unlock(s, "untouchable")) unlockedThisCall.push("untouchable");
    if (data.won && (data.durationTicks ?? Infinity) < 450 && unlock(s, "speedrun")) unlockedThisCall.push("speedrun");
  } else if (type === "bot_saved") {
    const count = Number(data.count) || 0;
    bumpCounter(s, "code_warrior", count, unlockedThisCall);
  } else if (type === "bot_shared") {
    if (unlock(s, "sharing_caring")) unlockedThisCall.push("sharing_caring");
  } else if (type === "bot_installed") {
    if (unlock(s, "trendspotter")) unlockedThisCall.push("trendspotter");
  } else if (type === "daily_won") {
    if (unlock(s, "daily_first")) unlockedThisCall.push("daily_first");
    if ((data.durationTicks ?? Infinity) < 600 && unlock(s, "daily_speed")) unlockedThisCall.push("daily_speed");
  } else if (type === "tournament_won") {
    if (unlock(s, "bracket_champ")) unlockedThisCall.push("bracket_champ");
    // Lower half of the seeds = #5..#8 in an 8-bracket, #9..#16 in a 16.
    if ((data.seed ?? 1) > Math.ceil((data.bracketSize ?? 8) / 2) && unlock(s, "cinderella")) {
      unlockedThisCall.push("cinderella");
    }
  }

  saveState(s);
  for (const id of unlockedThisCall) celebrate(id);
}

function bumpCounter(state, id, current, unlockedList) {
  if (state.unlocked[id]) return;
  const def = ACHIEVEMENTS.find((a) => a.id === id);
  if (!def) return;
  state.progress[id] = Math.max(state.progress[id] || 0, current);
  if (state.progress[id] >= (def.target || 1)) {
    state.unlocked[id] = Date.now();
    unlockedList.push(id);
  }
}

/** Total unlocked / total count, for the header pill. */
export function summary() {
  const s = loadState();
  return { unlocked: Object.keys(s.unlocked).length, total: ACHIEVEMENTS.length };
}
