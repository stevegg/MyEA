/**
 * myEA — Backend Entry Point
 *
 * Bootstraps the Fastify server, registers plugins, sets up the database
 * connection, runs migrations, initialises all services, and starts all
 * enabled platform connectors. Graceful shutdown is handled for SIGTERM/SIGINT.
 *
 * Startup order:
 *   1. Parse config
 *   2. Init DB + run migrations
 *   3. Create DBLogger (wraps Fastify/Pino + persists to DB)
 *   4. Start pg-boss scheduler (with lazy sendMessage ref to break circular dep)
 *   5. Create AIProviderManager
 *   6. Create MemoryService
 *   7. Create Orchestrator (lazy sendMessage ref for PlatformManager)
 *   8. Create SkillEngine; wire tool executor + tools provider into Orchestrator
 *   9. Create PlatformManager; fill in lazy refs; wire inbound → Orchestrator
 *  10. Register Fastify plugins (security, cors, jwt, ws, multipart)
 *  11. Register API route plugins (auth, conversations, memory, skills,
 *      integrations, jobs, logs, settings)
 *  12. Start PlatformManager (opens all enabled connectors)
 *  13. Start SkillEngine (loads built-ins + watches custom dir)
 *  14. Start Fastify HTTP server
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fs from "fs";

import { config } from "./config";
import { initDb, closeDb, createDatabaseService, type DrizzleDB } from "./db";
import { runMigrations } from "./db/migrate";
import { createLogger } from "./services/logger";
import { createMemoryService } from "./services/memory";
import { createSchedulerService } from "./services/scheduler";
import { createOrchestrator, type Orchestrator } from "./services/orchestrator";
import { AIProviderManager } from "./ai/manager";
import { SkillEngine } from "./skills/engine";
import { PlatformManager } from "./platforms/manager";

import type {
  WSEvent,
  SkillContext,
  OutboundMessage,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Fastify server
// ─────────────────────────────────────────────────────────────────────────────

const server = Fastify({
  logger: {
    level: config.nodeEnv === "development" ? "debug" : "info",
    ...(config.nodeEnv === "development"
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
          },
        }
      : {}),
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket broadcast helper
// ─────────────────────────────────────────────────────────────────────────────

const wsClients = new Set<any>();

function broadcast(event: WSEvent): void {
  const payload = JSON.stringify(event);
  for (const client of wsClients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(payload);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ensure volume directories exist
// ─────────────────────────────────────────────────────────────────────────────

function ensureVolumeDirs(): void {
  const dirs = [config.volumes.skillsDir, config.volumes.filesDir, config.volumes.logsDir];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      server.log.info({ dir }, "Created volume directory");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fastify plugin registration (security, cors, jwt, ws, multipart)
// ─────────────────────────────────────────────────────────────────────────────

async function registerPlugins(): Promise<void> {
  await server.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  });

  await server.register(rateLimit, {
    global: true,
    max: 200,
    timeWindow: "1 minute",
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Rate limit exceeded. Retry after ${context.after}.`,
    }),
  });

  await server.register(cors, {
    origin: [config.frontendUrl],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  await server.register(jwt, {
    secret: config.auth.jwtSecret,
    sign: { algorithm: "HS256", expiresIn: config.auth.jwtExpiresIn },
    verify: { algorithms: ["HS256"] },
  });

  await server.register(websocket);

  await server.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// API route plugin registration
// ─────────────────────────────────────────────────────────────────────────────

async function registerRoutes(opts: {
  db: DrizzleDB;
  memory: ReturnType<typeof createMemoryService>;
  scheduler: ReturnType<typeof createSchedulerService>;
  orchestrator: Orchestrator;
  aiManager: AIProviderManager;
  skillEngineRef: { engine?: SkillEngine };
}): Promise<void> {
  const { db, memory, scheduler, orchestrator, aiManager, skillEngineRef } = opts;

  // Health check (unauthenticated)
  server.get("/health", async (_req, reply) => {
    return reply.send({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Auth plugin — registers /auth/login, /auth/register, /auth/me
  // and decorates server with `authenticate`
  const authPlugin = (await import("./api/auth")).default;
  await server.register(authPlugin, { db, config });

  // Conversations plugin
  const conversationsPlugin = (await import("./api/conversations")).default;
  await server.register(conversationsPlugin, { db });

  // Web chat plugin — routes admin UI messages through the orchestrator
  const chatPlugin = (await import("./api/chat")).default;
  await server.register(chatPlugin, { db, orchestrator, broadcast });

  // Memory plugin
  const memoryPlugin = (await import("./api/memory")).default;
  await server.register(memoryPlugin, { memory });

  // Skills plugin — uses a ref container so skillEngine can be assigned after plugin registration
  const skillsPlugin = (await import("./api/skills")).default;
  await server.register(skillsPlugin, { db, orchestrator, skillEngineRef });

  // Integrations plugin
  const integrationsPlugin = (await import("./api/integrations")).default;
  await server.register(integrationsPlugin, { db, config });

  // Jobs plugin
  const jobsPlugin = (await import("./api/jobs")).default;
  await server.register(jobsPlugin, { db, scheduler });

  // Logs plugin
  const logsPlugin = (await import("./api/logs")).default;
  await server.register(logsPlugin, { db });

  // Settings plugin — notify AIProviderManager and Orchestrator on provider/model changes
  const settingsPlugin = (await import("./api/settings")).default;
  await server.register(settingsPlugin, {
    db,
    config,
    onSettingsChange: async ({ provider, model }) => {
      aiManager.switchProvider(provider, model);
      orchestrator.setAIProvider(aiManager.getActiveProvider());
      broadcast({ type: "ai_provider_changed", payload: { provider, model } });
    },
  });

  // Config summary endpoint (authenticated)
  server.register(async function configRoutes(app) {
    app.addHook("onRequest", async (request: any, reply: any) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.status(401).send({ error: "Unauthorized" });
      }
    });

    app.get("/api/config", async (_req, reply) => {
      return reply.send({
        ai: {
          activeProvider: config.ai.activeProvider,
          model: config.ai.model,
          availableProviders: ["claude", "openai", "ollama"],
        },
        platforms: {
          telegram: { enabled: config.platforms.telegram.enabled },
          discord: { enabled: config.platforms.discord.enabled },
          slack: { enabled: config.platforms.slack.enabled },
          whatsapp: { enabled: config.platforms.whatsapp.enabled },
          signal: { enabled: config.platforms.signal.enabled },
        },
        integrations: {
          gmail: { enabled: config.integrations.gmail.enabled },
          github: { enabled: config.integrations.github.enabled },
          spotify: { enabled: config.integrations.spotify.enabled },
          smartHome: { enabled: config.integrations.smartHome.enabled },
        },
      });
    });
  });

  // WebSocket endpoint — JWT verified before upgrade accepted
  const WS_MAX_MESSAGE_BYTES = 64 * 1024;
  server.register(async function wsRoutes(app) {
    app.get(
      "/ws",
      {
        websocket: true,
        preHandler: async (request: any, reply: any) => {
          const query = request.query as Record<string, string | undefined>;
          if (query["token"]) {
            request.headers.authorization = `Bearer ${query["token"]}`;
          }
          try {
            await request.jwtVerify();
          } catch {
            return reply.status(401).send({ error: "Unauthorized" });
          }
        },
      },
      (socket, _request) => {
        wsClients.add(socket);
        server.log.debug({ clientCount: wsClients.size }, "WebSocket client connected");
        socket.send(JSON.stringify({ type: "connected", payload: { timestamp: new Date().toISOString() } }));

        socket.on("message", (raw: any) => {
          const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.toString());
          if (buf.byteLength > WS_MAX_MESSAGE_BYTES) {
            socket.send(JSON.stringify({ type: "error", payload: "Message too large" }));
            return;
          }
          try {
            const msg = JSON.parse(buf.toString());
            server.log.debug({ msg }, "WebSocket message from client");
            socket.send(JSON.stringify({ type: "ack", payload: msg }));
          } catch {
            socket.send(JSON.stringify({ type: "error", payload: "Invalid JSON" }));
          }
        });

        socket.on("close", () => {
          wsClients.delete(socket);
          server.log.debug({ clientCount: wsClients.size }, "WebSocket client disconnected");
        });

        socket.on("error", (err: Error) => {
          server.log.error({ err }, "WebSocket error");
          wsClients.delete(socket);
        });
      }
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  server.log.info({ env: config.nodeEnv }, "Starting myEA backend");
  ensureVolumeDirs();

  // ── 1. Database ────────────────────────────────────────────
  const db = initDb(config, server.log as any);
  const dbService = createDatabaseService(db, server.log as any);

  try {
    await runMigrations();
    server.log.info("Database migrations complete");
  } catch (err) {
    server.log.error({ err }, "Migration failed — continuing anyway");
  }

  const alive = await dbService.ping();
  if (!alive) {
    server.log.error("Cannot reach PostgreSQL — check DATABASE_URL and that postgres is running");
  }

  // ── 2. Logger ──────────────────────────────────────────────
  const logger = createLogger(server.log as any, db, "app");

  // ── 3. pg-boss scheduler ───────────────────────────────────
  // Use a lazy ref for sendMessage so the scheduler can be created before
  // the PlatformManager, avoiding a circular dependency.
  let sendMessageRef: ((msg: OutboundMessage) => Promise<void>) | null = null;

  const PgBoss = (await import("pg-boss")).default;
  const boss = new PgBoss({
    connectionString: config.database.url,
    max: 10,
    retryLimit: 3,
    retryDelay: 30,
    expireInHours: 23,
    deleteAfterDays: 7,
    archiveCompletedAfterSeconds: 3600,
    maintenanceIntervalSeconds: 120,
    monitorStateIntervalSeconds: 60,
  });
  boss.on("error", (err) => logger.error({ err }, "pg-boss error"));
  await boss.start();
  logger.info("pg-boss scheduler started");

  // The scheduler's built-in SEND_MESSAGE/REMINDER workers delegate to this
  // lazy ref. It will be populated before any jobs fire (after PlatformManager
  // is started in step 9).
  const scheduler = createSchedulerService(boss, db, logger, async (msg: OutboundMessage) => {
    if (sendMessageRef) {
      await sendMessageRef(msg);
    } else {
      logger.warn({ platform: msg.platform }, "Scheduler: PlatformManager not ready — message dropped");
    }
  });

  // ── 4. AI Provider Manager ─────────────────────────────────
  const aiManager = new AIProviderManager(config, logger);

  // ── 5. Memory Service ──────────────────────────────────────
  const memory = createMemoryService(db, logger);

  // ── 6. Orchestrator ────────────────────────────────────────
  // Same lazy-ref pattern to break the Orchestrator → PlatformManager cycle.
  let platformManagerRef: PlatformManager | null = null;

  const orchestrator = createOrchestrator({
    db,
    dbService,
    aiProvider: aiManager.getActiveProvider(),
    memory,
    scheduler,
    logger,
    config,
    sendMessage: async (msg: OutboundMessage) => {
      if (platformManagerRef) {
        await platformManagerRef.send(msg);
      } else {
        logger.warn({ platform: msg.platform }, "Orchestrator: PlatformManager not ready — message dropped");
      }
    },
  });

  // ── 7. Skills Engine ───────────────────────────────────────
  // skillEngineRef is declared here so it can be passed to registerRoutes
  // and populated before any HTTP request can hit the skills API.
  const skillEngineRef: { engine?: SkillEngine } = {};
  const skillEngine = new SkillEngine(logger, config.volumes.skillsDir);
  skillEngineRef.engine = skillEngine;

  // Delegate all tool execution and tool discovery to the SkillEngine.
  // This gives the orchestrator live access to hot-reloaded tools.
  orchestrator.setToolExecutor(
    (toolName, params, context) => skillEngine.executeTool(toolName, params, context)
  );
  orchestrator.setToolsProvider(() =>
    skillEngine.getAllTools().map((t) => ({
      name: t.toolName,
      description: t.description,
      inputSchema: t.parameters as import("./types").JSONSchema,
    }))
  );

  // Propagate skill lifecycle events to connected WebSocket clients
  skillEngine.on("skill:loaded", ({ entry }) => {
    broadcast({ type: "skill_loaded", payload: entry });
  });
  skillEngine.on("skill:unloaded", ({ name }) => {
    broadcast({ type: "skill_unloaded", payload: { name } });
  });
  skillEngine.on("skill:error", ({ name, error }) => {
    broadcast({ type: "skill_error", payload: { name, error } });
  });

  // ── 8. Platform Manager ────────────────────────────────────
  const platformManager = new PlatformManager(config, logger, broadcast);

  // Fill in both lazy refs now that PlatformManager exists
  platformManagerRef = platformManager;
  sendMessageRef = async (msg: OutboundMessage) => {
    try {
      await platformManager.send(msg);
    } catch (err) {
      logger.error({ err, platform: msg.platform }, "PlatformManager.send failed");
    }
  };

  // Route every inbound platform message through the orchestrator
  platformManager.onMessage(async (msg) => {
    try {
      const reply = await orchestrator.handleInbound(msg);
      await platformManager.send(reply);
      broadcast({ type: "message_sent", payload: reply });
    } catch (err) {
      logger.error({ err, platform: msg.platform, msgId: msg.id }, "Orchestrator failed to handle message");
    }
  });

  // ── 9. Register Fastify plugins + routes ───────────────────
  await registerPlugins();
  await registerRoutes({ db, memory, scheduler, orchestrator, aiManager, skillEngineRef });

  // ── 10. Start Platform Manager ─────────────────────────────
  await platformManager.start();

  // ── 11. Start Skills Engine ────────────────────────────────
  const skillContext: SkillContext = {
    config,
    db: dbService,
    memory,
    scheduler,
    logger,
    sendMessage: async (msg: OutboundMessage) => {
      await platformManager.send(msg);
    },
  };
  await skillEngine.start(skillContext);

  // ── 12. Start HTTP server ──────────────────────────────────
  await server.listen({ port: config.port, host: "0.0.0.0" });
  logger.info({ port: config.port }, "myEA backend listening");

  // ── Graceful shutdown ──────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutdown signal received");
    try {
      await server.close();
      await platformManager.stop();
      await skillEngine.stop();
      await boss.stop();
      await closeDb(logger as any);
      logger.info("Graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

bootstrap().catch((err) => {
  console.error("Fatal error during bootstrap:", err);
  process.exit(1);
});
