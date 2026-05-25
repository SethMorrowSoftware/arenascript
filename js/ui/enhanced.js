// ============================================================================
// Enhanced UI (v0.2) — Command Palette, Keyboard Shortcut Help,
// Language Reference Drawer, Match Loading Overlay, Match History
// ============================================================================
//
// These widgets live in their own module so app.js doesn't balloon further.
// They hook into the main app by accepting a small set of callbacks at
// install time (compile / run / load-bot / enter-view), and they read the
// read-only snapshots the app exposes through the same function.
// ============================================================================

import { LANG_REFERENCE } from "./lang-reference-data.js";

const MATCH_HISTORY_KEY = "arenascript.match_history.v1";
const MATCH_HISTORY_MAX = 25;

// --- Match history persistence ----------------------------------------------

export function recordMatchHistory(entry) {
  try {
    const raw = localStorage.getItem(MATCH_HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift({
      id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
      ...entry,
    });
    while (list.length > MATCH_HISTORY_MAX) list.pop();
    localStorage.setItem(MATCH_HISTORY_KEY, JSON.stringify(list));
    return list;
  } catch (e) {
    console.warn("recordMatchHistory failed", e);
    return [];
  }
}

export function getMatchHistory() {
  try {
    const raw = localStorage.getItem(MATCH_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

export function clearMatchHistory() {
  localStorage.removeItem(MATCH_HISTORY_KEY);
}

// --- Match loading overlay --------------------------------------------------

const loadingEl = () => document.getElementById("match-loading");
const loadingTextEl = () => document.getElementById("match-loading-text");
const loadingSubEl = () => document.getElementById("match-loading-sub");

export function showMatchLoading(text = "Simulating match…", sub = "Preparing combatants") {
  const el = loadingEl();
  if (!el) return;
  if (loadingTextEl()) loadingTextEl().textContent = text;
  if (loadingSubEl()) loadingSubEl().textContent = sub;
  el.hidden = false;
}

export function updateMatchLoading(sub) {
  if (loadingSubEl() && sub) loadingSubEl().textContent = sub;
}

export function hideMatchLoading() {
  const el = loadingEl();
  if (el) el.hidden = true;
}

// --- Keyboard shortcut help modal ------------------------------------------

export function installShortcutHelp() {
  const modal = document.getElementById("shortcut-help");
  const closeBtn = document.getElementById("btn-close-shortcut-help");
  const openBtn = document.getElementById("btn-show-help");
  if (!modal) return;

  const open = () => { modal.hidden = false; };
  const close = () => { modal.hidden = true; };

  closeBtn?.addEventListener("click", close);
  openBtn?.addEventListener("click", open);

  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });

  // Shift+? opens the dialog. We use "?" as the key so layout differences
  // (which shift a different punctuation key into /?) still work.
  document.addEventListener("keydown", (e) => {
    if (e.key === "?" && !isTypingTarget(e.target)) {
      e.preventDefault();
      modal.hidden ? open() : close();
    }
    if (e.key === "Escape" && !modal.hidden) close();
  });
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

// --- Language reference drawer ---------------------------------------------

export function installLangReference() {
  const drawer = document.getElementById("lang-ref-drawer");
  const closeBtn = document.getElementById("btn-close-lang-ref");
  const openBtn = document.getElementById("btn-open-lang-ref");
  const navEl = document.getElementById("lang-ref-nav");
  const contentEl = document.getElementById("lang-ref-content");
  const searchEl = document.getElementById("lang-ref-search");
  if (!drawer || !navEl || !contentEl) return;

  let currentSection = LANG_REFERENCE[0]?.id ?? null;
  let currentQuery = "";

  function render() {
    navEl.innerHTML = "";
    for (const section of LANG_REFERENCE) {
      const btn = document.createElement("button");
      btn.textContent = section.label;
      btn.classList.toggle("active", section.id === currentSection);
      btn.addEventListener("click", () => {
        currentSection = section.id;
        render();
      });
      navEl.appendChild(btn);
    }

    const section = LANG_REFERENCE.find(s => s.id === currentSection) ?? LANG_REFERENCE[0];
    if (!section) return;
    const q = currentQuery.trim().toLowerCase();
    const entries = section.entries.filter(e => {
      if (!q) return true;
      return (e.name + " " + (e.desc || "") + " " + (e.sig || ""))
        .toLowerCase()
        .includes(q);
    });

    contentEl.innerHTML = "";
    if (entries.length === 0) {
      contentEl.innerHTML = `<div style="color:var(--text-muted); padding: 20px 0; text-align: center;">No entries match "${escapeHtml(q)}".</div>`;
      return;
    }

    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "lang-ref-entry";
      row.innerHTML = `
        <code class="name">${escapeHtml(entry.name)}</code>
        ${entry.sig ? `<div class="sig">${escapeHtml(entry.sig)}</div>` : ""}
        <div class="desc">${escapeHtml(entry.desc ?? "")}</div>
        ${entry.example ? `<pre>${escapeHtml(entry.example)}</pre>` : ""}`;
      contentEl.appendChild(row);
    }
  }

  function open(sectionId) {
    if (sectionId) currentSection = sectionId;
    drawer.hidden = false;
    render();
    setTimeout(() => searchEl?.focus(), 50);
  }

  function close() { drawer.hidden = true; }

  closeBtn?.addEventListener("click", close);
  openBtn?.addEventListener("click", () => open());

  searchEl?.addEventListener("input", (e) => {
    currentQuery = e.target.value;
    render();
  });

  document.addEventListener("keydown", (e) => {
    // Ctrl/Cmd + / opens reference
    if ((e.ctrlKey || e.metaKey) && e.key === "/") {
      e.preventDefault();
      drawer.hidden ? open() : close();
    }
    if (e.key === "Escape" && !drawer.hidden) close();
  });

  return { open, close };
}

// --- Command palette --------------------------------------------------------

export function installCommandPalette(getCommands) {
  const palette = document.getElementById("cmd-palette");
  const input = document.getElementById("cmd-palette-input");
  const list = document.getElementById("cmd-palette-list");
  const openBtn = document.getElementById("btn-open-palette");
  const backdrop = palette?.querySelector(".cmd-palette-backdrop");
  if (!palette || !input || !list) return;

  let commands = [];
  let filtered = [];
  let active = 0;

  function open() {
    commands = getCommands();
    input.value = "";
    filterAndRender("");
    palette.hidden = false;
    setTimeout(() => input.focus(), 20);
  }
  function close() {
    palette.hidden = true;
  }

  function filterAndRender(query) {
    const q = query.trim().toLowerCase();
    filtered = !q
      ? commands
      : commands
          .map(c => ({ c, score: scoreMatch(c, q) }))
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map(x => x.c);
    active = 0;
    render();
  }

  function render() {
    list.innerHTML = "";
    if (filtered.length === 0) {
      list.innerHTML = `<div class="cmd-empty">No matches.</div>`;
      return;
    }
    for (let i = 0; i < filtered.length; i++) {
      const cmd = filtered[i];
      const div = document.createElement("div");
      div.className = "cmd-item" + (i === active ? " active" : "");
      div.setAttribute("role", "option");
      div.innerHTML = `
        <span class="cmd-item-icon kind-${cmd.kind}">${cmd.icon ?? "•"}</span>
        <span class="cmd-item-label">${escapeHtml(cmd.label)}</span>
        ${cmd.hint ? `<span class="cmd-item-hint">${escapeHtml(cmd.hint)}</span>` : ""}`;
      div.addEventListener("click", () => {
        try { cmd.run(); } catch (err) { console.error("command failed", err); }
        close();
      });
      div.addEventListener("mouseenter", () => {
        active = i;
        updateActive();
      });
      list.appendChild(div);
    }
  }

  function updateActive() {
    [...list.children].forEach((el, i) => {
      el.classList.toggle("active", i === active);
    });
    const el = list.children[active];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("input", (e) => filterAndRender(e.target.value));

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length === 0) return;
      active = (active + 1) % filtered.length;
      updateActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length === 0) return;
      active = (active - 1 + filtered.length) % filtered.length;
      updateActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[active];
      if (cmd) {
        try { cmd.run(); } catch (err) { console.error("command failed", err); }
        close();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  backdrop?.addEventListener("click", close);
  openBtn?.addEventListener("click", open);

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      palette.hidden ? open() : close();
    }
  });

  return { open, close };
}

// Fuzzy-match score: higher = better.
// Prefers prefix hits, then substring, then scattered-char hits.
function scoreMatch(cmd, query) {
  const hay = (cmd.label + " " + (cmd.hint ?? "") + " " + (cmd.keywords ?? []).join(" "))
    .toLowerCase();
  if (hay.startsWith(query)) return 100;
  const idx = hay.indexOf(query);
  if (idx >= 0) return 80 - idx;
  // Scattered character match (very loose)
  let j = 0;
  for (let i = 0; i < hay.length && j < query.length; i++) {
    if (hay[i] === query[j]) j++;
  }
  if (j === query.length) return 30 - (hay.length - query.length) * 0.1;
  return 0;
}

// --- Onboarding tour --------------------------------------------------------
//
// A simple step-through modal that runs on the user's first visit (and on
// demand via the Tour button). Each step is just markup; we don't try to
// pin hotspots over live UI because the layout shifts between views and it
// becomes a maintenance nightmare. Instead the tour text tells the user
// exactly where each feature lives ("top-right", "sidebar", etc.) and the
// final step highlights the Rookie preset as the obvious next action.

const ONBOARDING_KEY = "arenascript.onboarded.v2";

const ONBOARDING_STEPS = [
  {
    title: "Welcome to ArenaScript",
    body: `
      <div class="ob-hero">
        <div class="ob-hero-icon" aria-hidden="true">&#129302;</div>
        <p class="ob-lede">Build a squad of robots, watch them fight in real time, and — when you're ready — code your own.</p>
        <ul class="ob-bullets">
          <li><b>No code required to play.</b> Pick robots from a visual roster and hit fight.</li>
          <li><b>Deterministic engine.</b> Same seed always replays the exact same match.</li>
          <li><b>Custom DSL when you want one.</b> Write a robot in ~20 lines and watch it improve.</li>
        </ul>
        <p class="ob-foot-hint">This tour takes about 30 seconds. You can re-open it anytime from the <b>Tour</b> button.</p>
      </div>`,
  },
  {
    title: "Step 1 — Pick your squad",
    body: `
      <div class="ob-step">
        <p>Click the <b>Quick Battle</b> button in the top bar to open the Team Builder. From there you can:</p>
        <ul class="ob-bullets">
          <li><b>+ Add</b> opens a visual roster picker — every robot has a tagline, class, and stat bars (HP / SPD / DMG / RNG).</li>
          <li><b>Change</b> swaps a slot. <b>Auto-fill</b> drops in varied opponents.</li>
          <li>Toggle <b>Battle Royale</b> for a free-for-all with up to 20 bots.</li>
        </ul>
        <p class="ob-pro-tip"><b>Pro tip:</b> the star ⭐ icon is <em>your</em> editor bot. Every battle features it by default.</p>
      </div>`,
    action: { label: "Try it now", openTeamBuilder: true },
  },
  {
    title: "Step 2 — Watch the fight",
    body: `
      <div class="ob-step">
        <p>Hit <b>Run Battle</b> and the arena takes over the screen with a cinematic broadcast view:</p>
        <ul class="ob-bullets">
          <li><b>Live HP bars</b> for every combatant on the left and right rails.</li>
          <li><b>Kill feed</b> on the top right shows who got eliminated.</li>
          <li><b>Floating damage numbers</b> + explosions fire as it happens.</li>
          <li><b>Replay scrubber</b> lets you rewind, step, and re-watch at 0.24× → 8× speed.</li>
        </ul>
        <p>Each class has a distinct silhouette: <b>brawler</b> hexagon, <b>ranger</b> kite, <b>tank</b> octagon, <b>support</b> cross.</p>
      </div>`,
  },
  {
    title: "Step 3 — Today's challenge",
    body: `
      <div class="ob-step">
        <p>Every day brings a fresh <b>Daily Challenge</b>: a fixed opponent + arena + seed that's the same for everyone. Beat them and your best time gets logged locally.</p>
        <p>You'll see it on the <b>Builder</b> sidebar — purple card at the top.</p>
        <p class="ob-pro-tip"><b>Compete socially:</b> share your seed link from the Arena view ("Share" button) so a friend can run the exact same fight.</p>
      </div>`,
  },
  {
    title: "Step 4 — Build your own bot",
    body: `
      <div class="ob-step">
        <p>When you're ready to code, the <b>Builder</b> tab has a syntax-highlighted editor with autocomplete and inline errors. Start from one of the heavily-commented tutorial bots in the sidebar:</p>
        <ul class="ob-bullets">
          <li><b>Rookie</b> — 12 lines, the cleanest possible bot</li>
          <li><b>Scout</b> — introduces <code>state</code>, <code>log()</code>, waypoints</li>
          <li><b>Predator</b> — full predictive combat, dodging, hive coordination</li>
        </ul>
        <p>Save your bot, sign in to sync it to the cloud, and click <b>Share</b> to publish it to the <b>Community</b> gallery for everyone to play.</p>
      </div>`,
    action: { label: "Let's go", bot: "rookie" },
  },
];

export function installOnboarding({ loadBot } = {}) {
  const modal = document.getElementById("onboarding-modal");
  const stepsEl = document.getElementById("onboarding-steps");
  const titleEl = document.getElementById("onboarding-title");
  const progressEl = document.getElementById("onboarding-progress");
  const prevBtn = document.getElementById("btn-onboarding-prev");
  const nextBtn = document.getElementById("btn-onboarding-next");
  const skipBtn = document.getElementById("btn-onboarding-skip");
  const closeBtn = document.getElementById("btn-close-onboarding");
  const openBtn = document.getElementById("btn-open-tour");
  if (!modal || !stepsEl) return;

  let current = 0;

  function markSeen() {
    try { localStorage.setItem(ONBOARDING_KEY, "1"); } catch (e) { /* private mode */ }
  }

  function render() {
    const step = ONBOARDING_STEPS[current];
    titleEl.textContent = step.title;
    stepsEl.innerHTML = step.body;
    progressEl.innerHTML = ONBOARDING_STEPS.map((_, i) =>
      `<span class="dot${i === current ? " active" : ""}"></span>`
    ).join("");
    prevBtn.disabled = current === 0;
    // Steps can override the Next-button label; the final step uses its
    // action label, intermediate steps with an action use it too.
    const isLast = current === ONBOARDING_STEPS.length - 1;
    if (step.action?.label) {
      nextBtn.textContent = step.action.label;
    } else {
      nextBtn.textContent = isLast ? "Done" : "Next";
    }
  }

  function open() {
    current = 0;
    render();
    modal.hidden = false;
  }

  function close() {
    modal.hidden = true;
    markSeen();
  }

  function next() {
    const step = ONBOARDING_STEPS[current];
    const isLast = current === ONBOARDING_STEPS.length - 1;
    // Intermediate step CTA (e.g. "Try it now") — fire the action then advance.
    if (!isLast && step.action?.openTeamBuilder) {
      close();
      // Defer so the modal closes cleanly before another modal opens.
      setTimeout(() => {
        document.getElementById("btn-quick-battle")?.click();
      }, 100);
      // Mark the tour as seen — they've taken the action.
      markSeen();
      return;
    }
    if (current < ONBOARDING_STEPS.length - 1) {
      current++;
      render();
      return;
    }
    if (step.action && typeof loadBot === "function" && step.action.bot) {
      try { loadBot(step.action.bot); } catch (e) { /* non-fatal */ }
    }
    close();
  }

  function prev() {
    if (current > 0) { current--; render(); }
  }

  nextBtn.addEventListener("click", next);
  prevBtn.addEventListener("click", prev);
  skipBtn.addEventListener("click", close);
  closeBtn.addEventListener("click", close);
  openBtn?.addEventListener("click", open);

  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  document.addEventListener("keydown", (e) => {
    if (modal.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if (e.key === "ArrowRight") { e.preventDefault(); next(); }
    if (e.key === "ArrowLeft")  { e.preventDefault(); prev(); }
  });

  // Show on first visit. Defer past initial render so the layout has settled.
  try {
    if (!localStorage.getItem(ONBOARDING_KEY)) {
      setTimeout(open, 400);
    }
  } catch (e) { /* private mode -> skip auto-open */ }
}

// --- Editor autocomplete ----------------------------------------------------
//
// Lightweight IntelliSense for the ArenaScript editor. We derive the
// completion list from the same LANG_REFERENCE data that feeds the reference
// drawer (single source of truth) plus a small hardcoded keyword set, so
// every new sensor added to the reference immediately shows up in the popup.
//
// Trigger rules:
//   * Any identifier character (word) >= 2 chars long opens the popup.
//   * Arrow keys navigate, Tab/Enter accept, Escape dismisses.
//   * Caret position is approximated from the textarea's computed line-height
//     and character width (the editor uses a monospace font). We don't try to
//     handle soft-wrap because the editor disables it.

const KEYWORD_COMPLETIONS = [
  { label: "on tick", kind: "event", snippet: "on tick {\n  \n}" },
  { label: "on spawn", kind: "event", snippet: "on spawn {\n  \n}" },
  { label: "on damaged(event)", kind: "event", snippet: "on damaged(event) {\n  \n}" },
  { label: "on low_health", kind: "event", snippet: "on low_health {\n  \n}" },
  { label: "on destroyed", kind: "event", snippet: "on destroyed {\n  \n}" },
  { label: "on enemy_seen(event)", kind: "event", snippet: "on enemy_seen(event) {\n  \n}" },
  { label: "on enemy_lost(event)", kind: "event", snippet: "on enemy_lost(event) {\n  \n}" },
  { label: "on cooldown_ready(event)", kind: "event", snippet: "on cooldown_ready(event) {\n  \n}" },
  { label: "on signal_received(event)", kind: "event", snippet: "on signal_received(event) {\n  \n}" },
  { label: "meta", kind: "keyword" },
  { label: "const", kind: "keyword" },
  { label: "state", kind: "keyword" },
  { label: "squad", kind: "keyword" },
  { label: "let", kind: "keyword" },
  { label: "set", kind: "keyword" },
  { label: "if", kind: "keyword" },
  { label: "else", kind: "keyword" },
  { label: "for", kind: "keyword" },
  { label: "while", kind: "keyword" },
  { label: "break", kind: "keyword" },
  { label: "continue", kind: "keyword" },
  { label: "return", kind: "keyword" },
  { label: "after", kind: "keyword" },
  { label: "every", kind: "keyword" },
  { label: "fn", kind: "keyword" },
  { label: "true", kind: "literal" },
  { label: "false", kind: "literal" },
  { label: "null", kind: "literal" },
  { label: "and", kind: "operator" },
  { label: "or", kind: "operator" },
  { label: "not", kind: "operator" },
];

/** Extract a flat list of completion candidates from LANG_REFERENCE. */
function buildCompletionList() {
  const items = [...KEYWORD_COMPLETIONS];
  for (const section of LANG_REFERENCE) {
    for (const entry of section.entries) {
      // Entries can list multiple names separated by " / " — split them so
      // each name is independently completable. We strip generic parameters
      // and type annotations ("fn name(args) -> type") down to just the
      // identifier the user would type.
      const rawNames = String(entry.name).split(/\s*\/\s*/);
      for (const raw of rawNames) {
        const match = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)(\(.*\))?/);
        if (!match) continue;
        const name = match[1];
        if (items.some(i => i.label === name)) continue;
        items.push({
          label: name,
          kind: sectionKind(section.id),
          detail: entry.sig ?? section.label,
          doc: entry.desc ?? "",
        });
      }
    }
  }
  return items;
}

function sectionKind(id) {
  if (id === "perception" || id === "state") return "sensor";
  if (id === "combat" || id === "movement") return "action";
  if (id === "debug") return "debug";
  if (id === "stdlib" || id === "math") return "stdlib";
  return "lang";
}

export function installEditorAutocomplete(editorEl, onAccept) {
  if (!editorEl) return;

  const allItems = buildCompletionList();

  // Build the popup element lazily so we only touch the DOM when needed.
  const popup = document.createElement("div");
  popup.className = "editor-autocomplete";
  popup.hidden = true;
  document.body.appendChild(popup);

  let filtered = [];
  let active = 0;
  let anchor = null; // { start, end, word }
  let suppressNext = false; // skip re-open after an accept/dismiss

  function getCaretWordRange() {
    const pos = editorEl.selectionStart;
    if (pos !== editorEl.selectionEnd) return null;
    const src = editorEl.value;
    // Walk backwards to find identifier start
    let start = pos;
    while (start > 0 && /[A-Za-z0-9_]/.test(src[start - 1])) start--;
    if (start === pos) return null; // cursor is not inside/adjacent a word
    // Only trigger once the user has typed at least 2 chars — 1-char prefixes
    // match far too many things and produce noise.
    const word = src.slice(start, pos);
    if (word.length < 2) return null;
    // Don't trigger inside strings or comments — cheap heuristic: look at the
    // current line up to the caret and bail if an odd number of `"` came
    // before it, or if a `//` appears earlier on the line.
    const lineStart = src.lastIndexOf("\n", start - 1) + 1;
    const prefix = src.slice(lineStart, start);
    if (prefix.includes("//")) return null;
    const quoteCount = (prefix.match(/"/g) ?? []).length;
    if (quoteCount % 2 === 1) return null;
    // Extend `end` forward through any identifier characters that follow the
    // caret. Without this, accepting a completion with the cursor in the
    // middle of a word (e.g. typing `nea|rest` then picking `nearest_enemy`)
    // would leave the trailing `rest` behind and produce `nearest_enemyrest`.
    // The replacement range now covers the whole token under/around the caret.
    let end = pos;
    while (end < src.length && /[A-Za-z0-9_]/.test(src[end])) end++;
    return { start, end, word };
  }

  function computeCaretPosition() {
    // Approximate caret pixel position using the editor's monospace metrics.
    const style = getComputedStyle(editorEl);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const fontSize = parseFloat(style.fontSize) || 14;
    // Monospace char width is ~0.6 × fontSize for most fonts; the editor uses
    // 'JetBrains Mono' / system mono. Good enough for popup anchoring.
    const charWidth = fontSize * 0.6;
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingTop = parseFloat(style.paddingTop) || 0;

    const src = editorEl.value.slice(0, editorEl.selectionStart);
    const lineStart = src.lastIndexOf("\n") + 1;
    const column = editorEl.selectionStart - lineStart;
    const row = src.split("\n").length - 1;

    const rect = editorEl.getBoundingClientRect();
    const x = rect.left + paddingLeft + column * charWidth - editorEl.scrollLeft;
    const y = rect.top + paddingTop + (row + 1) * lineHeight - editorEl.scrollTop;
    return { x, y, lineHeight };
  }

  function render() {
    if (filtered.length === 0) {
      popup.hidden = true;
      return;
    }
    popup.innerHTML = filtered.map((item, i) => `
      <div class="ac-item${i === active ? " active" : ""}" data-idx="${i}">
        <span class="ac-kind ac-${item.kind}">${item.kind}</span>
        <span class="ac-label">${escapeHtml(item.label)}</span>
        ${item.detail ? `<span class="ac-detail">${escapeHtml(item.detail)}</span>` : ""}
      </div>`).join("");
    const { x, y, lineHeight } = computeCaretPosition();
    popup.style.left = `${Math.max(8, x)}px`;
    popup.style.top = `${y + 2}px`;
    popup.style.maxHeight = `${Math.min(240, window.innerHeight - y - 16)}px`;
    popup.hidden = false;

    for (const el of popup.querySelectorAll(".ac-item")) {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep focus on the textarea
        const idx = Number(el.dataset.idx);
        accept(filtered[idx]);
      });
    }
  }

  function refresh() {
    if (suppressNext) { suppressNext = false; popup.hidden = true; return; }
    anchor = getCaretWordRange();
    if (!anchor) { popup.hidden = true; return; }
    const q = anchor.word.toLowerCase();
    filtered = allItems
      .map(item => ({ item, score: matchScore(item.label.toLowerCase(), q) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(x => x.item);
    active = 0;
    render();
  }

  function accept(item) {
    if (!item || !anchor) return;
    const before = editorEl.value.slice(0, anchor.start);
    const after = editorEl.value.slice(anchor.end);
    // Snippet mode: insert `snippet` and place caret on the first blank line
    // inside braces when possible. For plain identifiers we just append `(` if
    // the completion looks like a function and the next char isn't already `(`.
    let insertion = item.snippet ?? item.label;
    let newCaret = (before + insertion).length;
    if (!item.snippet) {
      // Append () for sensor/stdlib names the author is clearly calling.
      const sectionLikeFunction = item.kind === "sensor" || item.kind === "stdlib" || item.kind === "debug";
      if (sectionLikeFunction && after[0] !== "(") {
        insertion += "()";
        newCaret = (before + item.label + "(").length;
      }
    } else {
      // Position caret on the first blank line inside the snippet (common
      // pattern: `on tick {\n  |\n}`).
      const blank = insertion.indexOf("\n  \n");
      if (blank !== -1) newCaret = (before + insertion.slice(0, blank + 3)).length;
    }
    editorEl.value = before + insertion + after;
    editorEl.selectionStart = editorEl.selectionEnd = newCaret;
    popup.hidden = true;
    suppressNext = true;
    if (typeof onAccept === "function") onAccept();
  }

  function matchScore(label, query) {
    if (label.startsWith(query)) return 100 - (label.length - query.length) * 0.1;
    const idx = label.indexOf(query);
    if (idx > 0) return 60 - idx;
    // Loose scattered match as a last resort.
    let j = 0;
    for (let i = 0; i < label.length && j < query.length; i++) {
      if (label[i] === query[j]) j++;
    }
    return j === query.length ? 20 : 0;
  }

  editorEl.addEventListener("input", () => {
    // Defer so the textarea's value/selection has settled after the keystroke.
    setTimeout(refresh, 0);
  });

  editorEl.addEventListener("blur", () => {
    // Close on blur with a small delay so mousedown-accept still works.
    setTimeout(() => { popup.hidden = true; }, 120);
  });

  editorEl.addEventListener("keydown", (e) => {
    if (popup.hidden) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = (active + 1) % filtered.length;
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = (active - 1 + filtered.length) % filtered.length;
      render();
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (filtered.length > 0) {
        e.preventDefault();
        accept(filtered[active]);
      }
    } else if (e.key === "Escape") {
      popup.hidden = true;
    }
  });
}

// --- Utilities --------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]));
}
