// ============================================================================
// SFX — Web Audio synthesized battle sound effects
// ============================================================================
//
// No asset files. Every cue is a tiny envelope-shaped synth burst so the
// project stays a zero-build static site. The audio context is created
// lazily on the first user gesture (autoplay policies).
// ============================================================================

const STORAGE_KEY = "arenascript.sfx.enabled";
const VOLUME_KEY = "arenascript.sfx.volume";

let ctx = null;
let masterGain = null;
let enabled = readEnabled();
let volume = readVolume();
let lastPlayAt = 0;

function readEnabled() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? true : v === "1";
  } catch { return true; }
}

function readVolume() {
  try {
    const v = parseFloat(localStorage.getItem(VOLUME_KEY) || "0.35");
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.35;
  } catch { return 0.35; }
}

function ensureCtx() {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    masterGain = ctx.createGain();
    masterGain.gain.value = volume;
    masterGain.connect(ctx.destination);
  } catch {
    ctx = null;
  }
  return ctx;
}

export function isEnabled() { return enabled; }
export function getVolume() { return volume; }

export function setEnabled(v) {
  enabled = !!v;
  try { localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0"); } catch {}
  if (enabled) ensureCtx();
}

export function setVolume(v) {
  volume = Math.max(0, Math.min(1, Number(v) || 0));
  try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch {}
  if (masterGain) masterGain.gain.value = volume;
}

/**
 * Single oscillator + gain-envelope blip. All cues are built from this
 * primitive — keeps the synth code under a screenful while still producing
 * recognisably different sounds.
 */
function blip({ freq = 440, freqEnd = null, type = "sine", attack = 0.005, decay = 0.12, gain = 0.5, detune = 0 }) {
  if (!enabled) return;
  const c = ensureCtx();
  if (!c) return;
  if (c.state === "suspended") { try { c.resume(); } catch {} }

  const now = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (freqEnd != null) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), now + decay);
  }
  if (detune) osc.detune.value = detune;

  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(gain, now + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);

  osc.connect(g);
  g.connect(masterGain);
  osc.start(now);
  osc.stop(now + attack + decay + 0.05);
}

/**
 * Buffer-based white-noise burst for explosions / impacts. One-shot, GC'd
 * automatically after `stop()`.
 */
function noise({ duration = 0.25, gain = 0.4, freqFilter = 800 }) {
  if (!enabled) return;
  const c = ensureCtx();
  if (!c) return;
  if (c.state === "suspended") { try { c.resume(); } catch {} }

  const now = c.currentTime;
  const len = Math.floor(c.sampleRate * duration);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

  const src = c.createBufferSource();
  src.buffer = buf;

  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = freqFilter;

  const g = c.createGain();
  g.gain.setValueAtTime(gain, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  src.connect(filter);
  filter.connect(g);
  g.connect(masterGain);
  src.start(now);
  src.stop(now + duration + 0.05);
}

// Throttle: don't play more than ~30 cues per second total. Battles produce a
// LOT of damage events; without throttling the speakers buzz.
function throttled() {
  const now = performance.now();
  if (now - lastPlayAt < 33) return true;
  lastPlayAt = now;
  return false;
}

// ----------------------------------------------------------------------------
// Public cues
// ----------------------------------------------------------------------------

export function playFire()    { if (throttled()) return; blip({ freq: 1100, freqEnd: 600, type: "square",   attack: 0.002, decay: 0.07, gain: 0.18 }); }
export function playZap()     { blip({ freq: 1800, freqEnd: 200, type: "sawtooth", attack: 0.002, decay: 0.12, gain: 0.22 }); }
export function playHit()     { if (throttled()) return; noise({ duration: 0.06, gain: 0.18, freqFilter: 2200 }); }
export function playExplode() { noise({ duration: 0.45, gain: 0.45, freqFilter: 1400 }); blip({ freq: 80, freqEnd: 30, type: "sine", decay: 0.4, gain: 0.5 }); }
export function playKill()    { blip({ freq: 200, freqEnd: 60, type: "sawtooth", decay: 0.25, gain: 0.35 }); noise({ duration: 0.2, gain: 0.25, freqFilter: 900 }); }
export function playVictory() {
  // Major-third fanfare.
  blip({ freq: 523, type: "triangle", decay: 0.18, gain: 0.4 });
  setTimeout(() => blip({ freq: 659, type: "triangle", decay: 0.18, gain: 0.4 }), 110);
  setTimeout(() => blip({ freq: 784, type: "triangle", decay: 0.4,  gain: 0.4 }), 220);
}
export function playClick()   { blip({ freq: 900, type: "triangle", decay: 0.04, gain: 0.15 }); }
export function playStart()   { blip({ freq: 440, freqEnd: 880, type: "sine", decay: 0.25, gain: 0.3 }); }

/**
 * Dispatch the right cue for a frame's events. Called once per rendered
 * replay frame so each event is heard exactly once.
 */
export function playForEvents(events) {
  if (!enabled || !events || events.length === 0) return;
  let hadDestroyed = false;
  let damageCount = 0;
  for (const e of events) {
    if (!e || !e.type) continue;
    if (e.type === "destroyed") hadDestroyed = true;
    else if (e.type === "damaged") damageCount++;
  }
  if (hadDestroyed) playExplode();
  if (damageCount > 0) playHit();
}
