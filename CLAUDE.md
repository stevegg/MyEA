# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Docker-based (primary workflow)

```bash
make dev              # Start all services with hot-reload (streams logs; Ctrl-C to stop)
make dev-detach       # Same but detached
make down             # Stop all services (always uses both compose files + --remove-orphans)
make logs             # Tail all logs
make logs-backend     # Backend logs only
make shell-backend    # Shell into running backend container
make db               # Connect to postgres via psql
make ps               # Show container status
make reset            # DANGER: destroy all volumes and restart fresh
```

When recreating a single service without cascading restarts:
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --no-deps --force-recreate backend
```

Use `--force-recreate` (not `restart`) when you need new env vars or compose config to take effect.

### Backend (outside Docker)

```bash
cd backend
npm run dev           # tsx watch (hot-reload)
npm run build         # tsc compile → dist/
npm run typecheck     # tsc --noEmit
npm run lint          # eslint src

# Drizzle ORM
DATABASE_URL="postgresql://myea:<pass>@localhost:5432/myea" npm run db:generate  # schema → migration SQL
npm run db:migrate    # apply pending migrations
npm run db:studio     # open Drizzle Studio UI
```

Drizzle migrations run automatically on container start via `entrypoint.sh`. Generate migrations on the host (not inside the container) because `backend/drizzle/` is bind-mounted in dev.

### Frontend (outside Docker)

```bash
cd frontend
npm run dev           # Vite dev server (proxies /api, /auth, /ws to localhost:3001)
npm run build         # tsc check + vite build
npm run typecheck
npm run lint
```

## Architecture

### Service Layout

```
postgres (port 5432)   — Primary datastore + pg-boss job queue
ollama   (port 11434)  — Local LLM inference (optional)
signal-cli (port 8080) — Signal messenger REST bridge
backend  (port 3001)   — Fastify API + WebSocket + skill runtime
frontend (port 3000)   — React SPA (Vite dev / nginx prod)
```

All services communicate over Docker's internal `backend` network. PostgreSQL is intentionally not exposed to the host in production; the dev overlay opens port 5432 for local tooling.

### Backend Bootstrap Order (`src/index.ts`)

The `bootstrap()` function in `src/index.ts` wires everything together in a specific order:

1. DB init + migrations
2. Logger (wraps Fastify/Pino, persists to DB)
3. pg-boss scheduler (lazy `sendMessage` ref to break circular dep with PlatformManager)
4. AIProviderManager
5. MemoryService
6. Orchestrator (lazy `platformManagerRef` to break circular dep)
7. **SkillEngine** + `skillEngineRef` declaration (ref container passed to routes)
8. PlatformManager; fill in lazy refs
9. Register Fastify plugins + routes (`registerRoutes` receives `skillEngineRef`)
10. Start PlatformManager
11. Start SkillEngine (loads built-ins, watches custom dir, calls `skill.setup()`)
12. Start HTTP server

The two circular-dependency breaks use the same pattern: a mutable ref object declared in `bootstrap()` and populated before any request can arrive.

### Key Design Patterns

**Lazy ref container** — Used in two places to break circular dependencies without restructuring:
```typescript
const skillEngineRef: { engine?: SkillEngine } = {};
// ... create the thing ...
skillEngineRef.engine = theEngine;
// passed into registerRoutes() → skills plugin reads it at request time via:
const getEngine = () => opts.skillEngineRef?.engine;
```

**Fastify plugin system** — All API modules export a `FastifyPluginAsync` wrapped with `fastify-plugin`. Plugins declare `dependencies: ["auth"]` so Fastify enforces registration order. Plugin options are passed at `server.register()` time; do not try to modify them later.

**All list endpoints return `{ data: [...], total: N }`** — the frontend `api.ts` unwraps accordingly.

**AI provider enum** — Values are `"claude"`, `"openai"`, `"ollama"` (NOT `"anthropic"`). This applies to the DB schema, config, frontend dropdowns, and the settings `PUT /api/settings` body.

### Skills System

Skills are the primary extension mechanism. A skill is a `.js` or `.ts` file that exports a default `Skill` object (see `src/types/index.ts` for the `Skill` interface).

- **Built-in skills** live in `backend/src/skills/built-in/`: `email`, `exec`, `files`, `integrations`, `memory`, `scheduler`, `web`
- **Custom skills** are dropped into `./volumes/skills/` on the host (bind-mounted in dev; named volume `skills_data` in prod)
- **Hot-reload**: chokidar watches `SKILLS_DIR` for `.ts`/`.js` changes and reloads without a container restart
- **In-memory registry**: `SkillEngine` stores loaded skills in a `Map`; the `skills_registry` DB table stores only `enabled` overrides. The `GET /api/skills` endpoint merges both.
- **Isolation**: A broken custom skill is caught per-file and emits `skill:error` — it cannot crash the engine.

Custom skill structure (CommonJS `.js` preferred for custom skills):
```js
"use strict";
module.exports = {
  name: "my-skill",
  description: "...",
  version: "1.0.0",
  tools: [{
    name: "my_tool",
    description: "...",
    parameters: { type: "object", properties: { ... }, required: [...] },
    execute: async (params, context) => ({ success: true, result: "..." }),
  }],
  setup: async (context) => { /* optional init */ },
  teardown: async () => { /* optional cleanup */ },
};
```

### AI / Orchestrator Flow

`Orchestrator.handleInbound()` drives the full response cycle:
1. Persist inbound message → find/create conversation
2. Load last 20 messages + top 8 memory entries
3. Build system prompt (via `PromptBuilder`) with tools list from `SkillEngine.getAllTools()`
4. Call active AI provider
5. Execute tool calls in a loop (max 10 turns)
6. Persist assistant response; extract memories
7. Return `OutboundMessage`

### Database Schema

Tables defined in `backend/src/db/schema.ts`:
- `users` — single admin user (bcrypt password)
- `conversations` — one per platform+channel
- `messages` — full message history with role enum
- `memory_entries` — tsvector full-text search, typed (fact/preference/summary/context/note)
- `skills_registry` — persisted `enabled` overrides only (source of truth is in-memory engine)
- `integrations` — OAuth tokens + generic key-value (settings stored here as name="global")
- `scheduled_jobs` — mirrors pg-boss queue for admin UI
- `logs` — structured log persistence

Settings are stored as a JSON blob in `integrations` table with `name="global"`, merged with env-var defaults on every read.

### Frontend

- **Router**: TanStack Router (file-based routes in `App.tsx`)
- **Data fetching**: TanStack Query; all API calls go through `src/lib/api.ts`
- **Auth**: JWT in `localStorage` under key `myea_token`; axios interceptor attaches it and redirects to `/login` on 401
- **WebSocket**: Connects to `/ws?token=...` on page load; auto-reconnects every 3s; exposes `useWS()` context with `{ connected, lastEvent }`
- **Proxy**: In dev, Vite proxies `/api`, `/auth`, `/ws` to backend. In prod, nginx handles this. The frontend never uses `VITE_API_URL` directly — it uses an empty `baseURL` so all requests go to the same origin.

### Docker Compose Gotchas

- **Overlay port merging**: `ports` arrays are additive across compose files. Frontend uses `expose: ["80"]` in prod so the dev overlay's `ports: ["3000:5173"]` doesn't conflict.
- **Shell env override**: The Makefile `export`s all `.env` vars into the shell. Docker Compose `${VAR:-default}` syntax sees these shell vars. Dev-specific values in `docker-compose.dev.yml` are hardcoded (e.g., `VITE_API_URL: "http://backend:3001"`) to avoid override.
- **API keys**: Backend uses `env_file: .env` so secrets bypass shell interpolation (Claude Code sets `ANTHROPIC_API_KEY=` empty in its environment).
- **Memory limits**: Dev overlay sets `limits.memory: "0"` (quoted string) per service to lift prod limits. An empty `deploy.resources: {}` does NOT clear parent limits.
- **Skills volume**: `./volumes/skills` is bind-mounted in dev so you can drop skills from the host. Production uses the named volume `skills_data`.
- **Vite HMR**: `VITE_HMR_CLIENT_PORT` must equal the host-facing port (3000), not the container port (5173), so browser WebSocket connects to the right port.
