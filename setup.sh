#!/usr/bin/env bash
# ============================================================
# myEA — One-command Setup Script
#
# Usage:
#   chmod +x setup.sh && ./setup.sh
#
# What it does:
#   1. Checks prerequisites (docker, docker compose)
#   2. Copies .env.example -> .env if not present
#   3. Prompts for admin credentials
#   4. Prompts for at least one AI provider key
#   5. Generates a strong JWT_SECRET
#   6. Creates required host volume directories
#   7. Pulls Docker images
#   8. Builds application images
#   9. Starts the stack
#  10. Prints the admin UI URL
# ============================================================
set -euo pipefail

# ── Colours ───────────────────────────────────────────────────
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { printf "${GREEN}[setup]${NC} %s\n" "$*"; }
warn()    { printf "${YELLOW}[setup]${NC} %s\n" "$*"; }
error()   { printf "${RED}[setup]${NC} ERROR: %s\n" "$*" >&2; }
header()  { printf "\n${BOLD}${CYAN}=== %s ===${NC}\n\n" "$*"; }
success() { printf "${GREEN}%s${NC}\n" "$*"; }

# ── Script dir (always operate relative to setup.sh location) ─
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

ENV_FILE="${SCRIPT_DIR}/.env"
ENV_EXAMPLE="${SCRIPT_DIR}/.env.example"

# ─────────────────────────────────────────────────────────────
# 1. Prerequisites
# ─────────────────────────────────────────────────────────────
header "Checking prerequisites"

check_command() {
  local cmd="$1"
  local install_hint="$2"
  if ! command -v "${cmd}" &>/dev/null; then
    error "'${cmd}' is not installed. ${install_hint}"
    exit 1
  fi
  info "${cmd}: $(${cmd} --version 2>&1 | head -1)"
}

check_command docker "Install from https://docs.docker.com/get-docker/"

# Support both 'docker compose' (v2 plugin) and 'docker-compose' (v1 standalone)
if docker compose version &>/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE_CMD="docker-compose"
else
  error "Docker Compose not found. Install from https://docs.docker.com/compose/install/"
  exit 1
fi
info "Compose: $(${COMPOSE_CMD} version 2>&1 | head -1)"

# Check Docker daemon is running
if ! docker info &>/dev/null; then
  error "Docker daemon is not running. Start Docker and try again."
  exit 1
fi

success "All prerequisites satisfied."

# ─────────────────────────────────────────────────────────────
# 2. Environment file
# ─────────────────────────────────────────────────────────────
header "Environment configuration"

if [ ! -f "${ENV_FILE}" ]; then
  if [ ! -f "${ENV_EXAMPLE}" ]; then
    error ".env.example not found at ${ENV_EXAMPLE}"
    exit 1
  fi
  cp "${ENV_EXAMPLE}" "${ENV_FILE}"
  info "Created .env from .env.example"
else
  warn ".env already exists — skipping copy (delete it to start fresh)"
fi

# Helper: read/write a value in the .env file
env_get() {
  local key="$1"
  grep -E "^${key}=" "${ENV_FILE}" | head -1 | cut -d'=' -f2- | sed "s/^['\"]//;s/['\"]$//"
}

env_set() {
  local key="$1"
  local value="$2"
  # Escape special characters in value for sed
  local escaped_value
  escaped_value=$(printf '%s\n' "${value}" | sed 's/[[\.*^$()+?{|]/\\&/g')
  if grep -qE "^${key}=" "${ENV_FILE}"; then
    sed -i.bak "s|^${key}=.*|${key}=${escaped_value}|" "${ENV_FILE}" && rm -f "${ENV_FILE}.bak"
  else
    echo "${key}=${value}" >> "${ENV_FILE}"
  fi
}

# ─────────────────────────────────────────────────────────────
# 3. Admin credentials
# ─────────────────────────────────────────────────────────────
header "Admin credentials"

CURRENT_ADMIN=$(env_get "ADMIN_USERNAME")
if [ -z "${CURRENT_ADMIN}" ] || [ "${CURRENT_ADMIN}" = "admin" ]; then
  read -rp "Admin username [admin]: " ADMIN_USERNAME
  ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
else
  read -rp "Admin username [${CURRENT_ADMIN}]: " ADMIN_USERNAME
  ADMIN_USERNAME="${ADMIN_USERNAME:-${CURRENT_ADMIN}}"
fi
env_set "ADMIN_USERNAME" "${ADMIN_USERNAME}"

# Check if a valid password hash already exists
CURRENT_HASH=$(env_get "ADMIN_PASSWORD_HASH")
PLACEHOLDER='$2b$12$replacethiswithyourbcrypthash'
if [ "${CURRENT_HASH}" = "${PLACEHOLDER}" ] || [ -z "${CURRENT_HASH}" ]; then
  while true; do
    read -rsp "Admin password (min 8 chars): " ADMIN_PASSWORD
    echo
    if [ "${#ADMIN_PASSWORD}" -lt 8 ]; then
      warn "Password must be at least 8 characters."
      continue
    fi
    read -rsp "Confirm password: " ADMIN_PASSWORD2
    echo
    if [ "${ADMIN_PASSWORD}" != "${ADMIN_PASSWORD2}" ]; then
      warn "Passwords do not match. Try again."
      continue
    fi
    break
  done

  env_set "ADMIN_PASSWORD" "${ADMIN_PASSWORD}"
  env_set "ADMIN_PASSWORD_HASH" ""
  info "Admin password stored."
else
  info "ADMIN_PASSWORD_HASH already configured — skipping password prompt."
  # Still need ADMIN_PASSWORD for the post-start DB update
  ADMIN_PASSWORD=""
fi

# ─────────────────────────────────────────────────────────────
# 4. AI provider
# ─────────────────────────────────────────────────────────────
header "AI provider configuration"

CURRENT_PROVIDER=$(env_get "ACTIVE_AI_PROVIDER")
info "Current provider: ${CURRENT_PROVIDER:-claude}"
echo "Available providers: claude, openai, ollama"
read -rp "AI provider [${CURRENT_PROVIDER:-claude}]: " ACTIVE_PROVIDER
ACTIVE_PROVIDER="${ACTIVE_PROVIDER:-${CURRENT_PROVIDER:-claude}}"
env_set "ACTIVE_AI_PROVIDER" "${ACTIVE_PROVIDER}"

case "${ACTIVE_PROVIDER}" in
  claude)
    CURRENT_KEY=$(env_get "ANTHROPIC_API_KEY")
    if [ -z "${CURRENT_KEY}" ] || [ "${CURRENT_KEY}" = "sk-ant-..." ]; then
      read -rsp "Anthropic API key (sk-ant-...): " ANTHROPIC_KEY
      echo
      if [ -z "${ANTHROPIC_KEY}" ]; then
        warn "No Anthropic key provided. You can set ANTHROPIC_API_KEY in .env later."
      else
        env_set "ANTHROPIC_API_KEY" "${ANTHROPIC_KEY}"
      fi
    else
      info "ANTHROPIC_API_KEY already configured."
    fi
    ;;
  openai)
    CURRENT_KEY=$(env_get "OPENAI_API_KEY")
    if [ -z "${CURRENT_KEY}" ] || [ "${CURRENT_KEY}" = "sk-..." ]; then
      read -rsp "OpenAI API key (sk-...): " OPENAI_KEY
      echo
      if [ -z "${OPENAI_KEY}" ]; then
        warn "No OpenAI key provided. You can set OPENAI_API_KEY in .env later."
      else
        env_set "OPENAI_API_KEY" "${OPENAI_KEY}"
      fi
    else
      info "OPENAI_API_KEY already configured."
    fi
    ;;
  ollama)
    info "Ollama selected — no API key required."
    info "Make sure the ollama service can start (it requires significant RAM)."
    warn "On first use, pull a model: docker exec myea-ollama ollama pull llama3.2"
    ;;
  *)
    warn "Unknown provider '${ACTIVE_PROVIDER}'. Make sure to configure the relevant API key in .env."
    ;;
esac

# ─────────────────────────────────────────────────────────────
# 5. JWT secret
# ─────────────────────────────────────────────────────────────
header "Security configuration"

CURRENT_JWT=$(env_get "JWT_SECRET")
if [ -z "${CURRENT_JWT}" ] || [ "${CURRENT_JWT}" = "change_me_to_a_long_random_secret" ]; then
  info "Generating JWT_SECRET..."
  JWT_SECRET=$(openssl rand -base64 64 | tr -d '\n')
  env_set "JWT_SECRET" "${JWT_SECRET}"
  info "JWT_SECRET generated and written to .env"
else
  info "JWT_SECRET already configured."
fi

# ─────────────────────────────────────────────────────────────
# 6. Volume directories (bind-mounts no longer used — named vols)
# ─────────────────────────────────────────────────────────────
header "Volume directories"

# Named volumes are managed by Docker; we just note this.
info "Using Docker named volumes for all persistent data."
info "Volumes: postgres_data, ollama_models, whatsapp_session, files_data, skills_data, logs_data, signal_data"

# ─────────────────────────────────────────────────────────────
# 7. Pull images
# ─────────────────────────────────────────────────────────────
header "Pulling base Docker images"

info "Pulling postgres:16-alpine..."
docker pull postgres:16-alpine

info "Pulling ollama/ollama:latest..."
docker pull ollama/ollama:latest || warn "Could not pull ollama image (optional service)"

info "Pulling bbernhard/signal-cli-rest-api:latest..."
docker pull bbernhard/signal-cli-rest-api:latest || warn "Could not pull signal-cli image (optional service)"

info "Pulling nginx:1.27-alpine..."
docker pull nginx:1.27-alpine

# ─────────────────────────────────────────────────────────────
# 8. Build application images
# ─────────────────────────────────────────────────────────────
header "Building application images"

info "Building backend and frontend images (this may take a few minutes on first run)..."
${COMPOSE_CMD} build --parallel

# ─────────────────────────────────────────────────────────────
# 9. Start the stack
# ─────────────────────────────────────────────────────────────
header "Starting myEA"

info "Starting all services..."
${COMPOSE_CMD} up -d

# ── Helper: update admin password in DB via running container ──
set_admin_password() {
  local username="$1"
  local password="$2"
  if [ -z "${password}" ]; then
    return 0
  fi
  info "Setting admin password in database..."
  local hash
  hash=$(docker exec -w /app myea-backend node -e \
    "const b=require('bcryptjs');b.hash(process.argv[1],12).then(h=>{process.stdout.write(h)})" \
    "${password}" 2>/dev/null)
  if [ -z "${hash}" ]; then
    warn "Could not hash password via container — try again after startup with:"
    warn "  docker exec myea-backend node -e 'const b=require(\"bcryptjs\");b.hash(\"PASSWORD\",12).then(h=>process.stdout.write(h))'"
    return 1
  fi
  docker exec myea-postgres psql -U "${POSTGRES_USER:-myea}" -d "${POSTGRES_DB:-myea}"     -c "INSERT INTO users (id,username,password_hash,is_admin,display_name,created_at,updated_at)
        VALUES (gen_random_uuid(),'${username}','${hash}',true,'${username}',now(),now())
        ON CONFLICT (username) DO UPDATE SET password_hash=EXCLUDED.password_hash,updated_at=now();"     -q 2>/dev/null && info "Admin password set for user '${username}'." || warn "DB update failed — check logs."
}

info "Waiting for services to become healthy..."
WAIT_SECS=90
ELAPSED=0
SLEEP_INTERVAL=5

while [ "${ELAPSED}" -lt "${WAIT_SECS}" ]; do
  BACKEND_HEALTH=$(docker inspect --format='{{.State.Health.Status}}' myea-backend 2>/dev/null || echo "unknown")
  FRONTEND_HEALTH=$(docker inspect --format='{{.State.Health.Status}}' myea-frontend 2>/dev/null || echo "unknown")

  if [ "${BACKEND_HEALTH}" = "healthy" ] && [ "${FRONTEND_HEALTH}" = "healthy" ]; then
    break
  fi

  printf "  backend: %-12s  frontend: %-12s  (waiting %ds/%ds)\r" \
    "${BACKEND_HEALTH}" "${FRONTEND_HEALTH}" "${ELAPSED}" "${WAIT_SECS}"

  sleep "${SLEEP_INTERVAL}"
  ELAPSED=$((ELAPSED + SLEEP_INTERVAL))
done
echo

BACKEND_HEALTH=$(docker inspect --format='{{.State.Health.Status}}' myea-backend 2>/dev/null || echo "unknown")
if [ "${BACKEND_HEALTH}" != "healthy" ]; then
  warn "Backend did not reach healthy state within ${WAIT_SECS}s."
  warn "Check logs with: ${COMPOSE_CMD} logs backend"
fi

# ─────────────────────────────────────────────────────────────
# 10. Done
# ─────────────────────────────────────────────────────────────
# Set/update admin password now that the stack is running
ADMIN_PASSWORD_CURRENT=$(env_get "ADMIN_PASSWORD")
if [ -n "${ADMIN_PASSWORD_CURRENT}" ]; then
  set_admin_password "${ADMIN_USERNAME}" "${ADMIN_PASSWORD_CURRENT}"
  # Clear plaintext from .env now that it's in the DB
  env_set "ADMIN_PASSWORD" ""
  info "Plain-text password cleared from .env."
fi

FRONTEND_PORT=$(env_get "FRONTEND_PORT")
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
BACKEND_PORT=$(env_get "BACKEND_PORT")
BACKEND_PORT="${BACKEND_PORT:-3001}"

printf "\n"
success "================================================================"
success "  myEA is running!"
success "================================================================"
success ""
success "  Admin UI:      http://localhost:${FRONTEND_PORT}"
success "  Backend API:   http://localhost:${BACKEND_PORT}"
success "  Username:      ${ADMIN_USERNAME}"
success ""
success "  View logs:     ${COMPOSE_CMD} logs -f"
success "  Stop:          ${COMPOSE_CMD} down"
success "  Shell:         docker exec -it myea-backend sh"
success ""
success "================================================================"
