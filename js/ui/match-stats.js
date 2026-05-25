// ============================================================================
// Match Stats — per-opponent win/loss tracking
// ============================================================================
//
// Records every match where the player participated, keyed by opponent bot
// key. The Bot Picker uses this to show "3W-1L vs you" chips so players
// have a personal nemesis list and motivation to revisit specific bots.
// ============================================================================

const STORAGE_KEY = "arenascript.stats.v1";

function readState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? { ...defaultState(), ...parsed } : defaultState();
  } catch { return defaultState(); }
}

function defaultState() {
  return {
    opponents: {},      // { [botKey]: { wins, losses, draws, last: ts } }
    totalsByClass: {},  // { brawler: { wins, losses }, ... }
    firstMatchAt: null,
    lastMatchAt: null,
    totalMatches: 0,
  };
}

function saveState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

/**
 * Record a single 1v1 (or single-opponent) match against a known bot key.
 * Pass `won` true/false/null where null means draw.
 */
export function recordVersus(botKey, { won, opponentClass = null } = {}) {
  if (!botKey || botKey === "__editor__") return;
  const state = readState();
  const slot = state.opponents[botKey] || { wins: 0, losses: 0, draws: 0, last: 0 };
  if (won === true) slot.wins++;
  else if (won === false) slot.losses++;
  else slot.draws++;
  slot.last = Date.now();
  state.opponents[botKey] = slot;

  if (opponentClass) {
    const c = state.totalsByClass[opponentClass] || { wins: 0, losses: 0 };
    if (won === true) c.wins++;
    else if (won === false) c.losses++;
    state.totalsByClass[opponentClass] = c;
  }

  state.totalMatches++;
  if (!state.firstMatchAt) state.firstMatchAt = Date.now();
  state.lastMatchAt = Date.now();

  saveState(state);
}

/** Returns { wins, losses, draws, played } for a given opponent key, or null. */
export function recordFor(botKey) {
  const state = readState();
  const slot = state.opponents[botKey];
  if (!slot) return null;
  return {
    wins: slot.wins | 0,
    losses: slot.losses | 0,
    draws: slot.draws | 0,
    played: (slot.wins | 0) + (slot.losses | 0) + (slot.draws | 0),
    last: slot.last,
  };
}

/** Compact label suitable for a UI chip — "3W-1L", "Never played", "—". */
export function recordLabel(botKey) {
  const r = recordFor(botKey);
  if (!r || r.played === 0) return null;
  if (r.draws > 0) return `${r.wins}W-${r.losses}L-${r.draws}D`;
  return `${r.wins}W-${r.losses}L`;
}

/** All opponents the player has fought, sorted by most-played first. */
export function listOpponents() {
  const state = readState();
  return Object.entries(state.opponents)
    .map(([botKey, slot]) => ({ botKey, ...slot, played: slot.wins + slot.losses + slot.draws }))
    .sort((a, b) => b.played - a.played);
}

export function totals() {
  return readState();
}

export function reset() {
  saveState(defaultState());
}
