/**
 * myEA — Integrations API Routes
 *
 *   GET    /api/integrations                    — list all configured integrations
 *   POST   /api/integrations                    — add / configure an integration
 *   PUT    /api/integrations/:id                — update integration config
 *   DELETE /api/integrations/:id                — remove an integration
 *   GET    /api/integrations/:id/test           — test the integration connection
 *   POST   /api/integrations/gmail/oauth/start  — begin Gmail OAuth2 flow
 *   GET    /api/integrations/gmail/oauth/callback — handle OAuth2 redirect
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { eq, desc } from "drizzle-orm";
import type { DrizzleDB } from "../db";
import type { AppConfig, IntegrationStatus } from "../types";
import { integrations } from "../db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────────────

interface IntegrationsPluginOptions {
  db: DrizzleDB;
  config: AppConfig;
}

const integrationsPlugin: FastifyPluginAsync<IntegrationsPluginOptions> = async (
  app: FastifyInstance,
  opts: IntegrationsPluginOptions
) => {
  const { db, config } = opts;

  // ── GET /api/integrations ──────────────────────────────────

  app.get(
    "/api/integrations",
    { preHandler: [app.authenticate] },
    async (_request, reply) => {
      const rows = await db
        .select()
        .from(integrations)
        .orderBy(integrations.name);

      return reply.send({
        data: rows.map(formatIntegration),
        total: rows.length,
      });
    }
  );

  // ── POST /api/integrations ─────────────────────────────────

  app.post<{
    Body: {
      name: string;
      displayName: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
    };
  }>(
    "/api/integrations",
    {
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: "object",
          required: ["name", "displayName"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 64 },
            displayName: { type: "string", minLength: 1, maxLength: 128 },
            config: { type: "object" },
            enabled: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, displayName, config: integrationConfig = {}, enabled = false } = request.body;

      // Upsert by name
      const [row] = await db
        .insert(integrations)
        .values({
          name,
          displayName,
          config: integrationConfig,
          enabled,
          status: "disconnected",
        })
        .onConflictDoUpdate({
          target: integrations.name,
          set: {
            displayName,
            config: integrationConfig,
            enabled,
            updatedAt: new Date(),
          },
        })
        .returning();

      request.log.info({ name, integrationId: row.id }, "Integration created/updated");
      return reply.status(201).send(formatIntegration(row));
    }
  );

  // ── PUT /api/integrations/:id ──────────────────────────────

  app.put<{
    Params: { id: string };
    Body: {
      displayName?: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
    };
  }>(
    "/api/integrations/:id",
    {
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: "object",
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 128 },
            config: { type: "object" },
            enabled: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const [existing] = await db
        .select()
        .from(integrations)
        .where(eq(integrations.id, id))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({ error: "Integration not found" });
      }

      const updateValues: Partial<typeof integrations.$inferInsert> = { updatedAt: new Date() };
      if (request.body.displayName !== undefined) updateValues.displayName = request.body.displayName;
      if (request.body.config !== undefined) updateValues.config = request.body.config;
      if (request.body.enabled !== undefined) updateValues.enabled = request.body.enabled;

      const [updated] = await db
        .update(integrations)
        .set(updateValues)
        .where(eq(integrations.id, id))
        .returning();

      return reply.send(formatIntegration(updated));
    }
  );

  // ── DELETE /api/integrations/:id ───────────────────────────

  app.delete<{ Params: { id: string } }>(
    "/api/integrations/:id",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params;

      const [existing] = await db
        .select({ id: integrations.id })
        .from(integrations)
        .where(eq(integrations.id, id))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({ error: "Integration not found" });
      }

      await db.delete(integrations).where(eq(integrations.id, id));
      request.log.info({ integrationId: id }, "Integration deleted");
      return reply.status(204).send();
    }
  );

  // ── GET /api/integrations/gmail/oauth/start ────────────────
  // Must be registered before /:id to avoid param collision

  app.post(
    "/api/integrations/gmail/oauth/start",
    { preHandler: [app.authenticate] },
    async (_request, reply) => {
      const { clientId, redirectUri } = config.integrations.gmail;

      if (!clientId || !redirectUri) {
        return reply.status(400).send({
          error: "Gmail OAuth2 is not configured. Set GMAIL_CLIENT_ID and GMAIL_REDIRECT_URI.",
        });
      }

      const { google } = await import("googleapis");
      const oauth2Client = new google.auth.OAuth2(
        clientId,
        config.integrations.gmail.clientSecret,
        redirectUri
      );

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/gmail.modify",
        ],
      });

      return reply.send({ authUrl });
    }
  );

  // ── GET /api/integrations/gmail/oauth/callback ─────────────

  // Helper: HTML-encode a string before inserting into an HTML response to
  // prevent reflected XSS from attacker-controlled query parameters.
  function htmlEncode(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  }

  app.get<{ Querystring: { code?: string; error?: string; state?: string } }>(
    "/api/integrations/gmail/oauth/callback",
    async (request, reply) => {
      const { code, error } = request.query;

      if (error) {
        // Encode the error string before embedding in HTML — prevents reflected XSS
        const safeError = htmlEncode(String(error).slice(0, 200));
        return reply
          .type("text/html")
          .send(`<html><body><h2>Gmail OAuth Error</h2><p>${safeError}</p></body></html>`);
      }

      if (!code) {
        return reply.status(400).send({ error: "Missing authorization code" });
      }

      const { clientId, clientSecret, redirectUri } = config.integrations.gmail;

      if (!clientId || !clientSecret || !redirectUri) {
        return reply.status(500).send({ error: "Gmail OAuth2 not configured on the server" });
      }

      try {
        const { google } = await import("googleapis");
        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

        const { tokens } = await oauth2Client.getToken(code);

        // Upsert the Gmail integration with refresh token
        await db
          .insert(integrations)
          .values({
            name: "gmail",
            displayName: "Gmail",
            enabled: true,
            status: "connected",
            config: {
              refreshToken: tokens.refresh_token,
              accessToken: tokens.access_token,
              expiryDate: tokens.expiry_date,
              tokenType: tokens.token_type,
            },
          })
          .onConflictDoUpdate({
            target: integrations.name,
            set: {
              enabled: true,
              status: "connected",
              config: {
                refreshToken: tokens.refresh_token,
                accessToken: tokens.access_token,
                expiryDate: tokens.expiry_date,
                tokenType: tokens.token_type,
              },
              updatedAt: new Date(),
              errorMessage: null,
            },
          });

        request.log.info("Gmail OAuth2 callback completed successfully");

        return reply
          .type("text/html")
          .send(
            `<html><body><h2>Gmail Connected</h2><p>You can close this tab and return to myEA.</p><script>window.close();</script></body></html>`
          );
      } catch (err) {
        // Log the full error server-side but only show a generic message in the HTML
        // response to avoid leaking internal error details to the browser.
        request.log.error({ err }, "Gmail OAuth2 token exchange failed");
        return reply
          .type("text/html")
          .send(`<html><body><h2>OAuth Error</h2><p>Token exchange failed. Please try again.</p></body></html>`);
      }
    }
  );

  // ── GET /auth/gmail/callback ───────────────────────────────
  // Legacy alias matching GMAIL_REDIRECT_URI=http://localhost:3001/auth/gmail/callback

  app.get<{ Querystring: { code?: string; error?: string; state?: string } }>(
    "/auth/gmail/callback",
    async (request, reply) => {
      const { code, error } = request.query;

      if (error) {
        const safeError = htmlEncode(String(error).slice(0, 200));
        return reply
          .type("text/html")
          .send(`<html><body><h2>Gmail OAuth Error</h2><p>${safeError}</p></body></html>`);
      }

      if (!code) {
        return reply.status(400).send({ error: "Missing authorization code" });
      }

      const { clientId, clientSecret, redirectUri } = config.integrations.gmail;

      if (!clientId || !clientSecret || !redirectUri) {
        return reply.status(500).send({ error: "Gmail OAuth2 not configured on the server" });
      }

      try {
        const { google } = await import("googleapis");
        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        const { tokens } = await oauth2Client.getToken(code);

        await db
          .insert(integrations)
          .values({
            name: "gmail",
            displayName: "Gmail",
            enabled: true,
            status: "connected",
            config: {
              refreshToken: tokens.refresh_token,
              accessToken: tokens.access_token,
              expiryDate: tokens.expiry_date,
              tokenType: tokens.token_type,
            },
          })
          .onConflictDoUpdate({
            target: integrations.name,
            set: {
              enabled: true,
              status: "connected",
              config: {
                refreshToken: tokens.refresh_token,
                accessToken: tokens.access_token,
                expiryDate: tokens.expiry_date,
                tokenType: tokens.token_type,
              },
              updatedAt: new Date(),
              errorMessage: null,
            },
          });

        request.log.info("Gmail OAuth2 callback completed successfully (legacy path)");

        return reply
          .type("text/html")
          .send(
            `<html><body><h2>Gmail Connected</h2><p>You can close this tab and return to myEA.</p><script>window.close();</script></body></html>`
          );
      } catch (err) {
        request.log.error({ err }, "Gmail OAuth2 token exchange failed (legacy path)");
        return reply
          .type("text/html")
          .send(`<html><body><h2>OAuth Error</h2><p>Token exchange failed. Please try again.</p></body></html>`);
      }
    }
  );

  // ── GET /api/integrations/:id/test ────────────────────────

  app.get<{ Params: { id: string } }>(
    "/api/integrations/:id/test",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params;

      const [row] = await db
        .select()
        .from(integrations)
        .where(eq(integrations.id, id))
        .limit(1);

      if (!row) {
        return reply.status(404).send({ error: "Integration not found" });
      }

      let status: IntegrationStatus = "disconnected";
      let detail = "";

      try {
        switch (row.name) {
          case "gmail":
            status = await testGmail(row.config as Record<string, unknown>, config);
            break;

          case "github":
            status = await testGithub(row.config as Record<string, unknown>, config);
            break;

          case "spotify":
            status = await testSpotify(row.config as Record<string, unknown>, config);
            break;

          case "smart_home":
            status = await testSmartHome(row.config as Record<string, unknown>, config);
            break;

          default:
            detail = "No test handler for this integration type";
            status = "disconnected";
        }
      } catch (err) {
        status = "error";
        detail = err instanceof Error ? err.message : String(err);
        request.log.warn({ err, integrationId: id }, "Integration test failed");
      }

      // Update status in DB
      await db
        .update(integrations)
        .set({
          status,
          lastCheckedAt: new Date(),
          errorMessage: status === "error" ? detail : null,
          updatedAt: new Date(),
        })
        .where(eq(integrations.id, id));

      return reply.send({ status, detail: detail || undefined });
    }
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

async function testGmail(
  storedConfig: Record<string, unknown>,
  appConfig: AppConfig
): Promise<IntegrationStatus> {
  const refreshToken =
    (storedConfig["refreshToken"] as string) || appConfig.integrations.gmail.refreshToken;

  if (!refreshToken || !appConfig.integrations.gmail.clientId) {
    return "disconnected";
  }

  const { google } = await import("googleapis");
  const auth = new google.auth.OAuth2(
    appConfig.integrations.gmail.clientId,
    appConfig.integrations.gmail.clientSecret,
    appConfig.integrations.gmail.redirectUri
  );
  auth.setCredentials({ refresh_token: refreshToken });

  const gmail = google.gmail({ version: "v1", auth });
  await gmail.users.getProfile({ userId: "me" });
  return "connected";
}

async function testGithub(
  storedConfig: Record<string, unknown>,
  appConfig: AppConfig
): Promise<IntegrationStatus> {
  const token = (storedConfig["token"] as string) || appConfig.integrations.github.token;
  if (!token) return "disconnected";

  const { default: axios } = await import("axios");
  await axios.get("https://api.github.com/user", {
    headers: { Authorization: `token ${token}` },
  });
  return "connected";
}

async function testSpotify(
  storedConfig: Record<string, unknown>,
  appConfig: AppConfig
): Promise<IntegrationStatus> {
  const refreshToken =
    (storedConfig["refreshToken"] as string) || appConfig.integrations.spotify.refreshToken;
  if (!refreshToken || !appConfig.integrations.spotify.clientId) return "disconnected";

  const { default: axios } = await import("axios");

  // Get a fresh access token
  const creds = Buffer.from(
    `${appConfig.integrations.spotify.clientId}:${appConfig.integrations.spotify.clientSecret}`
  ).toString("base64");

  const tokenRes = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    { headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const accessToken = tokenRes.data.access_token as string;
  await axios.get("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  return "connected";
}

async function testSmartHome(
  storedConfig: Record<string, unknown>,
  appConfig: AppConfig
): Promise<IntegrationStatus> {
  const url =
    (storedConfig["homeAssistantUrl"] as string) || appConfig.integrations.smartHome.homeAssistantUrl;
  const token =
    (storedConfig["homeAssistantToken"] as string) || appConfig.integrations.smartHome.homeAssistantToken;

  if (!url || !token) return "disconnected";

  const { default: axios } = await import("axios");
  await axios.get(`${url}/api/`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 5000,
  });

  return "connected";
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatIntegration(row: typeof integrations.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    enabled: row.enabled,
    status: row.status,
    // Redact sensitive config fields before sending to the client
    config: redactConfig(row.config as Record<string, unknown>),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    errorMessage: row.errorMessage,
  };
}

const SENSITIVE_FIELDS = new Set([
  "token",
  "accessToken",
  "refreshToken",
  "clientSecret",
  "apiKey",
  "password",
  "secret",
]);

function redactConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  if (!cfg || typeof cfg !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(cfg)) {
    out[key] = SENSITIVE_FIELDS.has(key) && typeof val === "string" && val.length > 0
      ? "***"
      : val;
  }
  return out;
}

export default fp(integrationsPlugin, {
  name: "integrations-routes",
  dependencies: ["auth"],
});
