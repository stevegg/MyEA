/**
 * myEA — Ollama AI Provider
 *
 * Wraps the `ollama` package to talk to a local Ollama server.
 * Supports:
 *   - Dynamic model discovery (lists available models from the server)
 *   - Native tool calling for capable models (llama3.1, mistral-nemo, etc.)
 *   - Prompt-engineering fallback for models without tool-calling support
 *   - Configurable server base URL (defaults to http://ollama:11434)
 */

import { Ollama, type Message as OllamaMessage } from "ollama";
import type {
  AIProviderName,
  AIGenerateOptions,
  AIResponse,
  AIMessage,
  AITool,
  AIToolCall,
} from "../types";
import {
  BaseAIProvider,
  buildSystemString,
  splitSystemMessages,
  generateToolCallId,
} from "./base";

// ─────────────────────────────────────────────────────────────────────────────
// Models known to support native tool calling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * This list is checked via prefix matching, so "llama3.1" matches
 * "llama3.1:8b", "llama3.1:70b", etc.
 */
const TOOL_CAPABLE_MODEL_PREFIXES = [
  "llama3.1",
  "llama3.2",
  "llama3.3",
  "mistral",
  "mistral-nemo",
  "mixtral",
  "qwen2.5",
  "qwen2",
  "firefunction",
  "command-r",
  "hermes",
  "nous-hermes",
  "functionary",
  "nexusraven",
  "gorilla",
];

// Context windows for common Ollama models (tokens)
const OLLAMA_CONTEXT_WINDOWS: Record<string, number> = {
  "llama3.1":     128_000,
  "llama3.2":     128_000,
  "llama3.3":     128_000,
  "mistral":       32_768,
  "mistral-nemo":  128_000,
  "mixtral":       32_768,
  "qwen2.5":      128_000,
  "qwen2":        128_000,
  "phi3":           4_096,
  "gemma2":         8_192,
  "deepseek-r1":  128_000,
};

const DEFAULT_CONTEXT_WINDOW = 8_192;
const DEFAULT_MAX_TOKENS     = 2_048;
const DEFAULT_MODEL          = "llama3.1";

// ─────────────────────────────────────────────────────────────────────────────
// Provider implementation
// ─────────────────────────────────────────────────────────────────────────────

export class OllamaProvider extends BaseAIProvider {
  readonly name: AIProviderName = "ollama";
  readonly model: string;

  private readonly client: Ollama;
  private readonly baseUrl: string;

  /** Cache of available model names, refreshed lazily. */
  private _availableModels: string[] | null = null;
  private _modelsCachedAt = 0;
  private static readonly MODEL_CACHE_TTL_MS = 60_000; // 1 minute

  constructor(baseUrl: string = "http://ollama:11434", model: string = DEFAULT_MODEL) {
    super({
      // Ollama is local — shorter backoff makes more sense
      baseDelayMs: 500,
      maxDelayMs:  10_000,
      maxAttempts: 3,
    });
    this.baseUrl = baseUrl;
    this.client  = new Ollama({ host: baseUrl });
    this.model   = model;
  }

  // ── Core generate ─────────────────────────────────────────────────────────

  protected async _generate(options: AIGenerateOptions): Promise<AIResponse> {
    const modelName = options.model ?? this.model;
    const contextWindow = this.getContextWindow(modelName);

    // Resolve system prompt
    const { systemMessages, conversationMessages } = splitSystemMessages(options.messages);
    const systemString = buildSystemString(options.systemPrompt, systemMessages);

    // Trim history
    const trimmedMessages = this.trimToContextLimit(
      { ...options, messages: conversationMessages },
      contextWindow
    );

    const supportsTools =
      !!options.tools?.length && this.modelSupportsTools(modelName);

    if (supportsTools) {
      return this.generateWithTools(
        modelName,
        systemString,
        trimmedMessages,
        options.tools!,
        options
      );
    } else if (options.tools?.length) {
      // Model doesn't support native tools — use prompt engineering fallback
      return this.generateWithPromptTools(
        modelName,
        systemString,
        trimmedMessages,
        options.tools,
        options
      );
    } else {
      return this.generatePlain(modelName, systemString, trimmedMessages, options);
    }
  }

  // ── Native tool calling ───────────────────────────────────────────────────

  private async generateWithTools(
    modelName: string,
    systemString: string,
    messages: AIMessage[],
    tools: AITool[],
    options: AIGenerateOptions
  ): Promise<AIResponse> {
    const ollamaMessages = toOllamaMessages(messages, systemString);
    const ollamaTools = toOllamaTools(tools);

    const response = await this.client.chat({
      model: modelName,
      messages: ollamaMessages,
      tools: ollamaTools,
      options: {
        num_predict: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(options.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
      },
    });

    return toAIResponse(response, modelName, "ollama");
  }

  // ── Prompt-engineering tool fallback ──────────────────────────────────────

  /**
   * For models that don't support native tool calling, we inject a structured
   * prompt that instructs the model to output JSON tool calls, then parse them.
   */
  private async generateWithPromptTools(
    modelName: string,
    systemString: string,
    messages: AIMessage[],
    tools: AITool[],
    options: AIGenerateOptions
  ): Promise<AIResponse> {
    const toolsDescription = buildPromptToolsDescription(tools);
    const enhancedSystem = [
      systemString,
      toolsDescription,
    ]
      .filter(Boolean)
      .join("\n\n");

    const ollamaMessages = toOllamaMessages(messages, enhancedSystem);

    const response = await this.client.chat({
      model: modelName,
      messages: ollamaMessages,
      options: {
        num_predict: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(options.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
      },
    });

    const rawContent = response.message.content ?? "";
    const toolCalls  = extractPromptToolCalls(rawContent);
    const cleanText  = stripToolCallJson(rawContent);

    let finalContent = cleanText;
    if (toolCalls.length > 0) {
      finalContent =
        (cleanText ? cleanText + "\n" : "") +
        `__tool_calls__:${JSON.stringify(toolCalls)}`;
    }

    return {
      content:   finalContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: estimateUsageFromOllamaResponse(response),
      model:      modelName,
      provider:   "ollama",
      finishedAt: new Date().toISOString(),
    };
  }

  // ── Plain text generation ─────────────────────────────────────────────────

  private async generatePlain(
    modelName: string,
    systemString: string,
    messages: AIMessage[],
    options: AIGenerateOptions
  ): Promise<AIResponse> {
    const ollamaMessages = toOllamaMessages(messages, systemString);

    const response = await this.client.chat({
      model: modelName,
      messages: ollamaMessages,
      options: {
        num_predict: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(options.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
      },
    });

    return toAIResponse(response, modelName, "ollama");
  }

  // ── Health check ──────────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      const models = await this.listAvailableModels();
      return models.length >= 0; // true even if no models are pulled yet
    } catch {
      return false;
    }
  }

  // ── Model discovery ───────────────────────────────────────────────────────

  /**
   * Returns the list of model names currently available on the Ollama server.
   * Results are cached for MODEL_CACHE_TTL_MS to avoid hammering the API.
   */
  async listAvailableModels(): Promise<string[]> {
    const now = Date.now();
    if (
      this._availableModels !== null &&
      now - this._modelsCachedAt < OllamaProvider.MODEL_CACHE_TTL_MS
    ) {
      return this._availableModels;
    }

    const response = await this.client.list();
    this._availableModels = response.models.map((m) => m.name);
    this._modelsCachedAt  = now;
    return this._availableModels;
  }

  /** Invalidates the model cache, forcing a fresh fetch on next call. */
  invalidateModelCache(): void {
    this._availableModels = null;
    this._modelsCachedAt  = 0;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Returns true if the given model name is likely to support tool calling. */
  modelSupportsTools(modelName: string): boolean {
    const lower = modelName.toLowerCase();
    return TOOL_CAPABLE_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
  }

  private getContextWindow(modelName: string): number {
    // Match by prefix — strip tag suffix (e.g. "llama3.1:8b" → "llama3.1")
    const base = modelName.split(":")[0].toLowerCase();
    return OLLAMA_CONTEXT_WINDOWS[base] ?? DEFAULT_CONTEXT_WINDOW;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ollama message / tool conversion helpers
// ─────────────────────────────────────────────────────────────────────────────

function toOllamaMessages(messages: AIMessage[], systemString: string): OllamaMessage[] {
  const result: OllamaMessage[] = [];

  if (systemString) {
    result.push({ role: "system", content: systemString });
  }

  for (const msg of messages) {
    if (msg.role === "tool") {
      // Ollama represents tool results as tool messages
      result.push({
        role: "tool",
        content: msg.content,
      });
    } else if (msg.role === "assistant") {
      const parsed = tryParseAssistantContent(msg.content);
      if (parsed.toolCalls.length > 0) {
        result.push({
          role: "assistant",
          content: parsed.textContent ?? "",
          tool_calls: parsed.toolCalls.map((tc) => ({
            function: {
              name:      tc.name,
              arguments: tc.input,
            },
          })),
        });
      } else {
        result.push({ role: "assistant", content: msg.content });
      }
    } else {
      result.push({ role: "user", content: msg.content });
    }
  }

  return result;
}

function toOllamaTools(tools: AITool[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name:        tool.name,
      description: tool.description,
      parameters:  tool.inputSchema,
    },
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt-engineering tool helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildPromptToolsDescription(tools: AITool[]): string {
  const lines: string[] = [
    "## Available Tools",
    "",
    "You have access to the following tools. To call a tool, respond with a JSON block",
    "inside <tool_call> tags. You may call multiple tools by including multiple blocks.",
    "",
    "Format:",
    "<tool_call>",
    '{"name": "tool_name", "arguments": {"param1": "value1"}}',
    "</tool_call>",
    "",
    "### Tool Definitions",
  ];

  for (const tool of tools) {
    lines.push(`**${tool.name}**: ${tool.description}`);
    lines.push(`Parameters: ${JSON.stringify(tool.inputSchema, null, 2)}`);
    lines.push("");
  }

  lines.push(
    "Only call tools when you need to take action or retrieve information.",
    "After calling tools, wait for results before responding to the user.",
    "If you don't need any tools, respond normally without any <tool_call> blocks."
  );

  return lines.join("\n");
}

const TOOL_CALL_REGEX = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

function extractPromptToolCalls(content: string): AIToolCall[] {
  const calls: AIToolCall[] = [];
  let match: RegExpExecArray | null;

  TOOL_CALL_REGEX.lastIndex = 0;
  while ((match = TOOL_CALL_REGEX.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as {
        name: string;
        arguments?: Record<string, unknown>;
        input?: Record<string, unknown>;
      };
      calls.push({
        id:    generateToolCallId("ollama"),
        name:  parsed.name,
        input: parsed.arguments ?? parsed.input ?? {},
      });
    } catch {
      // Malformed JSON — skip this block
    }
  }

  return calls;
}

function stripToolCallJson(content: string): string {
  return content.replace(TOOL_CALL_REGEX, "").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Response conversion
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toAIResponse(response: any, modelName: string, provider: "ollama"): AIResponse {
  const message    = response.message;
  const rawContent = message?.content ?? "";
  const toolCalls: AIToolCall[] = [];

  // Native tool calls returned by the Ollama server
  if (Array.isArray(message?.tool_calls)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const tc of message.tool_calls as any[]) {
      toolCalls.push({
        id:    generateToolCallId("ollama"),
        name:  tc.function?.name ?? "",
        input: tc.function?.arguments ?? {},
      });
    }
  }

  let finalContent = rawContent;
  if (toolCalls.length > 0) {
    finalContent =
      (rawContent ? rawContent + "\n" : "") +
      `__tool_calls__:${JSON.stringify(toolCalls)}`;
  }

  return {
    content:   finalContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage:     estimateUsageFromOllamaResponse(response),
    model:     modelName,
    provider,
    finishedAt: new Date().toISOString(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function estimateUsageFromOllamaResponse(response: any): AIResponse["usage"] {
  if (
    typeof response.prompt_eval_count === "number" ||
    typeof response.eval_count === "number"
  ) {
    const promptTokens     = response.prompt_eval_count ?? 0;
    const completionTokens = response.eval_count ?? 0;
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }
  return undefined;
}

function tryParseAssistantContent(content: string): {
  textContent: string;
  toolCalls: AIToolCall[];
} {
  try {
    const MARKER = "__tool_calls__:";
    const idx    = content.indexOf(MARKER);
    if (idx === -1) return { textContent: content, toolCalls: [] };

    const textContent = content.slice(0, idx).trim();
    const jsonPart    = content.slice(idx + MARKER.length).trim();
    const toolCalls   = JSON.parse(jsonPart) as AIToolCall[];
    return { textContent, toolCalls };
  } catch {
    return { textContent: content, toolCalls: [] };
  }
}
