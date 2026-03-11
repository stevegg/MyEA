#!/usr/bin/env sh
# ============================================================
# myEA Backend — Container Entrypoint
#
# Execution order:
#   1. Wait for PostgreSQL to accept connections (pg_isready loop)
#   2. Run database migrations + initial seed (migrate.ts / migrate.js)
#   3. Exec into the Node.js server so it inherits PID 1 signals
#
# Works in both development (tsx watch) and production (node dist/).
# ============================================================
set -e

# ── Colours for readability in logs ──────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { printf "${GREEN}[entrypoint]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[entrypoint]${NC} %s\n" "$*"; }
error() { printf "${RED}[entrypoint]${NC} %s\n" "$*" >&2; }

# ── Parse DATABASE_URL into pg_isready arguments ─────────────
# Expected format: postgresql://user:password@host:port/dbname
parse_db_url() {
  DB_HOST=$(echo "${DATABASE_URL}" | sed -E 's|.*@([^:/]+).*|\1|')
  DB_PORT=$(echo "${DATABASE_URL}" | sed -E 's|.*:([0-9]+)/.*|\1|')
  DB_USER=$(echo "${DATABASE_URL}" | sed -E 's|.*://([^:]+):.*|\1|')
  DB_NAME=$(echo "${DATABASE_URL}" | sed -E 's|.*/([^?]+).*|\1|')

  DB_HOST="${DB_HOST:-postgres}"
  DB_PORT="${DB_PORT:-5432}"
}

# ── Wait for PostgreSQL ───────────────────────────────────────
wait_for_postgres() {
  info "Waiting for PostgreSQL at ${DB_HOST}:${DB_PORT}..."

  MAX_ATTEMPTS=30
  ATTEMPT=0
  SLEEP_SEC=2

  until pg_isready -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -q 2>/dev/null; do
    ATTEMPT=$((ATTEMPT + 1))
    if [ "${ATTEMPT}" -ge "${MAX_ATTEMPTS}" ]; then
      error "PostgreSQL did not become ready after $((MAX_ATTEMPTS * SLEEP_SEC)) seconds. Aborting."
      exit 1
    fi
    warn "PostgreSQL not ready yet (attempt ${ATTEMPT}/${MAX_ATTEMPTS}) — retrying in ${SLEEP_SEC}s..."
    sleep "${SLEEP_SEC}"
  done

  info "PostgreSQL is ready."
}

# ── Run migrations ────────────────────────────────────────────
run_migrations() {
  info "Running database migrations..."

  if [ "${NODE_ENV}" = "development" ]; then
    # In development use tsx (no compile step needed)
    npx tsx src/db/migrate.ts
  else
    # In production use the compiled output
    node dist/db/migrate.js
  fi

  info "Migrations complete."
}

# ── Start application ─────────────────────────────────────────
start_server() {
  if [ "${NODE_ENV}" = "development" ]; then
    info "Starting backend in development mode (tsx watch)..."
    exec npx tsx watch src/index.ts
  else
    info "Starting backend in production mode..."
    exec node dist/index.js
  fi
}

# ── Signal handling ───────────────────────────────────────────
# Because we use `exec` for the final process, the Node server inherits
# PID 1 and receives SIGTERM/SIGINT directly from Docker, enabling
# Fastify's graceful shutdown hook to fire.
#
# If this script ever spawns background processes, trap them here:
cleanup() {
  warn "Received shutdown signal — cleaning up..."
  # Any cleanup before exec'd process takes over (none needed currently)
}
trap cleanup TERM INT

# ── Main ──────────────────────────────────────────────────────
main() {
  if [ -z "${DATABASE_URL}" ]; then
    error "DATABASE_URL is not set. Cannot start."
    exit 1
  fi

  parse_db_url
  wait_for_postgres
  run_migrations
  start_server
}

main "$@"
