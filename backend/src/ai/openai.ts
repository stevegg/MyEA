/**
 * myEA — OpenAI AI Provider
 *
 * Wraps the `openai` package to implement the AIProvider interface.
 * Supports:
 *   - GPT-4o, GPT-4o-mini, GPT-4-turbo (and any future model string)
 *   - Function calling via OpenAI's tool_calls format
 *   - Automatic conversion between our AIMessage format and OpenAI's ChatCompletionMessageParam
 *   - Context-window trimming via BaseAIProvider helpers
 */

import OpenAI from "openai";
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
} from "./base";

// ─────────────────────────────────────────────────────────────────────────────
// Model context-window map (tokens)
// ─────────────────────────────────────────────────────────────────────────────

const OPENAI_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-4o":              128_000,
  "gpt-4o-mini":         128_000,
  "gpt-4-turbo":         128_000,
  "gpt-4-turbo-preview": 128_000,
  "gpt-4":                 8_192,
  "gpt-3.5-turbo":        16_385,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS     = 4_096;
const DEFAULT_MODEL          = "gpt-4o";

// ─────────────────────────────────────────────────────────────────────────────
// Type aliases for readability
// ─────────────────────────────────────────────────────────────────────────────

type OAIMessage = OpenAI.Chat.ChatCompletionMessageParam;
type OAITool   = OpenAI.Chat.ChatCompletionTool;

// ─────────────────────────────────────────────────────────────────────────────
// Provider implementation
// ─────────────────────────────────────────────────────────────────────────────

export class OpenAIProvider extends BaseAIProvider {
  readonly name: AIProviderName = "openai";
  readonly model: string;

  private readonly client: OpenAI;

  constructor(apiKey: string, model: string = DEFAULT_MODEL) {
    super();
    if (!apiKey) throw new Error("OpenAIProvider: apiKey is required");
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  // ── Core generate ─────────────────────────────────────────────────────────

  protected async _generate(options: AIGenerateOptions): Promise<AIResponse> {
    const modelName  = options.model ?? this.model;
    const contextWindow = OPENAI_CONTEXT_WINDOWS[modelName] ?? DEFAULT_CONTEXT_WINDOW;
    const maxTokens  = options.maxTokens ?? DEFAULT_MAX_TOKENS;

    // Resolve system prompt
    const { systemMessages, conversationMessages } = splitSystemMessages(options.messages);
    const systemString = buildSystemString(options.systemPrompt, systemMessages);

    // Trim history to fit context window
    const trimmedMessages = this.trimToContextLimit(
      { ...options, messages: conversationMessages },
      contextWindow
    );

    // Build OpenAI message array (system first, then conversation)
    const oaiMessages: OAIMessage[] = [];
    if (systemString) {
      oaiMessages.push({ role: "system", content: systemString });
    }
    oaiMessages.push(...toOpenAIMessages(trimmedMessages));

    // Build tools array
    const tools: OAITool[] | undefined = options.tools?.length
      ? toOpenAITools(options.tools)
      : undefined;

    const response = await this.client.chat.completions.create({
      model: modelName,
      max_tokens: maxTokens,
      messages: oaiMessages,
      ...(tools ? { tools, tool_choice: "auto" } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    });

    return toAIResponse(response, modelName);
  }

  // ── Health check ──────────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      });
      return true;
    } catch {
      return false;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversion utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps our generic AITool[] to OpenAI's function-calling tool format.
 */
function toOpenAITools(tools: AITool[]): OAITool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as unknown as Record<string, unknown>,
    },
  }));
}

/**
 * Converts our internal AIMessage[] to OpenAI's ChatCompletionMessageParam[].
 *
 * Our format:
 *   role="tool"  → tool result (has toolCallId, toolName)
 *   role="assistant" → may contain embedded tool_calls JSON marker
 *
 * OpenAI format:
 *   role="tool"       → { role, tool_call_id, content }
 *   role="assistant"  → { role, content, tool_calls?: [...] }
 */
function toOpenAIMessages(messages: AIMessage[]): OAIMessage[] {
  return messages.map((msg): OAIMessage => {
    if (msg.role === "tool") {
      return {
        role: "tool",
        tool_call_id: msg.toolCallId ?? "",
        content: msg.content,
      };
    }

    if (msg.role === "assistant") {
      const parsed = tryParseAssistantContent(msg.content);
      if (parsed.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: parsed.textContent || null,
          tool_calls: parsed.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input),
            },
          })),
        };
      }
      return { role: "assistant", content: msg.content };
    }

    // user
    return { role: "user", content: msg.content };
  });
}

/**
 * Parses embedded tool-call data from an assistant message's content string.
 * We use the same __tool_calls__ marker convention as the Anthropic provider
 * so messages are portable across providers.
 */
function tryParseAssistantContent(content: string): {
  textContent: string;
  toolCalls: AIToolCall[];
} {
  try {
    const MARKER = "__tool_calls__:";
    const idx = content.indexOf(MARKER);
    if (idx === -1) return { textContent: content, toolCalls: [] };

    const textContent = content.slice(0, idx).trim();
    const jsonPart    = content.slice(idx + MARKER.length).trim();
    const toolCalls   = JSON.parse(jsonPart) as AIToolCall[];
    return { textContent, toolCalls };
  } catch {
    return { textContent: content, toolCalls: [] };
  }
}

/**
 * Converts an OpenAI chat completion response to our generic AIResponse.
 */
function toAIResponse(
  response: OpenAI.Chat.ChatCompletion,
  modelName: string
): AIResponse {
  const choice = response.choices[0];
  if (!choice) throw new Error("OpenAI returned no choices");

  const message      = choice.message;
  const textContent  = message.content ?? "";
  const toolCalls: AIToolCall[] = [];

  if (message.tool_calls?.length) {
    for (const tc of message.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        // Keep empty object if arguments can't be parsed
      }
      toolCalls.push({ id: tc.id, name: tc.function.name, input });
    }
  }

  // Embed tool call data into content for round-trip storage
  let finalContent = textContent;
  if (toolCalls.length > 0) {
    finalContent =
      (textContent ? textContent + "\n" : "") +
      `__tool_calls__:${JSON.stringify(toolCalls)}`;
  }

  const usage = response.usage;

  return {
    content: finalContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: usage
      ? {
          promptTokens:     usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens:      usage.total_tokens,
        }
      : undefined,
    model: modelName,
    provider: "openai",
    finishedAt: new Date().toISOString(),
  };
}
