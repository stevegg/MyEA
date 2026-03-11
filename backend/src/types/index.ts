/**
 * myEA — Shared TypeScript Interfaces
 *
 * This file defines the contracts that every skill, AI provider, messaging
 * connector, memory service, and integration must implement. All other modules
 * import from here so the type system is the single source of truth.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Primitives / JSON Schema
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal JSON Schema subset sufficient for tool parameter definitions. */
export interface JSONSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | JSONSchema;
  oneOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  allOf?: JSONSchema[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform / Messaging
// ─────────────────────────────────────────────────────────────────────────────

/** All messaging platforms the assistant can operate on. */
export type Platform =
  | "telegram"
  | "discord"
  | "slack"
  | "whatsapp"
  | "signal"
  | "internal"; // used for proactive/scheduled messages

/** A normalised inbound message from any platform. */
export interface PlatformMessage {
  /** Unique ID within the platform (e.g. Telegram message_id). */
  id: string;
  platform: Platform;
  /** The user's platform-specific identifier. */
  userId: string;
  /** Human-readable display name, if available. */
  userName?: string;
  /** Platform channel / chat / thread ID. */
  channelId: string;
  /** Guild / server / workspace ID, where applicable. */
  guildId?: string;
  text: string;
  /** ISO-8601 timestamp from the platform. */
  timestamp: string;
  /** Any file attachments included with the message. */
  attachments?: PlatformAttachment[];
  /** Raw platform-specific payload for advanced use. */
  raw?: unknown;
}

export interface PlatformAttachment {
  id: string;
  type: "image" | "audio" | "video" | "document" | "other";
  url?: string;
  mimeType?: string;
  fileName?: string;
  /** Size in bytes. */
  size?: number;
}

/** A normalised outbound message sent by the assistant. */
export interface OutboundMessage {
  platform: Platform;
  channelId: string;
  userId?: string;
  text: string;
  /** Whether the message is proactively initiated (not a reply). */
  proactive?: boolean;
  /** Reply to a specific message ID on the platform. */
  replyToId?: string;
  /** Optional rich embeds (Discord, Slack blocks, etc.) */
  embeds?: MessageEmbed[];
  /** Inline keyboard / action buttons. */
  actions?: MessageAction[];
}

export interface MessageEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: string;
  thumbnail?: string;
  image?: string;
  timestamp?: string;
}

export interface MessageAction {
  id: string;
  label: string;
  /** Callback data or URL. */
  value: string;
  style?: "primary" | "secondary" | "danger" | "link";
}

/**
 * Every messaging platform adapter implements this interface.
 * The SkillRuntime calls `send()` and listens to the `onMessage` handler.
 */
export interface PlatformConnector {
  readonly platform: Platform;
  readonly enabled: boolean;

  /** Start the connector (connect to platform API / webhook). */
  start(): Promise<void>;

  /** Gracefully shut down the connector. */
  stop(): Promise<void>;

  /** Send a message through this platform. */
  send(message: OutboundMessage): Promise<void>;

  /** Register a handler that fires for every inbound message. */
  onMessage(handler: (message: PlatformMessage) => Promise<void>): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Provider
// ─────────────────────────────────────────────────────────────────────────────

export type AIProviderName = "claude" | "openai" | "ollama";

export interface AIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present when role is "tool". */
  toolCallId?: string;
  toolName?: string;
}

export interface AITool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export interface AIToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AIResponse {
  content: string;
  toolCalls?: AIToolCall[];
  /** Provider-specific usage stats. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
  provider: AIProviderName;
  /** ISO-8601 timestamp. */
  finishedAt: string;
}

export interface AIGenerateOptions {
  messages: AIMessage[];
  tools?: AITool[];
  /** Override the default model for this call. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

/**
 * Every AI provider (Claude, OpenAI, Ollama) implements this interface.
 * The assistant core hot-switches between them without changing call sites.
 */
export interface AIProvider {
  readonly name: AIProviderName;
  readonly model: string;

  /** Generate a completion (supports tool use). */
  generate(options: AIGenerateOptions): Promise<AIResponse>;

  /** Return true if the provider can be reached. */
  healthCheck(): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skills System
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolResult {
  /** The string content returned to the AI after tool execution. */
  content: string;
  /** Structured data for the admin UI or downstream tools. */
  data?: unknown;
  /** Set to true when the tool encountered a non-fatal issue. */
  isError?: boolean;
}

/** Dependencies injected into a skill at setup time. */
export interface SkillContext {
  config: AppConfig;
  db: DatabaseService;
  memory: MemoryService;
  scheduler: SchedulerService;
  logger: Logger;
  /** Send a proactive message to the user on any platform. */
  sendMessage(message: OutboundMessage): Promise<void>;
}

/** Runtime context provided to every tool call. */
export interface ExecutionContext {
  /** The inbound message that triggered the tool call (may be undefined for proactive calls). */
  triggerMessage?: PlatformMessage;
  /** Active conversation ID. */
  conversationId: string;
  /** The AI's current response turn (for multi-step tool loops). */
  turnIndex: number;
  /** Shared per-turn state the AI and tools can read/write. */
  turnState: Record<string, unknown>;
  config: AppConfig;
  db: DatabaseService;
  memory: MemoryService;
  scheduler: SchedulerService;
  logger: Logger;
}

/**
 * The contract every skill (built-in or custom) must implement.
 * Custom skills are loaded from ./volumes/skills/ at runtime via chokidar.
 */
export interface Skill {
  /** Unique machine-readable name (snake_case, e.g. "web_search"). */
  name: string;
  /** Human-readable description shown in the admin UI. */
  description: string;
  /** Semver string. */
  version: string;
  /** One or more callable tools exposed to the AI. */
  tools: ToolDefinition[];
  /**
   * Called once when the skill is loaded (or reloaded).
   * Use for one-time setup: DB migrations, external connections, etc.
   */
  setup?(context: SkillContext): Promise<void>;
  /**
   * Called before the skill is unloaded (hot-reload or shutdown).
   * Clean up timers, connections, and subscriptions here.
   */
  teardown?(): Promise<void>;
}

/** A single callable function exposed to the AI by a skill. */
export interface ToolDefinition {
  /** Must be unique across all loaded skills. Prefix with skill name: "web_search__browse". */
  name: string;
  description: string;
  /** JSON Schema describing the parameters object the AI must pass. */
  parameters: JSONSchema;
  execute(params: unknown, context: ExecutionContext): Promise<ToolResult>;
}

/** Registry entry for a loaded skill (persisted to DB and tracked in memory). */
export interface SkillRegistryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  /** Absolute path to the skill file on disk. */
  filePath: string;
  enabled: boolean;
  builtIn: boolean;
  /** ISO-8601 load time. */
  loadedAt: string;
  /** Last error during load/setup, if any. */
  loadError?: string;
  tools: Array<{ name: string; description: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory Service
// ─────────────────────────────────────────────────────────────────────────────

export type MemoryEntryType =
  | "fact"       // persistent fact about the user or world
  | "preference" // user preference
  | "summary"    // conversation summary
  | "context"    // short-term working context
  | "note";      // arbitrary note stored by a skill

export interface MemoryEntry {
  id: string;
  type: MemoryEntryType;
  /** The content being remembered. */
  content: string;
  /** Arbitrary key-value metadata (source platform, skill, etc.) */
  metadata: Record<string, unknown>;
  /** Optional relevance score from a semantic search (0–1). */
  score?: number;
  createdAt: string;
  updatedAt: string;
  /** ISO-8601 expiry; null means permanent. */
  expiresAt?: string;
}

export interface MemorySearchOptions {
  query: string;
  type?: MemoryEntryType;
  limit?: number;
  minScore?: number;
}

export interface MemoryService {
  /** Persist a new memory entry. */
  store(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry>;

  /** Retrieve memory entries relevant to a query (keyword or semantic). */
  search(options: MemorySearchOptions): Promise<MemoryEntry[]>;

  /** Retrieve a single entry by its ID. */
  get(id: string): Promise<MemoryEntry | null>;

  /** Update an existing entry. */
  update(id: string, patch: Partial<Pick<MemoryEntry, "content" | "metadata" | "expiresAt">>): Promise<MemoryEntry>;

  /** Permanently delete an entry. */
  delete(id: string): Promise<void>;

  /** Purge all expired entries. */
  pruneExpired(): Promise<number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler / pg-boss
// ─────────────────────────────────────────────────────────────────────────────

export interface ScheduledJob {
  id: string;
  name: string;
  /** Human-readable description of what the job does. */
  description: string;
  /** pg-boss cron expression or ISO-8601 date string for one-shot jobs. */
  schedule: string;
  /** Whether this is a one-shot (false) or recurring (true) job. */
  recurring: boolean;
  /** Serialisable payload passed to the job handler. */
  payload: Record<string, unknown>;
  /** Target platform + channel for proactive messaging jobs. */
  targetPlatform?: Platform;
  targetChannelId?: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastError?: string;
}

export type JobHandler = (job: { id: string; name: string; data: Record<string, unknown> }) => Promise<void>;

export interface SchedulerService {
  /** Register a handler for a named job type. */
  register(jobName: string, handler: JobHandler): Promise<void>;

  /** Schedule a recurring job (cron syntax). */
  scheduleCron(name: string, cron: string, payload?: Record<string, unknown>): Promise<string>;

  /** Schedule a one-shot job at a specific time. */
  scheduleOnce(name: string, runAt: Date, payload?: Record<string, unknown>): Promise<string>;

  /** Cancel a job by its pg-boss ID. */
  cancel(jobId: string): Promise<void>;

  /** List all scheduled jobs visible to pg-boss. */
  list(): Promise<ScheduledJob[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Integrations
// ─────────────────────────────────────────────────────────────────────────────

export type IntegrationName =
  | "github"
  | "spotify"
  | "smart_home"
  | "gmail"
  | string; // custom integrations added by skills

export type IntegrationStatus = "connected" | "disconnected" | "error" | "pending_auth";

export interface IntegrationConfig {
  [key: string]: unknown;
}

export interface Integration {
  /** Integration identifier (matches IntegrationName). */
  readonly name: IntegrationName;
  /** Human-readable display name. */
  readonly displayName: string;
  readonly description: string;
  /** Whether this integration requires OAuth and currently has valid tokens. */
  readonly authRequired: boolean;

  /** Returns the current connection status. */
  getStatus(): Promise<IntegrationStatus>;

  /** Connect / re-authenticate the integration. */
  connect(config?: IntegrationConfig): Promise<void>;

  /** Disconnect and revoke tokens. */
  disconnect(): Promise<void>;

  /**
   * Validate that stored credentials are still valid.
   * Returns true if the integration is usable right now.
   */
  validate(): Promise<boolean>;
}

export interface IntegrationRecord {
  id: string;
  name: IntegrationName;
  displayName: string;
  enabled: boolean;
  status: IntegrationStatus;
  /** Encrypted / opaque config blob stored in DB. */
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  errorMessage?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Database Service (thin abstraction over Drizzle)
// ─────────────────────────────────────────────────────────────────────────────

export interface DatabaseService {
  /** The underlying Drizzle database instance. Cast as needed. */
  db: unknown;
  /** Test the database connection. */
  ping(): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// App Config
// ─────────────────────────────────────────────────────────────────────────────

export interface AppConfig {
  nodeEnv: "development" | "production" | "test";
  port: number;
  frontendUrl: string;

  database: {
    url: string;
  };

  auth: {
    jwtSecret: string;
    jwtExpiresIn: string;
    adminUsername: string;
    adminPasswordHash: string;
  };

  ai: {
    activeProvider: AIProviderName;
    model: string;
    anthropicApiKey?: string;
    openaiApiKey?: string;
    ollamaBaseUrl: string;
  };

  platforms: {
    telegram: { enabled: boolean; botToken?: string };
    discord: { enabled: boolean; botToken?: string; clientId?: string };
    slack: { enabled: boolean; botToken?: string; appToken?: string; signingSecret?: string };
    whatsapp: { enabled: boolean };
    signal: { enabled: boolean; phoneNumber?: string; cliUrl: string };
  };

  integrations: {
    gmail: {
      enabled: boolean;
      clientId?: string;
      clientSecret?: string;
      redirectUri?: string;
      refreshToken?: string;
    };
    github: { enabled: boolean; token?: string };
    spotify: {
      enabled: boolean;
      clientId?: string;
      clientSecret?: string;
      redirectUri?: string;
      refreshToken?: string;
    };
    smartHome: { enabled: boolean; homeAssistantUrl?: string; homeAssistantToken?: string };
  };

  volumes: {
    skillsDir: string;
    filesDir: string;
    logsDir: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

export interface Logger {
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  fatal(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

// ─────────────────────────────────────────────────────────────────────────────
// API / WebSocket DTOs
// ─────────────────────────────────────────────────────────────────────────────

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  expiresIn: string;
}

export interface ConversationSummary {
  id: string;
  platform: Platform;
  platformUserId: string;
  platformChannelId: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  platform?: Platform;
  toolName?: string;
  toolCallId?: string;
  createdAt: string;
}

export interface LogEntry {
  id: string;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  message: string;
  data?: Record<string, unknown>;
  source?: string;
  createdAt: string;
}

/** Sent over WebSocket to the admin UI for real-time updates. */
export type WSEvent =
  | { type: "connected"; payload: { timestamp: string } }
  | { type: "message_received"; payload: PlatformMessage }
  | { type: "message_sent"; payload: OutboundMessage }
  | { type: "skill_loaded"; payload: SkillRegistryEntry }
  | { type: "skill_unloaded"; payload: { name: string } }
  | { type: "skill_error"; payload: { name: string; error: string } }
  | { type: "ai_provider_changed"; payload: { provider: AIProviderName; model: string } }
  | { type: "integration_status"; payload: { name: IntegrationName; status: IntegrationStatus } }
  | { type: "log"; payload: LogEntry };
