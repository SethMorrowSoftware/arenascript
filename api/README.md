# ArenaScript PHP Backend

The backend is a thin coordination + persistence layer on top of the JS
simulation engine. The deterministic match engine lives entirely in
JavaScript (`js/engine/`); the PHP side handles accounts, saved bots,
ranked ratings, lobbies, and match-history storage.

There is a **single backend**, served from `api/v1/*`, backed by MySQL with
bearer-token sessions. (An older file-based stack and an unverified
`X-Arena-Player` token scheme were removed — they let any client
impersonate any player.)

## Design notes

- **JS is authoritative for simulation.** Clients run matches in-browser
  with the deterministic JS engine and submit the result. The server
  validates the structural shape and rejects obvious abuse (unregistered
  participants, re-reported ranked seeds) but does **not** re-run the match.
  True anti-cheat would require a server-side re-simulation, which a
  JavaScript engine cannot provide.
- **MySQL persistence.** All real state lives in MySQL (see
  `migrations/`). The only file storage is a small, self-pruning
  rate-limit counter under `api/.storage/` (gitignored).
- **Bearer-token sessions.** `POST /api/v1/auth/login` (or `register`)
  returns a session token; clients send it as `Authorization: Bearer
  <token>`. Tokens are stored hashed (`sha256`) in the `sessions` table
  and expire.

## Running locally

```bash
php -S 127.0.0.1:8000 -t .
```

All responses are `application/json`. Errors use
`{ "error": "<message>", "status": <http-status> }`. Internal exception
detail is logged server-side, never returned to the client.

## Configuration

`api/db.php` reads configuration from environment variables, falling back
to `api/.env.local` (written by the installer). Keys:

- `ARENA_DB_ENABLED=1`
- `ARENA_DB_HOST` / `ARENA_DB_PORT` / `ARENA_DB_NAME` / `ARENA_DB_USER` / `ARENA_DB_PASS`
- `ARENA_SESSION_TTL_HOURS` (optional, default `336`)
- `ARENA_CORS_ORIGIN` — required for cross-origin access (see below)
- `ARENA_ALLOW_INSTALLER` — set to `1` only while running the installer

`.env.local` values may be double-quoted; quoting is required if a value
(e.g. a DB password) contains spaces or special characters.

### CORS

CORS **default-denies**. With `ARENA_CORS_ORIGIN` unset, no
`Access-Control-Allow-Origin` header is sent except for loopback dev
origins. The shipped frontend is served from the same origin as the API,
so it needs no CORS header. Set `ARENA_CORS_ORIGIN` to your frontend
origin (or a comma-separated allowlist) only if you host them separately.

## Endpoints (`/api/v1/*`)

### Auth

- `POST /api/v1/auth/register.php` — `{ email, username, password }`
- `POST /api/v1/auth/login.php` — `{ identity, password }`
- `POST /api/v1/auth/logout.php` — bearer token required
- `GET  /api/v1/auth/me.php` — bearer token required

### Bots

- `GET  /api/v1/bots/index.php` — list the caller's bots
- `POST /api/v1/bots/index.php` — create a bot
- `GET  /api/v1/bots/versions.php?botId=<id>` — list versions
- `POST /api/v1/bots/versions.php?botId=<id>` — add a version

### Competitive

- `GET  /api/v1/leaderboard.php?queue=1v1_ranked&limit=100`
- `POST /api/v1/matches/report.php` — report a completed match
- `GET  /api/v1/lobbies/index.php` — list waiting lobbies
- `POST /api/v1/lobbies/index.php` — `{ action: "create" | "join", ... }`
- `DELETE /api/v1/lobbies/index.php` — `{ lobbyId }`

### Admin (admin role required)

- `GET  /api/v1/admin/users.php`
- `POST /api/v1/admin/suspend-user.php`

### Config

- `GET /api/config.php` — engine/language version, balance constants.

## Shared-hosting install (`api/install.php`)

For cPanel / shared hosting:

1. Create a MySQL database + user in cPanel.
2. Set `ARENA_ALLOW_INSTALLER=1` in the host environment (or run the
   installer from localhost during development).
3. Open `https://your-domain/api/install.php`, enter the DB credentials
   and the first admin account, and submit. The installer runs both
   migrations, creates the admin user, writes `api/.env.local`, and
   creates `api/.installed.lock`.
4. **Delete `api/install.php`** and unset `ARENA_ALLOW_INSTALLER`.

The installer refuses to run once `api/.installed.lock` exists — there is
no web-facing override. To re-install, delete the lock file over SSH or a
file manager.

## Production hardening checklist

- Set `ARENA_CORS_ORIGIN` to your real frontend origin.
- Confirm `ARENA_DB_ENABLED=1` and credentials are populated.
- Delete `api/install.php` after first-time setup; keep
  `ARENA_ALLOW_INSTALLER` unset.
- Force HTTPS (Let's Encrypt + redirect).
- Verify `api/.env.local` is mode `0600` and not web-readable
  (`api/.htaccess` blocks dotfiles — confirm `AllowOverride` permits it,
  or move `.env.local` above the docroot).
- Login/register/match-report carry fixed-window IP rate limits; keep an
  external WAF enabled as well.

## What is deliberately NOT here

- **Server-authoritative simulation.** The server trusts the client's
  reported result (with the abuse checks noted above). A fully
  competitive ladder would re-run each match server-side.
- **Cross-player match verification.** A result is filed by one
  participant; the opponent does not co-sign it.

## Automated checks

```bash
./scripts/check_beta_readiness.sh
```
