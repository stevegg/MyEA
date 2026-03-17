/**
 * myEA — Drizzle ORM Schema
 *
 * All tables are defined here. Run `npm run db:generate` to produce migrations
 * and `npm run db:migrate` to apply them.
 */

import {
  pgTable,
  text,
  varchar,
  boolean,
  integer,
  bigserial,
  jsonb,
  timestamp,
  uuid,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export const platformEnum = pgEnum("platform", [
  "telegram",
  "discord",
  "slack",
  "whatsapp",
  "signal",
  "imessage",
  "web",
  "internal",
]);

export const messageRoleEnum = pgEnum("message_role", [
  "user",
  "assistant",
  "system",
  "tool",
]);

export const memoryEntryTypeEnum = pgEnum("memory_entry_type", [
  "fact",
  "preference",
  "summary",
  "context",
  "note",
]);

export const integrationStatusEnum = pgEnum("integration_status", [
  "connected",
  "disconnected",
  "error",
  "pending_auth",
]);

export const aiProviderEnum = pgEnum("ai_provider", [
  "claude",
  "openai",
  "ollama",
]);

export const logLevelEnum = pgEnum("log_level", [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]);

// ─────────────────────────────────────────────────────────────────────────────
// users — admin authentication
// ─────────────────────────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: varchar("username", { length: 64 }).notNull(),
    /** bcrypt hash of the password. */
    passwordHash: text("password_hash").notNull(),
    /** Whether this user can access the admin UI. */
    isAdmin: boolean("is_admin").notNull().default(true),
    /** Nullable — future support for per-user preferences. */
    displayName: varchar("display_name", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => ({
    usernameIdx: uniqueIndex("users_username_idx").on(t.username),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// conversations — one row per chat session on a platform
// ─────────────────────────────────────────────────────────────────────────────

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platform: platformEnum("platform").notNull(),
    /** The user's ID as reported by the platform (e.g. Telegram user_id). */
    platformUserId: varchar("platform_user_id", { length: 256 }).notNull(),
    platformUserName: varchar("platform_user_name", { length: 256 }),
    /** Channel / chat / thread ID on the platform. */
    platformChannelId: varchar("platform_channel_id", { length: 256 }).notNull(),
    /** Guild / server / workspace ID (Discord, Slack). */
    platformGuildId: varchar("platform_guild_id", { length: 256 }),
    /** Cached count — updated by triggers or app logic. */
    messageCount: integer("message_count").notNull().default(0),
    /** Free-form metadata (e.g. Discord server name). */
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    platformUserIdx: index("conversations_platform_user_idx").on(
      t.platform,
      t.platformUserId
    ),
    platformChannelIdx: index("conversations_platform_channel_idx").on(
      t.platform,
      t.platformChannelId
    ),
    updatedAtIdx: index("conversations_updated_at_idx").on(t.updatedAt),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// messages — individual messages within a conversation
// ─────────────────────────────────────────────────────────────────────────────

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Monotonically increasing sequence for stable chronological ordering. */
    seq: bigserial("seq", { mode: "bigint" }).notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    /** Set when role = "tool". */
    toolName: varchar("tool_name", { length: 128 }),
    toolCallId: varchar("tool_call_id", { length: 128 }),
    /** AI provider used for this message (null for user messages). */
    aiProvider: aiProviderEnum("ai_provider"),
    aiModel: varchar("ai_model", { length: 128 }),
    /** Token usage stats from the AI provider. */
    tokenUsage: jsonb("token_usage").$type<{
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }>(),
    /** Platform-specific message ID (for deduplication). */
    platformMessageId: varchar("platform_message_id", { length: 256 }),
    platform: platformEnum("platform"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    conversationIdx: index("messages_conversation_idx").on(t.conversationId),
    createdAtIdx: index("messages_created_at_idx").on(t.createdAt),
    seqIdx: index("messages_seq_idx").on(t.seq),
    platformMessageIdx: index("messages_platform_message_idx").on(
      t.platform,
      t.platformMessageId
    ),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// memory_entries — persistent assistant memory
// ─────────────────────────────────────────────────────────────────────────────

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: memoryEntryTypeEnum("type").notNull().default("note"),
    /** The content of the memory. */
    content: text("content").notNull(),
    /** Source skill, platform, or system component that created this entry. */
    source: varchar("source", { length: 128 }),
    /** Arbitrary key-value metadata. */
    metadata: jsonb("metadata").notNull().default({}),
    /**
     * tsvector column for full-text search.
     * Auto-populated by a trigger or updated by the app after INSERT/UPDATE.
     * Future: replace with pgvector column for semantic search.
     */
    searchVector: text("search_vector"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Null means the entry never expires. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => ({
    typeIdx: index("memory_entries_type_idx").on(t.type),
    expiresAtIdx: index("memory_entries_expires_at_idx").on(t.expiresAt),
    createdAtIdx: index("memory_entries_created_at_idx").on(t.createdAt),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// skills_registry — tracks loaded skills (built-in and custom)
// ─────────────────────────────────────────────────────────────────────────────

export const skillsRegistry = pgTable(
  "skills_registry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Unique machine-readable name (snake_case). */
    name: varchar("name", { length: 128 }).notNull(),
    description: text("description").notNull().default(""),
    version: varchar("version", { length: 32 }).notNull().default("0.0.0"),
    /** Absolute path to the skill file. Null for built-in skills. */
    filePath: text("file_path"),
    enabled: boolean("enabled").notNull().default(true),
    builtIn: boolean("built_in").notNull().default(false),
    /** JSON array of { name, description } tool summaries. */
    tools: jsonb("tools")
      .notNull()
      .default([])
      .$type<Array<{ name: string; description: string }>>(),
    /** Last error message from load/setup, if any. */
    loadError: text("load_error"),
    loadedAt: timestamp("loaded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    nameIdx: uniqueIndex("skills_registry_name_idx").on(t.name),
    enabledIdx: index("skills_registry_enabled_idx").on(t.enabled),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// integrations — third-party service connections
// ─────────────────────────────────────────────────────────────────────────────

export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Unique integration name (e.g. "github", "spotify"). */
    name: varchar("name", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 128 }).notNull(),
    enabled: boolean("enabled").notNull().default(false),
    status: integrationStatusEnum("status").notNull().default("disconnected"),
    /**
     * Encrypted or plain config blob (tokens, settings).
     * In production, encrypt sensitive fields before writing.
     */
    config: jsonb("config").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    errorMessage: text("error_message"),
  },
  (t) => ({
    nameIdx: uniqueIndex("integrations_name_idx").on(t.name),
    statusIdx: index("integrations_status_idx").on(t.status),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// scheduled_jobs — persistent job definitions (pg-boss managed)
// ─────────────────────────────────────────────────────────────────────────────

export const scheduledJobs = pgTable(
  "scheduled_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Human-readable name / job type key (must match pg-boss job name). */
    name: varchar("name", { length: 128 }).notNull(),
    description: text("description").notNull().default(""),
    /** pg-boss cron expression (recurring) or ISO-8601 datetime (one-shot). */
    schedule: varchar("schedule", { length: 128 }).notNull(),
    recurring: boolean("recurring").notNull().default(false),
    /** Serialisable payload sent to the pg-boss job. */
    payload: jsonb("payload").notNull().default({}),
    /** Target platform for proactive message jobs. */
    targetPlatform: platformEnum("target_platform"),
    targetChannelId: varchar("target_channel_id", { length: 256 }),
    enabled: boolean("enabled").notNull().default(true),
    /** The pg-boss job ID that corresponds to this record. */
    pgBossJobId: varchar("pg_boss_job_id", { length: 256 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (t) => ({
    nameIdx: uniqueIndex("scheduled_jobs_name_idx").on(t.name),
    enabledIdx: index("scheduled_jobs_enabled_idx").on(t.enabled),
    nextRunIdx: index("scheduled_jobs_next_run_idx").on(t.nextRunAt),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// logs — structured application log archive
// ─────────────────────────────────────────────────────────────────────────────

export const logs = pgTable(
  "logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    level: logLevelEnum("level").notNull().default("info"),
    message: text("message").notNull(),
    /** Structured data attached to the log entry (e.g. error stack, request id). */
    data: jsonb("data").default({}),
    /** Component or module that emitted the log. */
    source: varchar("source", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    levelIdx: index("logs_level_idx").on(t.level),
    createdAtIdx: index("logs_created_at_idx").on(t.createdAt),
    sourceIdx: index("logs_source_idx").on(t.source),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────────────────────────────────────

export const conversationsRelations = relations(conversations, ({ many }) => ({
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Type exports (inferred from table definitions)
// ─────────────────────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export type MemoryEntryRow = typeof memoryEntries.$inferSelect;
export type NewMemoryEntry = typeof memoryEntries.$inferInsert;

export type SkillRegistryRow = typeof skillsRegistry.$inferSelect;
export type NewSkillRegistryRow = typeof skillsRegistry.$inferInsert;

export type IntegrationRow = typeof integrations.$inferSelect;
export type NewIntegrationRow = typeof integrations.$inferInsert;

export type ScheduledJobRow = typeof scheduledJobs.$inferSelect;
export type NewScheduledJobRow = typeof scheduledJobs.$inferInsert;

export type LogRow = typeof logs.$inferSelect;
export type NewLogRow = typeof logs.$inferInsert;
