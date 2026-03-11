# Security Review — myEA Personal AI Assistant

**Date**: 2026-03-10
**Reviewer**: Security Engineer Agent
**Scope**: Full codebase audit — backend TypeScript, frontend React/TypeScript, Docker configuration, shell scripts
**Status**: All identified issues fixed inline. Items requiring user action are called out explicitly.

---

## Executive Summary

The myEA codebase is a personal AI assistant with Docker-based deployment. The application architecture is sound (Drizzle ORM parameterized queries throughout, bcrypt at cost 12, first-user-only registration, non-root Docker user). However, the audit uncovered **3 Critical** and **5 High** severity issues that were fixed directly. The most serious findings were:

1. A second, weaker `/auth/login` handler registered directly in `index.ts` that **completely bypassed the auth plugin**, leaked JWT error details, and had no rate limiting.
2. The WebSocket endpoint accepted connections from **any unauthenticated client**.
3. The `exec` skill passed AI-generated commands to `sh -c` with no destructive-command blocklist and no working-directory restrictions.
4. The Gmail OAuth callback reflected user-supplied query parameters into raw HTML (reflected XSS).
5. Plain-text admin password written to `.env` by `setup.sh` with no corresponding hashing logic in `entrypoint.sh`.

All issues have been remediated. No secrets were found hardcoded in source files.

---

## Issues Found and Fixed

### CRITICAL-1 — Duplicate `/auth/login` Route Bypassing Auth Plugin

**File**: `backend/src/index.ts` (lines 117–147, now removed)
**Risk**: Critical

The `registerRoutes()` function registered its own `/auth/login` handler _before_ the auth plugin's handler was registered. This inline handler:
- Had no schema validation (no `additionalProperties: false`, no `maxLength`), enabling large-payload DoS attacks
- Called `reply.send(err)` in the `authenticate` decorator, leaking raw JWT error messages to clients (information disclosure)
- Had no rate limiting
- Used timing-unsafe username comparison (`username === config.auth.adminUsername`) before the bcrypt comparison, making user enumeration marginally easier

**Fix**: The duplicate route and the inline `authenticate` decorator were deleted from `index.ts`. The auth plugin (`api/auth.ts`) is the single source of truth for authentication.

---

### CRITICAL-2 — WebSocket Endpoint Had No Authentication

**File**: `backend/src/index.ts` (around line 283, now patched)
**Risk**: Critical

The `/ws` WebSocket endpoint had no `preHandler` and no `onRequest` hook. Any client — unauthenticated — could open a persistent WebSocket connection to the admin real-time feed.

Additionally, there was no message size limit. A client could send arbitrarily large JSON frames, consuming unbounded server memory.

**Fix**:
- Added a `preHandler` that calls `request.jwtVerify()` before the WebSocket upgrade is accepted. Unauthorized connections receive HTTP 401 before the socket is opened.
- The frontend sends the token as `?token=` in the URL (browser WebSocket API cannot set headers). The preHandler extracts it and injects it as an Authorization header so `jwtVerify` works transparently.
- Added a `WS_MAX_MESSAGE_BYTES = 64 KB` limit. Frames exceeding this are rejected with an error event.

---

### CRITICAL-3 — Command Injection / No Blocklist in exec Skill

**File**: `backend/src/skills/built-in/exec.ts` (lines 104–130, now patched)
**Risk**: Critical (with `MYEA_EXEC_ENABLED=true`)

`runCommand` passed the AI-generated `command` string directly to `spawn("sh", ["-c", command])`. While this is intentional (the skill needs shell features like pipes), there was:
- No blocklist against catastrophically destructive commands (`rm -rf /`, fork bombs, `dd` to raw disk, `mkfs`)
- No restriction on `workingDir` — an AI could set it to `/etc`, `/proc`, `/sys`, etc.

**Fix**:
- Added `BLOCKED_PATTERNS` — a set of regular expressions that match known catastrophic commands. Any command matching is rejected before spawning.
- Added `BLOCKED_WORKING_DIRS` — rejects working directories under `/etc`, `/proc`, `/sys`, `/dev`, `/boot`, and system binary directories.
- Both checks are defence-in-depth. The primary protection remains that the skill is opt-in (`MYEA_EXEC_ENABLED=true`) and runs as the non-root `node` user inside Docker.

Note: The `runCommand` tool inherently accepts arbitrary shell commands because the AI needs shell features (pipes, redirects, etc.). The blocklist targets catastrophic irreversible operations only, not general command restriction. Users should only enable `MYEA_EXEC_ENABLED=true` if they accept that the AI can execute shell commands.

---

### HIGH-1 — Reflected XSS in Gmail OAuth Callback

**File**: `backend/src/api/integrations.ts` (line 229 and error handler, now patched)
**Risk**: High

The Gmail OAuth callback endpoint (`GET /api/integrations/gmail/oauth/callback`) reflected the `error` query parameter and caught exception messages directly into HTML responses with no encoding:

```
.send(`<html><body><h2>Gmail OAuth Error</h2><p>${error}</p></body></html>`);
```

An attacker who could get a victim to visit a crafted URL could execute arbitrary JavaScript in the victim's browser session.

**Fix**:
- Added an `htmlEncode()` helper that escapes `&`, `<`, `>`, `"`, `'` before embedding any string in HTML.
- The `error` query parameter is now HTML-encoded and length-limited to 200 characters before insertion.
- The catch block's error message is no longer reflected at all — a generic "Token exchange failed" message is shown instead, with the full error logged server-side only.

---

### HIGH-2 — JWT Error Details Leaked to Clients

**File**: `backend/src/api/auth.ts` (line 73, now patched) and `backend/src/index.ts` (protectedRoutes hook, now patched)
**Risk**: High

Both the `authenticate` decorator and the `protectedRoutes` `onRequest` hook propagated the raw JWT library error to the client (`reply.send(err)`). JWT errors can contain implementation details about token structure, algorithm expectations, or clock skew.

**Fix**: Both handlers now return `reply.status(401).send({ error: "Unauthorized" })` — no internal detail exposed.

---

### HIGH-3 — No Rate Limiting on Authentication Routes

**File**: `backend/src/api/auth.ts` and `backend/src/index.ts`, now patched
**Risk**: High

`/auth/login` had no rate limiting, enabling unlimited brute-force password guessing attempts.

**Fix**:
- Registered `@fastify/rate-limit` globally (200 req/min per IP, as a baseline) in `registerPlugins()`.
- Applied a strict per-route override to `/auth/login`: **10 requests per minute per IP**. Exceeding this returns HTTP 429 with a user-friendly message.
- Applied a strict per-route override to `/auth/register`: **5 requests per minute per IP**.

---

### HIGH-4 — Missing Security Headers

**File**: `backend/src/index.ts`, now patched
**Risk**: High

The API server returned no security headers. Without headers like `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, and `Content-Security-Policy`, browsers are more vulnerable to MIME sniffing, clickjacking, and XSS.

**Fix**: Registered `@fastify/helmet` with:
- `Content-Security-Policy` restricting all sources to `'self'` with minimal exceptions
- `Strict-Transport-Security` at 1 year with `includeSubDomains` and `preload`
- All other helmet defaults (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, etc.)

---

### HIGH-5 — Plain-Text Password Written to .env by setup.sh

**File**: `setup.sh` (lines 148–152, now patched) and `docker-compose.yml` (now patched)
**Risk**: High

`setup.sh` wrote the admin password in plain text to `.env` under `ADMIN_PASSWORD`, with a comment saying "entrypoint.sh will hash it on first boot." However, `entrypoint.sh` contained **no password-hashing logic** — the hash was never derived. The plain password would sit in `.env` indefinitely and be passed as a plain environment variable to the backend container.

**Fix**:
- `setup.sh` now hashes the password immediately at setup time using `bcryptjs` via Node.js (cost 12). The plain-text password is never written to disk.
- `docker-compose.yml` now passes only `ADMIN_PASSWORD_HASH` to the container. The `ADMIN_PASSWORD` variable is removed entirely.
- `docker-compose.yml` now requires `ADMIN_PASSWORD_HASH` to be set (no default) — a missing hash will prevent the container from starting rather than silently running with no auth.

---

### MEDIUM-1 — JWT Algorithm Not Pinned (none Algorithm Attack Surface)

**File**: `backend/src/index.ts`, now patched
**Risk**: Medium

`@fastify/jwt` was registered without specifying `algorithms` in the verify options. Some JWT library versions accept `alg: none` tokens if not explicitly restricted.

**Fix**: JWT is now registered with `sign: { algorithm: "HS256" }` and `verify: { algorithms: ["HS256"] }`. Any token signed with a different algorithm (including `none`) is rejected.

---

### MEDIUM-2 — WebSocket Token in URL Query Parameter

**File**: `frontend/src/hooks/useWebSocket.ts` (line 74)
**Risk**: Medium (accepted, documented)

The frontend sends the JWT as `?token=<jwt>` in the WebSocket URL. Tokens in URLs appear in:
- Browser history
- Server access logs (nginx, etc.)
- Proxy and CDN logs

The browser WebSocket API provides no mechanism to set custom headers, so the query-parameter approach is a necessary trade-off for browser clients.

**Mitigations already in place**: JWTs have a configured expiry (`JWT_EXPIRES_IN`, default 7 days). The backend validates the token before accepting the upgrade.

**Recommended mitigation** (requires user action): Configure a short `JWT_EXPIRES_IN` (e.g., `1h`) and implement refresh token rotation. This limits the window of exposure if a token is captured from logs.

---

### MEDIUM-3 — Insecure Default Credentials in .env.example

**File**: `.env.example`, now patched
**Risk**: Medium

The example file contained:
- `POSTGRES_PASSWORD=myea_secret` — a real-looking default that could be copied as-is
- `ANTHROPIC_API_KEY=sk-ant-...` — prefix that matches real key format, triggering secret scanners
- `SLACK_BOT_TOKEN=xoxb-...` / `SLACK_APP_TOKEN=xapp-...` — same issue
- `GITHUB_TOKEN=ghp_...` — same issue

**Fix**: All placeholder values replaced with clearly non-functional strings (`CHANGE_ME_STRONG_PASSWORD`, `your_anthropic_api_key_here`, empty strings for optional tokens). Added comments directing users to generate strong passwords.

---

### MEDIUM-4 — Docker Compose Postgres Default Password Fallback

**File**: `docker-compose.yml`, now patched
**Risk**: Medium

The `POSTGRES_PASSWORD` and `DATABASE_URL` in docker-compose.yml both had `:-myea_secret` fallbacks, meaning the database could start with a weak known password even if `POSTGRES_PASSWORD` was not set in `.env`.

**Fix**: Removed all `:-` fallbacks from `POSTGRES_PASSWORD` and `DATABASE_URL`. If `POSTGRES_PASSWORD` is not set, Docker Compose will refuse to start (variable substitution fails), forcing the operator to configure a real password.

---

## Issues Requiring User Action

The following items cannot be fixed by code changes alone and require operator action before deployment.

### Action 1 — Install New NPM Dependencies

Two new packages were added to `backend/package.json`:
- `@fastify/helmet` — security headers
- `@fastify/rate-limit` — rate limiting

Run inside the backend container or locally:

```bash
cd backend
npm install
```

Or rebuild the Docker image:

```bash
docker compose build backend
```

### Action 2 — Set a Strong JWT_SECRET

The default in `.env.example` is `change_me_to_a_long_random_secret`. Before deploying, generate a cryptographically strong secret:

```bash
openssl rand -base64 64
```

Set this value as `JWT_SECRET` in your `.env` file. The `setup.sh` script does this automatically if run interactively.

### Action 3 — Set a Strong POSTGRES_PASSWORD

The postgres password default has been removed. You must set a real password:

```bash
openssl rand -base64 32
```

Set this as `POSTGRES_PASSWORD` in `.env`. Update `DATABASE_URL` to match.

### Action 4 — Re-run setup.sh or Manually Hash Admin Password

If you previously ran `setup.sh` and it wrote a plain-text `ADMIN_PASSWORD` to `.env`, clear it and set `ADMIN_PASSWORD_HASH` instead:

```bash
node -e "require('bcryptjs').hash('your_password', 12).then(console.log)"
```

Then in `.env`:
```
ADMIN_PASSWORD=          # leave empty
ADMIN_PASSWORD_HASH=<hash from above>
```

### Action 5 — Evaluate MYEA_EXEC_ENABLED Before Enabling

The exec skill (`MYEA_EXEC_ENABLED=true`) allows the AI to run arbitrary shell commands as the `node` user inside Docker. The blocklist added in this review blocks known catastrophic patterns but cannot prevent all harmful commands. Only enable this on a system you are comfortable granting shell access to the AI model in use.

If you enable it, consider also restricting Docker capabilities:

```yaml
# in docker-compose.yml backend service
security_opt:
  - no-new-privileges:true
cap_drop:
  - ALL
```

### Action 6 — Configure Short JWT Expiry to Mitigate URL Token Leakage

The WebSocket client sends the JWT as a URL query parameter. Set `JWT_EXPIRES_IN=1h` in `.env` and implement a token refresh flow if the frontend session should last longer.

### Action 7 — Nginx/Reverse Proxy Security Headers for Frontend

The backend now returns security headers for API responses via helmet. The frontend (served by nginx) does not yet set equivalent headers. Add the following to your nginx config for the frontend container:

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss:;" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

---

## Deployment Security Checklist

Use this checklist before going live:

- [ ] `JWT_SECRET` is at least 64 characters of random bytes (`openssl rand -base64 64`)
- [ ] `POSTGRES_PASSWORD` is a strong random value (not `myea_secret`)
- [ ] `ADMIN_PASSWORD_HASH` is set to a bcrypt hash (cost 12) — `ADMIN_PASSWORD` is empty
- [ ] `.env` file permissions are `600` (`chmod 600 .env`)
- [ ] `.env` is listed in `.gitignore`
- [ ] `npm install` run inside backend to install `@fastify/helmet` and `@fastify/rate-limit`
- [ ] Docker images rebuilt after dependency update
- [ ] `MYEA_EXEC_ENABLED` is `false` unless exec capability is explicitly required
- [ ] `FRONTEND_URL` is set to the exact production origin (not a wildcard)
- [ ] TLS/HTTPS is terminated at the reverse proxy layer before reaching the backend
- [ ] PostgreSQL is not exposed on the host network in production (use `expose:` not `ports:`)
- [ ] Backend API port (3001) is not directly reachable from the internet — route through nginx
- [ ] `NODE_ENV=production` in the production compose file
- [ ] Docker image versions are pinned (replace `:latest` tags with specific digests for third-party images)
- [ ] `docker compose logs` reviewed after first start to confirm no credential errors or auth failures
- [ ] First-run registration completed and `/auth/register` confirmed locked (returns 403 after first user)

---

## Files Modified

| File | Changes |
|------|---------|
| `backend/src/index.ts` | Added `@fastify/helmet` + `@fastify/rate-limit`; pinned JWT to HS256; removed duplicate `/auth/login` route and insecure authenticate decorator; added JWT preHandler to WebSocket route; added 64 KB WS message size limit; fixed 401 error handler to not leak JWT internals |
| `backend/src/api/auth.ts` | Fixed authenticate decorator to return generic 401; added rate limiting (10/min) to `/auth/login`; added rate limiting (5/min) to `/auth/register`; added `additionalProperties: false` and `maxLength` to login schema; added username pattern validation to register schema |
| `backend/src/api/integrations.ts` | Added `htmlEncode()` helper; applied encoding to Gmail OAuth error query param; replaced caught-exception reflection in OAuth error response with generic message |
| `backend/src/skills/built-in/exec.ts` | Added `BLOCKED_PATTERNS` blocklist for catastrophic commands; added `BLOCKED_WORKING_DIRS` restriction; applied both checks in `runCommand` before spawning |
| `backend/package.json` | Added `@fastify/helmet` and `@fastify/rate-limit` dependencies |
| `.env.example` | Replaced real-looking credential placeholders with clearly non-functional values; added strong-password generation instructions |
| `docker-compose.yml` | Removed `ADMIN_PASSWORD` plain-text env var; removed `:-myea_secret` default from postgres password and DATABASE_URL; `ADMIN_PASSWORD_HASH` now required (no default) |
| `setup.sh` | Password is now hashed at setup time via Node/bcryptjs; plain-text password is never written to disk |
