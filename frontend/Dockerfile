# ============================================================
# myEA Frontend — Multi-stage Dockerfile
#
# Stages:
#   deps        — install npm deps (cached layer)
#   builder     — vite production build
#   development — vite dev server with HMR (for dev compose)
#   runner      — nginx-alpine serving the static SPA
# ============================================================

# ── Stage 1: Install dependencies ────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# ── Stage 2: Production build ─────────────────────────────────
FROM deps AS builder

ARG VITE_API_URL=http://localhost:3001
ARG VITE_WS_URL=ws://localhost:3001

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL

COPY . .
RUN npm run build

# ── Stage 3: Development (Vite dev server + HMR) ─────────────
FROM deps AS development

WORKDIR /app

ENV NODE_ENV=development

# Source is mounted via docker-compose volume at runtime
COPY package.json package-lock.json* ./

EXPOSE 5173

# --host exposes Vite outside the container so the host browser can reach it
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "5173"]

# ── Stage 4: Production runner (nginx) ───────────────────────
FROM nginx:1.27-alpine AS runner

# Remove default nginx site config
RUN rm /etc/nginx/conf.d/default.conf

# Install curl for health-check
RUN apk add --no-cache curl

# Write nginx config inline so the Dockerfile is self-contained
# (also supports an optional nginx.conf override from the build context)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy the compiled SPA
COPY --from=builder /app/dist /usr/share/nginx/html

# Ensure nginx can write its pid/temp files when run as non-root (optional hardening)
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chown -R nginx:nginx /var/cache/nginx && \
    touch /var/run/nginx.pid && \
    chown nginx:nginx /var/run/nginx.pid

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=15s \
  CMD curl -sf http://localhost:80 || exit 1

CMD ["nginx", "-g", "daemon off;"]
