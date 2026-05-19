// ============================================================================
// Bot Library — localStorage-backed persistence for user-uploaded bots
// ============================================================================
//
// Provides validation (via the compile pipeline), metadata extraction,
// import/export, and a simple event-based API so other parts of the app can
// react to library changes.
// ============================================================================

import { compile } from "./lang/pipeline.js";

const STORAGE_KEY = "arenascript.bots.v1";
const VALID_CLASSES = new Set(["brawler", "ranger", "tank", "support"]);

const listeners = new Set();

/** Subscribe to library changes. Returns an unsubscribe function. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try { fn(getAll()); } catch (e) { console.error("bot-library listener error", e); }
  }
}

/** Load all bots from storage. */
export function getAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn("Failed to parse bot library:", e);
    return [];
  }
}

/** Find a bot by id. */
export function getById(id) {
  return getAll().find((b) => b.id === id) ?? null;
}

/**
 * Persist the library. Returns false if storage is unavailable (Safari
 * private mode throws on setItem) or full, so callers can report the
 * failure instead of crashing the Save flow with an uncaught exception.
 */
function saveAll(bots) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bots));
  } catch (e) {
    console.error("Failed to save bot library:", e);
    return false;
  }
  emit();
  return true;
}

const STORAGE_FAILED = "Could not save — browser storage is full or unavailable.";

function makeId() {
  return "user_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * Extract metadata (name, class, author) from ArenaScript source.
 * Regex-based so it works even on files we can't fully introspect later.
 */
export function extractMetadata(source) {
  const meta = { name: null, class: null, author: null };

  const nameMatch = source.match(/\brobot\s+"([^"]+)"/);
  if (nameMatch) meta.name = nameMatch[1].trim();

  const classMatch = source.match(/\bclass\s*:\s*"([^"]+)"/);
  if (classMatch) {
    const c = classMatch[1].trim().toLowerCase();
    if (VALID_CLASSES.has(c)) meta.class = c;
  }

  const authorMatch = source.match(/\bauthor\s*:\s*"([^"]+)"/);
  if (authorMatch) meta.author = authorMatch[1].trim();

  return meta;
}

/**
 * Validate source by running it through the full compile pipeline.
 * Returns { ok, errors, warnings, metadata }.
 */
export function validate(source) {
  if (typeof source !== "string" || source.trim().length === 0) {
    return { ok: false, errors: ["Source is empty."], warnings: [], metadata: {} };
  }
  if (source.length > 200_000) {
    return { ok: false, errors: ["Source exceeds 200KB limit."], warnings: [], metadata: {} };
  }

  let result;
  try {
    result = compile(source);
  } catch (e) {
    return {
      ok: false,
      errors: [`Compiler crashed: ${e instanceof Error ? e.message : String(e)}`],
      warnings: [],
      metadata: {},
    };
  }

  const metadata = extractMetadata(source);
  const warnings = (result.diagnostics ?? [])
    .filter((d) => d.severity === "warning")
    .map((d) => d.message);

  if (!result.success) {
    return { ok: false, errors: result.errors ?? ["Unknown error"], warnings, metadata };
  }

  if (!metadata.name) {
    return {
      ok: false,
      errors: ['Missing required header: robot "Name" version "1.0"'],
      warnings,
      metadata,
    };
  }
  if (!metadata.class) {
    return {
      ok: false,
      errors: ['Missing required meta.class ("brawler" | "ranger" | "tank" | "support")'],
      warnings,
      metadata,
    };
  }

  return { ok: true, errors: [], warnings, metadata };
}

/**
 * Add a new bot to the library after validating it.
 * Returns { ok, bot, errors, warnings }.
 */
export function addBot(source, { overrideName = null } = {}) {
  const v = validate(source);
  if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings };

  const bots = getAll();
  const now = Date.now();
  const bot = {
    id: makeId(),
    name: overrideName || v.metadata.name,
    class: v.metadata.class,
    author: v.metadata.author ?? null,
    source,
    createdAt: now,
    updatedAt: now,
  };

  bots.push(bot);
  if (!saveAll(bots)) {
    return { ok: false, errors: [STORAGE_FAILED], warnings: v.warnings };
  }
  return { ok: true, bot, errors: [], warnings: v.warnings };
}

/** Update an existing bot's source (re-validates). */
export function updateBot(id, source) {
  const v = validate(source);
  if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings };

  const bots = getAll();
  const idx = bots.findIndex((b) => b.id === id);
  if (idx === -1) return { ok: false, errors: ["Bot not found."], warnings: [] };

  bots[idx] = {
    ...bots[idx],
    name: v.metadata.name ?? bots[idx].name,
    class: v.metadata.class ?? bots[idx].class,
    author: v.metadata.author ?? bots[idx].author,
    source,
    updatedAt: Date.now(),
  };
  if (!saveAll(bots)) {
    return { ok: false, errors: [STORAGE_FAILED], warnings: v.warnings };
  }
  return { ok: true, bot: bots[idx], errors: [], warnings: v.warnings };
}

/** Rename (metadata only — does not modify source). */
export function renameBot(id, newName) {
  const bots = getAll();
  const idx = bots.findIndex((b) => b.id === id);
  if (idx === -1) return false;
  const clean = String(newName || "").trim();
  if (!clean) return false;
  bots[idx] = { ...bots[idx], name: clean, updatedAt: Date.now() };
  return saveAll(bots);
}

/** Delete a bot by id. Returns false if the change could not be persisted. */
export function deleteBot(id) {
  const bots = getAll().filter((b) => b.id !== id);
  return saveAll(bots);
}

/** Duplicate a bot, returning the new entry. */
export function duplicateBot(id) {
  const bot = getById(id);
  if (!bot) return null;
  return addBot(bot.source, { overrideName: `${bot.name} (copy)` }).bot ?? null;
}

/** Download a bot's source as a .arena file. */
export function exportBot(id) {
  const bot = getById(id);
  if (!bot) return;
  const safe = bot.name.replace(/[^a-z0-9._-]+/gi, "_");
  const blob = new Blob([bot.source], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safe}.arena`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Upper bound on a single uploaded file. Matches the 200KB source cap
// enforced by validate() but checked *before* we ever read bytes into
// memory so that a malicious/misclicked 100MB file can't OOM the tab.
const MAX_IMPORT_FILE_BYTES = 200_000;

/** Read a File object and return its text contents. */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("File read error"));
    reader.readAsText(file);
  });
}

/**
 * Import one or more files. Each file is validated independently.
 * Returns an array of per-file results: { file, ok, bot, errors, warnings }.
 */
export async function importFiles(fileList) {
  const files = Array.from(fileList || []);
  const results = [];
  for (const file of files) {
    try {
      if (typeof file.size === "number" && file.size > MAX_IMPORT_FILE_BYTES) {
        results.push({
          file: file.name,
          ok: false,
          errors: [
            `File is ${file.size} bytes, exceeds ${MAX_IMPORT_FILE_BYTES} byte limit.`,
          ],
          warnings: [],
        });
        continue;
      }
      const source = await readFileAsText(file);
      const r = addBot(source);
      results.push({ file: file.name, ...r });
    } catch (e) {
      results.push({
        file: file.name,
        ok: false,
        errors: [`Failed to read file: ${e.message ?? String(e)}`],
        warnings: [],
      });
    }
  }
  return results;
}
