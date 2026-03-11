# myEA — Personal AI Assistant

A self-hosted, single-user AI assistant that connects to multiple messaging platforms, runs hot-loadable skills, and exposes an admin UI — all orchestrated with Docker Compose.

## Architecture

```
docker-compose
├── postgres        PostgreSQL 16 — primary datastore + pg-boss job queue
├── ollama          Local LLM inference
├── signal-cli      Signal messenger REST bridge
├── backend         Node.js / Fastify API + WebSocket + skill runtime
└── frontend        React SPA (Vite build, served by nginx)
```

## Quick Start

```bash
# 1. Copy and fill in environment variables
cp .env.example .env
# Edit .env — at minimum set JWT_SECRET, ADMIN_PASSWORD_HASH, and one AI provider key.

# 2. Generate ADMIN_PASSWORD_HASH
node -e "const b=require('bcryptjs'); b.hash('yourpassword', 12).then(console.log)"

# 3. Start everything
docker compose up -d

# 4. Run database migrations (first run only)
docker compose exec backend npm run db:migrate

# 5. Open the admin UI
open http://localhost:3000
```

## Supported Platforms

| Platform  | Environment variable        |
|-----------|-----------------------------|
| Telegram  | `TELEGRAM_ENABLED=true`     |
| Discord   | `DISCORD_ENABLED=true`      |
| Slack     | `SLACK_ENABLED=true`        |
| WhatsApp  | `WHATSAPP_ENABLED=true`     |
| Signal    | `SIGNAL_ENABLED=true`       |

## AI Providers

Set `ACTIVE_AI_PROVIDER` to one of: `claude`, `openai`, `ollama`. Switch at runtime via the admin UI or by updating the env var and restarting the backend.

## Skills

Drop any `.js` or `.ts` file that exports a default `Skill` object into `./volumes/skills/`. The backend hot-loads it immediately via chokidar — no restart needed.

## Development

```bash
# Backend (hot-reload)
cd backend && npm install && npm run dev

# Frontend (hot-reload)
cd frontend && npm install && npm run dev

# Database migrations
cd backend && npm run db:generate   # generate migration from schema changes
cd backend && npm run db:migrate    # apply pending migrations
cd backend && npm run db:studio     # open Drizzle Studio UI
```

## Project Structure

```
myEA/
├── backend/
│   ├── src/
│   │   ├── config/       App configuration (env vars)
│   │   ├── db/           Drizzle ORM schema + connection
│   │   └── types/        Shared TypeScript interfaces
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── App.tsx       Router + page layout
│   │   └── main.tsx      React entry point
│   └── Dockerfile
├── volumes/
│   ├── skills/           Hot-loaded custom skills
│   ├── files/            Assistant file workspace
│   └── logs/             Runtime logs
├── docker-compose.yml
└── .env.example
```
