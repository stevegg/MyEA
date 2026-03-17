/**
 * myEA — Settings API Routes
 *
 *   GET  /api/settings              — return the current runtime settings snapshot
 *   PUT  /api/settings              — update settings and optionally reload the AI provider
 *   POST /api/settings/test-ai      — probe the active AI provider and return available models
 *   PUT  /api/settings/password     — change the authenticated admin's password
 *
 * All routes require a valid JWT (app.authenticate preHandler).
 *
 * Architecture note
 * -----------------
 * Settings are the canonical source of truth for runtime configuration. They
 * are stored in the DB as a single JSON row keyed by name="global" inside the
 * integrations table (re-used as a generic key-value store). On server startup
 * the persisted row is merged with env-var defaults so that environment
 * variables always win on first boot while the admin UI can override them
 * afterwards.
 *
 * The `onSettingsChange` callback passed to the plugin is invoked whenever the
 * AI provider or model changes, so the AI engine can hot-swap providers without
 * a restart.
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import type { DrizzleDB } from "../db";
import type { AppConfig, AIProviderName } from "../types";
import { users, integrations } from "../db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Settings shape surfaced to the admin UI
// ─────────────────────────────────────────────────────────────────────────────

export interface PublicSettings {
  ai: {
    activeProvider: AIProviderName;
    model: string;
    ollamaBaseUrl: string;
    /** Whether each provider has a key configured (never send the actual key). */
    anthropicConfigured: boolean;
    openaiConfigured: boolean;
  };
  platforms: {
    telegram: { enabled: boolean; configured: boolean };
    discord: { enabled: boolean; configured: boolean };
    slack: { enabled: boolean; configured: boolean };
    whatsapp: { enabled: boolean; configured: boolean };
    signal: { enabled: boolean; configured: boolean };
    imessage: { enabled: boolean; configured: boolean; bridgeUrl: string };
  };
  assistant: {
    timezone: string;
    defaultPlatform: string;
    maxHistory: number;
    execTimeoutMs: number;
  };
}

/** Persisted subset — we only store overrides; env vars fill in the rest. */
interface PersistedSettings {
  ai?: {
    activeProvider?: AIProviderName;
    model?: string;
    ollamaBaseUrl?: string;
  };
  platforms?: {
    telegram?: { enabled?: boolean };
    discord?: { enabled?: boolean };
    slack?: { enabled?: boolean };
    whatsapp?: { enabled?: boolean };
    signal?: { enabled?: boolean };
    imessage?: { enabled?: boolean };
  };
  assistant?: {
    timezone?: string;
    defaultPlatform?: string;
    maxHistory?: number;
    execTimeoutMs?: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin options
// ─────────────────────────────────────────────────────────────────────────────

interface SettingsPluginOptions {
  db: DrizzleDB;
  config: AppConfig;
  /**
   * Called when the AI provider or model is changed via PUT /api/settings.
   * Use this to hot-swap the active AI engine instance.
   */
  onSettingsChange?: (updated: { provider: AIProviderName; model: string }) => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS_ROW_NAME = "__app_settings__";

// ─────────────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────────────

const settingsPlugin: FastifyPluginAsync<SettingsPluginOptions> = async (
  app: FastifyInstance,
  opts: SettingsPluginOptions
) => {
  const { db, config, onSettingsChange } = opts;

  // ── GET /api/settings ──────────────────────────────────────

  app.get(
    "/api/settings",
    { preHandler: [app.authenticate] },
    async (_request, reply) => {
      const persisted = await loadPersistedSettings(db);
      const merged = mergeWithDefaults(persisted, config);
      return reply.send(merged);
    }
  );

  // ── PUT /api/settings ──────────────────────────────────────

  app.put<{ Body: Partial<PersistedSettings> }>(
    "/api/settings",
    {
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: "object",
          properties: {
            ai: {
              type: "object",
              properties: {
                activeProvider: { type: "string", enum: ["claude", "openai", "ollama"] },
                model: { type: "string", minLength: 1 },
                ollamaBaseUrl: { type: "string", minLength: 1 },
              },
            },
            platforms: {
              type: "object",
              properties: {
                telegram: { type: "object", properties: { enabled: { type: "boolean" } } },
                discord: { type: "object", properties: { enabled: { type: "boolean" } } },
                slack: { type: "object", properties: { enabled: { type: "boolean" } } },
                whatsapp: { type: "object", properties: { enabled: { type: "boolean" } } },
                signal: { type: "object", properties: { enabled: { type: "boolean" } } },
                imessage: { type: "object", properties: { enabled: { type: "boolean" } } },
              },
            },
            assistant: {
              type: "object",
              properties: {
                timezone: { type: "string", minLength: 1 },
                defaultPlatform: { type: "string" },
                maxHistory: { type: "integer", minimum: 1, maximum: 1000 },
                execTimeoutMs: { type: "integer", minimum: 1000, maximum: 300_000 },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const incoming = request.body;

      // Validate timezone string if provided
      if (incoming.assistant?.timezone) {
        try {
          Intl.DateTimeFormat(undefined, { timeZone: incoming.assistant.timezone });
        } catch {
          return reply.status(400).send({ error: `Invalid timezone: "${incoming.assistant.timezone}"` });
        }
      }

      // Load current persisted settings and deep-merge the incoming patch
      const current = await loadPersistedSettings(db);
      const updated = deepMerge(current as Record<string, unknown>, incoming as Record<string, unknown>) as unknown as PersistedSettings;

      await savePersistedSettings(db, updated);

      // If the AI provider or model changed, notify the engine
      const aiChanged =
        incoming.ai?.activeProvider !== undefined || incoming.ai?.model !== undefined;

      if (aiChanged && onSettingsChange) {
        const merged = mergeWithDefaults(updated, config);
        try {
          await onSettingsChange({
            provider: merged.ai.activeProvider,
            model: merged.ai.model,
          });
          request.log.info(
            { provider: merged.ai.activeProvider, model: merged.ai.model },
            "AI provider reloaded after settings change"
          );
        } catch (err) {
          request.log.error({ err }, "Failed to reload AI provider after settings change");
          // Return the saved settings anyway — provider swap failure is non-fatal
        }
      }

      const merged = mergeWithDefaults(updated, config);
      return reply.send(merged);
    }
  );

  // ── POST /api/settings/test-ai ─────────────────────────────

  app.post(
    "/api/settings/test-ai",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const persisted = await loadPersistedSettings(db);
      const merged = mergeWithDefaults(persisted, config);

      const provider = merged.ai.activeProvider;
      const ollamaBaseUrl = merged.ai.ollamaBaseUrl;

      try {
        switch (provider) {
          case "claude": {
            if (!config.ai.anthropicApiKey) {
              return reply.status(400).send({
                success: false,
                error: "ANTHROPIC_API_KEY is not configured.",
              });
            }
            const Anthropic = (await import("@anthropic-ai/sdk")).default;
            const client = new Anthropic({ apiKey: config.ai.anthropicApiKey });
            // Test connectivity with a minimal request
            let models: {id: string; name: string}[] = [
              { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
              { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
              { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
            ];
            try {
              const modelsPage = await (client as any).models?.list?.({ limit: 50 });
              if (modelsPage?.data?.length) {
                models = modelsPage.data.map((m: { id: string; display_name?: string }) => ({
                  id: m.id, name: m.display_name ?? m.id,
                }));
              }
            } catch { /* use hardcoded fallback */ }
            return reply.send({ success: true, provider, models });
          }

          case "openai": {
            if (!config.ai.openaiApiKey) {
              return reply.status(400).send({
                success: false,
                error: "OPENAI_API_KEY is not configured.",
              });
            }
            const { default: OpenAI } = await import("openai");
            const client = new OpenAI({ apiKey: config.ai.openaiApiKey });
            const page = await client.models.list();
            const models = page.data
              .filter((m: { id: string }) => m.id.startsWith("gpt"))
              .map((m: { id: string }) => ({ id: m.id, name: m.id }));
            return reply.send({ success: true, provider, models });
          }

          case "ollama": {
            const { default: axios } = await import("axios");
            const res = await axios.get<{ models: Array<{ name: string }> }>(
              `${ollamaBaseUrl}/api/tags`,
              { timeout: 5000 }
            );
            const models = (res.data.models ?? []).map((m) => ({
              id: m.name,
              name: m.name,
            }));
            return reply.send({ success: true, provider, models });
          }

          default:
            return reply.status(400).send({ success: false, error: `Unknown provider: ${provider}` });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.warn({ err, provider }, "AI provider test failed");
        return reply.status(502).send({ success: false, error: message });
      }
    }
  );

  // ── PUT /api/settings/password ─────────────────────────────

  app.put<{
    Body: {
      currentPassword: string;
      newPassword: string;
    };
  }>(
    "/api/settings/password",
    {
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: "object",
          required: ["currentPassword", "newPassword"],
          properties: {
            currentPassword: { type: "string", minLength: 1 },
            newPassword: { type: "string", minLength: 8 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id: userId } = request.user;
      const { currentPassword, newPassword } = request.body;

      // The env-admin pseudo-user cannot change password through this endpoint
      if (userId === "env-admin") {
        return reply.status(403).send({
          error: "The environment-configured admin password must be changed via ADMIN_PASSWORD_HASH.",
        });
      }

      const [dbUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!dbUser) {
        return reply.status(404).send({ error: "User not found" });
      }

      // Verify the supplied current password
      const valid = await bcrypt.compare(currentPassword, dbUser.passwordHash);
      if (!valid) {
        return reply.status(401).send({ error: "Current password is incorrect" });
      }

      // Hash and persist the new password
      const newHash = await bcrypt.hash(newPassword, 12);

      await db
        .update(users)
        .set({ passwordHash: newHash, updatedAt: new Date() })
        .where(eq(users.id, userId));

      request.log.info({ userId }, "Admin password changed");
      return reply.send({ success: true });
    }
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Settings persistence helpers (stored in the integrations table)
// ─────────────────────────────────────────────────────────────────────────────

async function loadPersistedSettings(db: DrizzleDB): Promise<PersistedSettings> {
  const [row] = await db
    .select({ config: integrations.config })
    .from(integrations)
    .where(eq(integrations.name, SETTINGS_ROW_NAME))
    .limit(1);

  if (!row) return {};
  return (row.config ?? {}) as PersistedSettings;
}

async function savePersistedSettings(db: DrizzleDB, settings: PersistedSettings): Promise<void> {
  await db
    .insert(integrations)
    .values({
      name: SETTINGS_ROW_NAME,
      displayName: "Application Settings",
      enabled: true,
      status: "connected",
      config: settings as Record<string, unknown>,
    })
    .onConflictDoUpdate({
      target: integrations.name,
      set: {
        config: settings as Record<string, unknown>,
        updatedAt: new Date(),
      },
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge persisted overrides on top of env-var defaults
// ─────────────────────────────────────────────────────────────────────────────

function mergeWithDefaults(persisted: PersistedSettings, config: AppConfig): PublicSettings {
  return {
    ai: {
      activeProvider: persisted.ai?.activeProvider ?? config.ai.activeProvider,
      model: persisted.ai?.model ?? config.ai.model,
      ollamaBaseUrl: persisted.ai?.ollamaBaseUrl ?? config.ai.ollamaBaseUrl,
      anthropicConfigured: Boolean(config.ai.anthropicApiKey),
      openaiConfigured: Boolean(config.ai.openaiApiKey),
    },
    platforms: {
      telegram: {
        enabled: persisted.platforms?.telegram?.enabled ?? config.platforms.telegram.enabled,
        configured: Boolean(config.platforms.telegram.botToken),
      },
      discord: {
        enabled: persisted.platforms?.discord?.enabled ?? config.platforms.discord.enabled,
        configured: Boolean(config.platforms.discord.botToken && config.platforms.discord.clientId),
      },
      slack: {
        enabled: persisted.platforms?.slack?.enabled ?? config.platforms.slack.enabled,
        configured: Boolean(config.platforms.slack.botToken),
      },
      whatsapp: {
        enabled: persisted.platforms?.whatsapp?.enabled ?? config.platforms.whatsapp.enabled,
        configured: config.platforms.whatsapp.enabled, // WhatsApp uses web session, no token to check
      },
      signal: {
        enabled: persisted.platforms?.signal?.enabled ?? config.platforms.signal.enabled,
        configured: Boolean(config.platforms.signal.phoneNumber),
      },
      imessage: {
        enabled: persisted.platforms?.imessage?.enabled ?? config.platforms.imessage.enabled,
        configured: Boolean(config.platforms.imessage.password),
        bridgeUrl: config.platforms.imessage.bridgeUrl,
      },
    },
    assistant: {
      timezone: persisted.assistant?.timezone ?? "UTC",
      defaultPlatform: persisted.assistant?.defaultPlatform ?? "internal",
      maxHistory: persisted.assistant?.maxHistory ?? 50,
      execTimeoutMs: persisted.assistant?.execTimeoutMs ?? 30_000,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: recursive deep-merge (only plain objects, not arrays)
// ─────────────────────────────────────────────────────────────────────────────

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Partial<T>): T {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const patchVal = patch[key];
    const baseVal = base[key];
    if (
      patchVal !== null &&
      patchVal !== undefined &&
      typeof patchVal === "object" &&
      !Array.isArray(patchVal) &&
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal)
    ) {
      result[key as string] = deepMerge(
        baseVal as Record<string, unknown>,
        patchVal as Record<string, unknown>
      );
    } else if (patchVal !== undefined) {
      result[key as string] = patchVal;
    }
  }
  return result as T;
}

export default fp(settingsPlugin, {
  name: "settings-routes",
  dependencies: ["auth"],
});

/**
 * Exported helper — returns the user's configured IANA timezone string,
 * falling back to "UTC" if not set. Used by the orchestrator to format
 * the current time in the system prompt so the AI uses the correct offset.
 *
 * Accepts either a raw DrizzleDB instance or a DatabaseService (whose `.db`
 * property is the underlying Drizzle instance).
 */
export async function getUserTimezone(db: DrizzleDB | { db: unknown }): Promise<string> {
  const drizzle: DrizzleDB = "select" in db ? db as DrizzleDB : (db as { db: DrizzleDB }).db;
  const persisted = await loadPersistedSettings(drizzle);
  return persisted.assistant?.timezone ?? "UTC";
}
