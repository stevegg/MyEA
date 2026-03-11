# ============================================================
# myEA Backend — Multi-stage Dockerfile
#
# Stages:
#   deps        — install ALL npm deps (cached layer)
#   builder     — compile TypeScript
#   development — hot-reload with tsx watch (for dev compose)
#   runner      — lean production image (non-root, system chromium)
# ============================================================

# ── Stage 1: Install all dependencies ────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Build tools for native modules (pg, canvas, etc.)
RUN apk add --no-cache python3 make g++ git

COPY package.json package-lock.json* ./
RUN npm ci

# ── Stage 2: TypeScript build ─────────────────────────────────
FROM deps AS builder

COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY src ./src

RUN npm run build

# Generate Drizzle migration files from the schema
# (requires DATABASE_URL at build time only if using drizzle-kit generate --no-schema-validation,
#  but schema generation is purely file-based and needs no DB connection)
RUN npx drizzle-kit generate --dialect=postgresql --schema=src/db/schema.ts --out=drizzle 2>/dev/null || true

# ── Stage 3: Development (hot-reload) ────────────────────────
FROM deps AS development

WORKDIR /app

# Install dev runtime dependencies
RUN apk add --no-cache \
    curl \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    postgresql-client

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=development

# Copy entrypoint (source is mounted at runtime via compose volume)
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Create volume directories
RUN mkdir -p /app/volumes/skills /app/volumes/files /app/volumes/logs /app/volumes/whatsapp

EXPOSE 3001

# entrypoint.sh handles migration then starts tsx watch
CMD ["./entrypoint.sh"]

# ── Stage 4: Production runner ────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Runtime system dependencies
#   chromium      — headless browser for Playwright scraping skills
#   postgresql-client — pg_isready used by entrypoint.sh
#   python3       — used by certain AI tool scripts
#   curl          — health-check probe
RUN apk add --no-cache \
    curl \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    postgresql-client \
    python3

# Tell Playwright to use system Chromium, skipping its own download
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production

# Install production dependencies only (no devDeps)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy compiled application
COPY --from=builder /app/dist ./dist

# Copy drizzle migrations folder generated during build
COPY --from=builder /app/drizzle ./drizzle

# Copy entrypoint
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Create volume mount points with correct ownership
RUN mkdir -p /app/volumes/skills /app/volumes/files /app/volumes/logs /app/volumes/whatsapp

# Run as non-root for security
#   The node:20-alpine image ships a built-in "node" user (uid 1000)
RUN chown -R node:node /app
USER node

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=30s \
  CMD curl -sf http://localhost:3001/health || exit 1

ENTRYPOINT ["./entrypoint.sh"]
