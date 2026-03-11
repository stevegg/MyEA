# ============================================================
# myEA — Makefile
#
# Prerequisites: docker, docker compose (v2) or docker-compose (v1)
#
# Usage:
#   make up           # start all services (production compose)
#   make dev          # start with dev overrides (hot-reload)
#   make down         # stop all services
#   make logs         # tail all service logs
#   make build        # (re)build all images
#   make migrate      # run DB migrations only
#   make shell-backend  # open a shell in the backend container
#   make db           # connect to postgres via psql
#   make reset        # full teardown + restart (DELETES ALL DATA)
# ============================================================

# ── Compose command detection ─────────────────────────────────
COMPOSE := $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")

# ── Default compose files ─────────────────────────────────────
COMPOSE_FILE        := docker-compose.yml
COMPOSE_DEV_FILES   := -f docker-compose.yml -f docker-compose.dev.yml

# ── Colours ───────────────────────────────────────────────────
CYAN  := \033[0;36m
NC    := \033[0m

.DEFAULT_GOAL := help

# ─────────────────────────────────────────────────────────────
# Help
# ─────────────────────────────────────────────────────────────
.PHONY: help
help:
	@printf "$(CYAN)myEA — Available make targets:$(NC)\n\n"
	@printf "  %-22s %s\n" "up"             "Start all services in production mode"
	@printf "  %-22s %s\n" "dev"            "Start all services in development mode (hot-reload)"
	@printf "  %-22s %s\n" "down"           "Stop all services"
	@printf "  %-22s %s\n" "restart"        "Restart all services"
	@printf "  %-22s %s\n" "build"          "(Re)build application images"
	@printf "  %-22s %s\n" "build-no-cache" "Force full rebuild (no layer cache)"
	@printf "  %-22s %s\n" "logs"           "Tail all service logs (Ctrl-C to exit)"
	@printf "  %-22s %s\n" "logs-backend"   "Tail backend logs only"
	@printf "  %-22s %s\n" "logs-frontend"  "Tail frontend logs only"
	@printf "  %-22s %s\n" "logs-postgres"  "Tail postgres logs only"
	@printf "  %-22s %s\n" "migrate"        "Run DB migrations inside the backend container"
	@printf "  %-22s %s\n" "shell-backend"  "Open an interactive shell in the backend container"
	@printf "  %-22s %s\n" "shell-frontend" "Open an interactive shell in the frontend container"
	@printf "  %-22s %s\n" "db"             "Connect to postgres via psql"
	@printf "  %-22s %s\n" "db-dump"        "Dump the database to ./backup.sql"
	@printf "  %-22s %s\n" "db-restore"     "Restore database from ./backup.sql"
	@printf "  %-22s %s\n" "ps"             "Show running containers and health status"
	@printf "  %-22s %s\n" "reset"          "DANGER: stop, delete all volumes, restart fresh"
	@printf "  %-22s %s\n" "pull"           "Pull latest upstream base images"
	@printf "  %-22s %s\n" "setup"          "Run the interactive first-time setup script"
	@printf "\n"

# ─────────────────────────────────────────────────────────────
# Lifecycle
# ─────────────────────────────────────────────────────────────
.PHONY: up
up:
	$(COMPOSE) -f $(COMPOSE_FILE) up -d
	@printf "\nServices started. Frontend: http://localhost:$${FRONTEND_PORT:-3000}\n"

.PHONY: dev
dev:
	@docker rm -f myea-frontend 2>/dev/null || true
	$(COMPOSE) $(COMPOSE_DEV_FILES) up --build frontend
	# Intentionally no -d so logs stream to the terminal in dev mode

.PHONY: dev-detach
dev-detach:
	$(COMPOSE) $(COMPOSE_DEV_FILES) up -d

.PHONY: down
down:
	$(COMPOSE) $(COMPOSE_DEV_FILES) down --remove-orphans

.PHONY: restart
restart: down up

.PHONY: ps
ps:
	$(COMPOSE) -f $(COMPOSE_FILE) ps

# ─────────────────────────────────────────────────────────────
# Build
# ─────────────────────────────────────────────────────────────
.PHONY: build
build:
	$(COMPOSE) -f $(COMPOSE_FILE) build --parallel

.PHONY: build-no-cache
build-no-cache:
	$(COMPOSE) -f $(COMPOSE_FILE) build --no-cache --parallel

.PHONY: pull
pull:
	$(COMPOSE) -f $(COMPOSE_FILE) pull

# ─────────────────────────────────────────────────────────────
# Logs
# ─────────────────────────────────────────────────────────────
.PHONY: logs
logs:
	$(COMPOSE) -f $(COMPOSE_FILE) logs -f --tail=100

.PHONY: logs-backend
logs-backend:
	$(COMPOSE) -f $(COMPOSE_FILE) logs -f --tail=100 backend

.PHONY: logs-frontend
logs-frontend:
	$(COMPOSE) -f $(COMPOSE_FILE) logs -f --tail=100 frontend

.PHONY: logs-postgres
logs-postgres:
	$(COMPOSE) -f $(COMPOSE_FILE) logs -f --tail=100 postgres

# ─────────────────────────────────────────────────────────────
# Database
# ─────────────────────────────────────────────────────────────

# Load .env to pick up POSTGRES_* variables
-include .env
export

POSTGRES_USER    ?= myea
POSTGRES_DB      ?= myea
POSTGRES_PASSWORD ?= myea_secret

.PHONY: migrate
migrate:
	@echo "Running database migrations..."
	docker exec myea-backend sh -c '\
		if [ "$$NODE_ENV" = "development" ]; then \
			npx tsx src/db/migrate.ts; \
		else \
			node dist/db/migrate.js; \
		fi'

.PHONY: db
db:
	docker exec -it myea-postgres \
		psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

.PHONY: db-dump
db-dump:
	@echo "Dumping database to backup.sql..."
	docker exec myea-postgres \
		pg_dump -U $(POSTGRES_USER) -d $(POSTGRES_DB) --clean --if-exists \
		> backup.sql
	@echo "Dump written to backup.sql"

.PHONY: db-restore
db-restore:
	@test -f backup.sql || (echo "backup.sql not found"; exit 1)
	@echo "Restoring database from backup.sql..."
	docker exec -i myea-postgres \
		psql -U $(POSTGRES_USER) -d $(POSTGRES_DB) < backup.sql
	@echo "Restore complete."

# ─────────────────────────────────────────────────────────────
# Shells
# ─────────────────────────────────────────────────────────────
.PHONY: shell-backend
shell-backend:
	docker exec -it myea-backend sh

.PHONY: shell-frontend
shell-frontend:
	docker exec -it myea-frontend sh

# ─────────────────────────────────────────────────────────────
# Dangerous operations
# ─────────────────────────────────────────────────────────────
.PHONY: reset
reset:
	@printf "\n\033[0;31mWARNING: This will DELETE all Docker volumes (database, files, etc.).\033[0m\n"
	@printf "Type YES to confirm: "; read confirm; \
	if [ "$$confirm" != "YES" ]; then \
		echo "Aborted."; exit 1; \
	fi
	$(COMPOSE) -f $(COMPOSE_FILE) down -v --remove-orphans
	$(COMPOSE) -f $(COMPOSE_FILE) up -d
	@printf "\nStack restarted with fresh volumes.\n"

# ─────────────────────────────────────────────────────────────
# Setup
# ─────────────────────────────────────────────────────────────
.PHONY: setup
setup:
	bash setup.sh
