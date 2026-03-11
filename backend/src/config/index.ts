/**
 * myEA — Application Configuration
 *
 * Reads all environment variables, validates required values, and returns a
 * typed AppConfig object. Import this module once at startup and pass the
 * result around via dependency injection — never read process.env directly
 * outside this file.
 */

import * as dotenv from "dotenv";
import type { AppConfig } from "../types";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Required environment variable "${name}" is missing or empty.`);
  }
  return value.trim();
}

function optional(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function optionalBool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return fallback;
  return raw.toLowerCase() === "true" || raw === "1";
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? fallback : parsed;
}

function loadConfig(): AppConfig {
  const nodeEnv = (optional("NODE_ENV", "development") as AppConfig["nodeEnv"]) ?? "development";

  return {
    nodeEnv,
    port: optionalInt("BACKEND_PORT", 3001),
    frontendUrl: optional("FRONTEND_URL", "http://localhost:3000"),

    database: {
      url: required("DATABASE_URL"),
    },

    auth: {
      jwtSecret: required("JWT_SECRET"),
      jwtExpiresIn: optional("JWT_EXPIRES_IN", "7d"),
      adminUsername: optional("ADMIN_USERNAME", "admin"),
      adminPasswordHash: optional("ADMIN_PASSWORD_HASH", ""),
      adminPassword: optional("ADMIN_PASSWORD", ""),
    },

    ai: {
      activeProvider: (optional("ACTIVE_AI_PROVIDER", "claude") as AppConfig["ai"]["activeProvider"]),
      model: optional("AI_MODEL", "claude-opus-4-5"),
      anthropicApiKey: optional("ANTHROPIC_API_KEY") || undefined,
      openaiApiKey: optional("OPENAI_API_KEY") || undefined,
      ollamaBaseUrl: optional("OLLAMA_BASE_URL", "http://ollama:11434"),
    },

    platforms: {
      telegram: {
        enabled: optionalBool("TELEGRAM_ENABLED"),
        botToken: optional("TELEGRAM_BOT_TOKEN") || undefined,
      },
      discord: {
        enabled: optionalBool("DISCORD_ENABLED"),
        botToken: optional("DISCORD_BOT_TOKEN") || undefined,
        clientId: optional("DISCORD_CLIENT_ID") || undefined,
      },
      slack: {
        enabled: optionalBool("SLACK_ENABLED"),
        botToken: optional("SLACK_BOT_TOKEN") || undefined,
        appToken: optional("SLACK_APP_TOKEN") || undefined,
        signingSecret: optional("SLACK_SIGNING_SECRET") || undefined,
      },
      whatsapp: {
        enabled: optionalBool("WHATSAPP_ENABLED"),
      },
      signal: {
        enabled: optionalBool("SIGNAL_ENABLED"),
        phoneNumber: optional("SIGNAL_PHONE_NUMBER") || undefined,
        cliUrl: optional("SIGNAL_CLI_URL", "http://signal-cli:8080"),
      },
    },

    integrations: {
      gmail: {
        enabled: optionalBool("GMAIL_ENABLED"),
        clientId: optional("GMAIL_CLIENT_ID") || undefined,
        clientSecret: optional("GMAIL_CLIENT_SECRET") || undefined,
        redirectUri: optional("GMAIL_REDIRECT_URI") || undefined,
        refreshToken: optional("GMAIL_REFRESH_TOKEN") || undefined,
      },
      github: {
        enabled: optionalBool("GITHUB_ENABLED"),
        token: optional("GITHUB_TOKEN") || undefined,
      },
      spotify: {
        enabled: optionalBool("SPOTIFY_ENABLED"),
        clientId: optional("SPOTIFY_CLIENT_ID") || undefined,
        clientSecret: optional("SPOTIFY_CLIENT_SECRET") || undefined,
        redirectUri: optional("SPOTIFY_REDIRECT_URI") || undefined,
        refreshToken: optional("SPOTIFY_REFRESH_TOKEN") || undefined,
      },
      smartHome: {
        enabled: optionalBool("SMART_HOME_ENABLED"),
        homeAssistantUrl: optional("HOME_ASSISTANT_URL") || undefined,
        homeAssistantToken: optional("HOME_ASSISTANT_TOKEN") || undefined,
      },
    },

    volumes: {
      skillsDir: optional("SKILLS_DIR", "/app/volumes/skills"),
      filesDir: optional("FILES_DIR", "/app/volumes/files"),
      logsDir: optional("LOGS_DIR", "/app/volumes/logs"),
    },
  };
}

/**
 * Validates that the active AI provider has its required credentials.
 * Logs a warning (does not throw) so the app can still start for initial setup.
 */
function warnIfProviderMisconfigured(config: AppConfig): void {
  const { activeProvider, anthropicApiKey, openaiApiKey } = config.ai;

  if (activeProvider === "claude" && !anthropicApiKey) {
    console.warn(
      "[config] ACTIVE_AI_PROVIDER=claude but ANTHROPIC_API_KEY is not set. AI calls will fail."
    );
  }
  if (activeProvider === "openai" && !openaiApiKey) {
    console.warn(
      "[config] ACTIVE_AI_PROVIDER=openai but OPENAI_API_KEY is not set. AI calls will fail."
    );
  }
}

// Load and export the singleton config at module initialisation time.
// Any missing required variables will throw here, crashing the process early.
export const config: AppConfig = loadConfig();

warnIfProviderMisconfigured(config);

export default config;
