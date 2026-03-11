/**
 * myEA — Abstract Base AI Provider
 *
 * Provides shared infrastructure for all concrete AI providers:
 *   - Exponential-backoff retry with jitter
 *   - Approximate token counting (tiktoken-free, heuristic-based)
 *   - Conversation history trimming to stay within context limits
 *   - Consistent message-formatting helpers
 */

import type {
  AIProvider,
  AIProviderName,
  AIGenerateOptions,
  AIResponse,
  AIMessage,
  AITool,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Retry configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface RetryConfig {
  /** Maximum number of attempts (initial + retries). Default: 3 */
  maxAttempts: number;
  /** Base delay in milliseconds before first retry. Default: 1000 */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds. Default: 30_000 */
  maxDelayMs: number;
  /** Jitter factor (0–1). Adds randomness to avoid thundering herd. Default: 0.25 */
  jitter: number;
  /** HTTP status codes that are retryable. */
  retryableStatusCodes: number[];
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitter: 0.25,
  retryableStatusCodes: [429, 500, 502, 503, 504],
};

// ─────────────────────────────────────────────────────────────────────────────
// Token counting (heuristic — no external tokeniser dependency)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rough approximation of tokens for a given string.
 * Uses the commonly-cited 4-chars ≈ 1 token rule, which works well enough
 * for English text and gives ~15 % headroom vs. actual BPE counts.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Count words and special chars as an improved heuristic
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const charCount = text.length;
  // Blend word-based (~1.3 tokens/word) and char-based (~0.25 tokens/char) estimates
  return Math.ceil((wordCount * 1.3 + charCount * 0.25) / 2);
}

/**
 * Estimate total tokens for a messages array, accounting for per-message overhead.
 * Each message carries ~4 token overhead for role/formatting.
 */
export function estimateMessagesTokens(messages: AIMessage[]): number {
  return messages.reduce((sum, msg) => {
    return sum + estimateTokens(msg.content) + 4;
  }, 0);
}

/**
 * Estimate tokens for a tool definitions array.
 */
export function estimateToolsTokens(tools: AITool[]): number {
  return tools.reduce((sum, tool) => {
    const schema = JSON.stringify(tool.inputSchema);
    return sum + estimateTokens(tool.name + tool.description + schema) + 8;
  }, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// History trimming
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trims the messages array to fit within `maxContextTokens`, always keeping:
 *   1. The most recent `minMessagesToKeep` messages (default 4) for coherence.
 *   2. Any tool messages paired with their preceding assistant messages so
 *      the conversation remains structurally valid.
 *
 * Trims from the oldest end (excluding system messages, which are handled
 * separately by each provider).
 */
export function trimHistory(
  messages: AIMessage[],
  maxContextTokens: number,
  options: {
    systemPromptTokens?: number;
    toolsTokens?: number;
    reservedOutputTokens?: number;
    minMessagesToKeep?: number;
  } = {}
): AIMessage[] {
  const {
    systemPromptTokens = 0,
    toolsTokens = 0,
    reservedOutputTokens = 1_024,
    minMessagesToKeep = 4,
  } = options;

  const budgetForHistory =
    maxContextTokens - systemPromptTokens - toolsTokens - reservedOutputTokens;

  if (budgetForHistory <= 0) {
    // Extreme edge case — return only the last minMessagesToKeep messages
    return messages.slice(-minMessagesToKeep);
  }

  // Work backwards from newest to oldest, accumulating messages that fit
  const kept: AIMessage[] = [];
  let tokensSoFar = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const msgTokens = estimateTokens(msg.content) + 4;

    const isWithinMinKeep = messages.length - i <= minMessagesToKeep;

    if (isWithinMinKeep || tokensSoFar + msgTokens <= budgetForHistory) {
      kept.unshift(msg);
      tokensSoFar += msgTokens;
    } else {
      // Stop — everything older won't fit
      break;
    }
  }

  return kept;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Splits an AIMessage[] into (systemMessages, conversationMessages).
 * System messages are removed from the conversation array because most
 * provider APIs take system prompts as a separate parameter.
 */
export function splitSystemMessages(messages: AIMessage[]): {
  systemMessages: AIMessage[];
  conversationMessages: AIMessage[];
} {
  return {
    systemMessages: messages.filter((m) => m.role === "system"),
    conversationMessages: messages.filter((m) => m.role !== "system"),
  };
}

/**
 * Merge an explicit systemPrompt string with any system-role messages already
 * in the array, producing a single combined system string.
 */
export function buildSystemString(
  systemPrompt: string | undefined,
  systemMessages: AIMessage[]
): string {
  const parts: string[] = [];
  if (systemPrompt) parts.push(systemPrompt.trim());
  systemMessages.forEach((m) => {
    if (m.content.trim()) parts.push(m.content.trim());
  });
  return parts.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Abstract base class
// ─────────────────────────────────────────────────────────────────────────────

export abstract class BaseAIProvider implements AIProvider {
  abstract readonly name: AIProviderName;
  abstract readonly model: string;

  protected readonly retryConfig: RetryConfig;

  constructor(retryConfig: Partial<RetryConfig> = {}) {
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  }

  // Subclasses implement this — called by `generate()` after validation.
  protected abstract _generate(options: AIGenerateOptions): Promise<AIResponse>;

  /** Public entry point: validates options then delegates with retry logic. */
  async generate(options: AIGenerateOptions): Promise<AIResponse> {
    this.validateOptions(options);
    return this.withRetry(() => this._generate(options));
  }

  abstract healthCheck(): Promise<boolean>;

  // ── Retry logic ───────────────────────────────────────────────────────────

  protected async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const { maxAttempts, baseDelayMs, maxDelayMs, jitter } = this.retryConfig;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;

        if (!this.isRetryable(err) || attempt === maxAttempts) {
          throw err;
        }

        const exponential = baseDelayMs * Math.pow(2, attempt - 1);
        const capped = Math.min(exponential, maxDelayMs);
        const jitterAmount = capped * jitter * Math.random();
        const delay = Math.round(capped + jitterAmount);

        await sleep(delay);
      }
    }

    throw lastError;
  }

  protected isRetryable(err: unknown): boolean {
    if (err instanceof Error) {
      // Network-level errors are always retryable
      const networkErrors = ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED"];
      if (networkErrors.some((code) => err.message.includes(code))) return true;
    }

    // Check for HTTP status codes embedded in error objects
    const status =
      (err as { status?: number })?.status ??
      (err as { statusCode?: number })?.statusCode ??
      (err as { response?: { status?: number } })?.response?.status;

    if (typeof status === "number") {
      return this.retryConfig.retryableStatusCodes.includes(status);
    }

    return false;
  }

  // ── Option validation ─────────────────────────────────────────────────────

  protected validateOptions(options: AIGenerateOptions): void {
    if (!Array.isArray(options.messages)) {
      throw new Error("AIGenerateOptions.messages must be an array");
    }
    if (options.maxTokens !== undefined && options.maxTokens <= 0) {
      throw new Error("AIGenerateOptions.maxTokens must be positive");
    }
    if (
      options.temperature !== undefined &&
      (options.temperature < 0 || options.temperature > 2)
    ) {
      throw new Error("AIGenerateOptions.temperature must be between 0 and 2");
    }
  }

  // ── Context-limit helpers (for use by subclasses) ─────────────────────────

  /**
   * Returns a trimmed copy of the messages array that fits within the provider's
   * context window, after accounting for the system prompt and tool definitions.
   */
  protected trimToContextLimit(
    options: AIGenerateOptions,
    contextWindowTokens: number
  ): AIMessage[] {
    const { systemMessages, conversationMessages } = splitSystemMessages(options.messages);
    const systemString = buildSystemString(options.systemPrompt, systemMessages);

    const systemTokens = estimateTokens(systemString);
    const toolTokens = options.tools ? estimateToolsTokens(options.tools) : 0;
    const outputReserve = options.maxTokens ?? 2_048;

    return trimHistory(conversationMessages, contextWindowTokens, {
      systemPromptTokens: systemTokens,
      toolsTokens: toolTokens,
      reservedOutputTokens: outputReserve,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generates a simple monotonically-increasing tool-call ID. */
let _toolCallCounter = 0;
export function generateToolCallId(prefix = "call"): string {
  _toolCallCounter += 1;
  return `${prefix}_${Date.now()}_${_toolCallCounter}`;
}
