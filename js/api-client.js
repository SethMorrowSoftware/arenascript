// Resolve the API base URL relative to this module's location so that the
// project works when hosted in a subdirectory (e.g. on cPanel shared hosting).
// This file lives at <app>/js/api-client.js, so the API is one level up at
// <app>/api/v1/. Using `import.meta.url` as the base gives us the correct
// absolute URL regardless of where the app is deployed.
const API_BASE = new URL("../api/v1", import.meta.url).href.replace(/\/+$/, "");
const TOKEN_KEY = "arenascript.auth.token";

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

function setToken(token) {
  if (!token) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, token);
}

async function request(path, { method = "GET", body = null, auth = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

export async function register({ email, username, password }) {
  const data = await request("/auth/register.php", { method: "POST", body: { email, username, password } });
  if (data?.session?.token) setToken(data.session.token);
  return data;
}

export async function login({ identity, password }) {
  const data = await request("/auth/login.php", { method: "POST", body: { identity, password } });
  if (data?.session?.token) setToken(data.session.token);
  return data;
}

export async function me() {
  return request("/auth/me.php", { method: "GET", auth: true });
}

export async function logout() {
  try {
    await request("/auth/logout.php", { method: "POST", auth: true });
  } finally {
    setToken("");
  }
}

export async function listRemoteBots() {
  return request("/bots/index.php", { method: "GET", auth: true });
}

export async function createRemoteBot({ name, sourceCode, visibility = "private", versionLabel = "v1" }) {
  return request("/bots/index.php", {
    method: "POST",
    auth: true,
    body: { name, sourceCode, visibility, versionLabel },
  });
}

export async function createRemoteBotVersion({ botId, sourceCode, versionLabel = "v-next" }) {
  const q = encodeURIComponent(botId);
  return request(`/bots/versions.php?botId=${q}`, {
    method: "POST",
    auth: true,
    body: { sourceCode, versionLabel },
  });
}

export async function listRemoteBotVersions(botId) {
  const q = encodeURIComponent(botId);
  return request(`/bots/versions.php?botId=${q}`, { method: "GET", auth: true });
}

export async function setBotVisibility({ id, visibility }) {
  return request("/bots/visibility.php", {
    method: "POST",
    auth: true,
    body: { id, visibility },
  });
}

export async function listCommunityBots({ q = "", sort = "recent", limit = 50, offset = 0 } = {}) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (sort) params.set("sort", sort);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return request(`/bots/community.php?${params.toString()}`, { method: "GET" });
}

export async function getCommunityBot(id) {
  const q = encodeURIComponent(id);
  return request(`/bots/community.php?id=${q}`, { method: "GET" });
}

// ---------------------------------------------------------------------------
// Daily Challenge — cloud leaderboard
// ---------------------------------------------------------------------------

export async function getDailyLeaderboard({ day } = {}) {
  const params = day ? `?day=${encodeURIComponent(day)}` : "";
  return request(`/daily/leaderboard.php${params}`, { method: "GET" });
}

export async function postDailyResult({ day, ticks, won }) {
  return request("/daily/leaderboard.php", {
    method: "POST",
    auth: true,
    body: { day, ticks, won: !!won },
  });
}

export function hasAuthToken() {
  return !!getToken();
}
