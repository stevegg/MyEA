/**
 * myEA — Anthropic / Claude AI Provider
 *
 * Wraps @anthropic-ai/sdk to implement the AIProvider interface.
 * Supports:
 *   - All Claude 3.x and Claude 4.x model families
 *   - Native tool_use / tool_result message round-trips
 *   - Streaming (stub exposed for future use)
 *   - Automatic context-window trimming via BaseAIProvider helpers
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  AIProviderName,
  AIGenerateOptions,
  AIResponse,
  AIMessage,
  AIMessageImage,
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
// Model context-window map (tokens)
// ─────────────────────────────────────────────────────────────────────────────

const CLAUDE_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-5":    200_000,
  "claude-opus-4-6":    200_000,
  "claude-sonnet-4-5":  200_000,
  "claude-sonnet-4-6":  200_000,
  "claude-haiku-4-5":   200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-haiku-20241022":  200_000,
  "claude-3-opus-20240229":     200_000,
  "claude-3-haiku-20240307":    200_000,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS     = 4_096;
const DEFAULT_MODEL          = "claude-sonnet-4-6";

// ─────────────────────────────────────────────────────────────────────────────
// Type helpers
// ─────────────────────────────────────────────────────────────────────────────

type AnthropicTool = Anthropic.Tool;
type AnthropicMessageParam = Anthropic.MessageParam;
type AnthropicContent = Anthropic.ContentBlock;

// ─────────────────────────────────────────────────────────────────────────────
// Provider implementation
// ─────────────────────────────────────────────────────────────────────────────

export class AnthropicProvider extends BaseAIProvider {
  readonly name: AIProviderName = "claude";
  readonly model: string;

  private readonly client: Anthropic;

  constructor(apiKey: string, model: string = DEFAULT_MODEL) {
    super();
    if (!apiKey) throw new Error("AnthropicProvider: apiKey is required");
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  // ── Core generate ─────────────────────────────────────────────────────────

  protected async _generate(options: AIGenerateOptions): Promise<AIResponse> {
    const modelName = options.model ?? this.model;
    const contextWindow = CLAUDE_CONTEXT_WINDOWS[modelName] ?? DEFAULT_CONTEXT_WINDOW;
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

    // Resolve system prompt
    const { systemMessages, conversationMessages } = splitSystemMessages(options.messages);
    const systemString = buildSystemString(options.systemPrompt, systemMessages);

    // Trim history to fit context
    const trimmedMessages = this.trimToContextLimit(
      { ...options, messages: conversationMessages },
      contextWindow
    );

    // Build Anthropic-format messages
    const anthropicMessages = toAnthropicMessages(trimmedMessages);

    // Build tools array
    const tools: AnthropicTool[] | undefined = options.tools?.length
      ? toAnthropicTools(options.tools)
      : undefined;

    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: modelName,
      max_tokens: maxTokens,
      messages: anthropicMessages,
      ...(systemString ? { system: systemString } : {}),
      ...(tools ? { tools } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    };

    const response = await this.client.messages.create(requestParams);

    return toAIResponse(response, modelName);
  }

  // ── Health check ──────────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      // Minimal call — list models endpoint is cheap
      await this.client.messages.create({
        model: this.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      });
      return true;
    } catch {
      return false;
    }
  }

  // ── Streaming (for future use) ─────────────────────────────────────────────

  /**
   * Streams a response from Claude and yields text deltas.
   * Tool use is NOT supported in streaming mode; callers should fall back
   * to `generate()` when tools are required.
   */
  async *stream(
    options: Omit<AIGenerateOptions, "tools">
  ): AsyncGenerator<string, void, unknown> {
    const modelName = options.model ?? this.model;
    const contextWindow = CLAUDE_CONTEXT_WINDOWS[modelName] ?? DEFAULT_CONTEXT_WINDOW;
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

    const { systemMessages, conversationMessages } = splitSystemMessages(options.messages);
    const systemString = buildSystemString(options.systemPrompt, systemMessages);

    const trimmedMessages = this.trimToContextLimit(
      { ...options, messages: conversationMessages },
      contextWindow
    );

    const anthropicMessages = toAnthropicMessages(trimmedMessages);

    const stream = await this.client.messages.stream({
      model: modelName,
      max_tokens: maxTokens,
      messages: anthropicMessages,
      ...(systemString ? { system: systemString } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversion utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps our generic AITool[] to Anthropic's tool definition format.
 */
function toAnthropicTools(tools: AITool[]): AnthropicTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

/**
 * Converts our flat AIMessage[] to Anthropic's MessageParam[].
 *
 * Anthropic's API represents multi-step tool calling as:
 *   assistant: [{ type: "tool_use", id, name, input }]
 *   user:      [{ type: "tool_result", tool_use_id, content }]
 *
 * Our internal format stores tool results as role="tool" with a toolCallId.
 * This function handles both the conversion and the grouping of consecutive
 * tool_result blocks under a single user turn (required by the API).
 */
function toAnthropicMessages(messages: AIMessage[]): AnthropicMessageParam[] {
  const result: AnthropicMessageParam[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "tool") {
      // Collect all consecutive tool result messages into one user turn
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      while (i < messages.length && messages[i].role === "tool") {
        const toolMsg = messages[i];
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolMsg.toolCallId ?? generateToolCallId("stub"),
          content: toolMsg.content,
        });
        i++;
      }

      result.push({ role: "user", content: toolResults });
      continue;
    }

    if (msg.role === "assistant") {
      // Check if this assistant message contains embedded tool_use JSON
      // (produced by toAIResponse's serialisation of tool calls).
      // If the next message(s) are tool results, we need to embed tool_use
      // blocks in this assistant turn so Anthropic's API is satisfied.
      const parsed = tryParseAssistantContent(msg.content);

      if (parsed.toolCalls.length > 0) {
        const contentBlocks: Anthropic.Messages.ContentBlock[] = [];

        if (parsed.textContent) {
          contentBlocks.push({ type: "text", text: parsed.textContent });
        }

        for (const tc of parsed.toolCalls) {
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.input,
          });
        }

        result.push({ role: "assistant", content: contentBlocks });
      } else {
        result.push({ role: "assistant", content: msg.content });
      }

      i++;
      continue;
    }

    // user or any other role — pass through as text, with optional images
    if (msg.images?.length) {
      type ImageBlock = { type: "image"; source: { type: "base64"; media_type: string; data: string } };
      type TextBlock = { type: "text"; text: string };
      const contentBlocks: Array<ImageBlock | TextBlock> = [
        ...msg.images.map((img: AIMessageImage): ImageBlock => ({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mimeType,
            data: img.base64,
          },
        })),
        ...(msg.content ? [{ type: "text" as const, text: msg.content }] : []),
      ];
      result.push({ role: "user", content: contentBlocks as AnthropicMessageParam["content"] });
    } else {
      result.push({ role: "user", content: msg.content });
    }
    i++;
  }

  return result;
}

/**
 * Attempts to parse tool call data embedded in an assistant message.
 * We store serialised tool calls in assistant messages using a JSON envelope.
 */
function tryParseAssistantContent(content: string): {
  textContent: string;
  toolCalls: AIToolCall[];
} {
  try {
    // We look for our internal serialisation marker
    const MARKER = "__tool_calls__:";
    const idx = content.indexOf(MARKER);
    if (idx === -1) return { textContent: content, toolCalls: [] };

    const textContent = content.slice(0, idx).trim();
    const jsonPart = content.slice(idx + MARKER.length).trim();
    const toolCalls = JSON.parse(jsonPart) as AIToolCall[];
    return { textContent, toolCalls };
  } catch {
    return { textContent: content, toolCalls: [] };
  }
}

/**
 * Converts an Anthropic API response to our generic AIResponse format.
 */
function toAIResponse(
  response: Anthropic.Message,
  modelName: string
): AIResponse {
  let textContent = "";
  const toolCalls: AIToolCall[] = [];

  for (const block of response.content as AnthropicContent[]) {
    if (block.type === "text") {
      textContent += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    }
  }

  // Embed tool call data into the content string so it survives
  // round-tripping through our AIMessage storage layer.
  let finalContent = textContent;
  if (toolCalls.length > 0) {
    finalContent =
      (textContent ? textContent + "\n" : "") +
      `__tool_calls__:${JSON.stringify(toolCalls)}`;
  }

  return {
    content: finalContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    },
    model: response.model,
    provider: "claude",
    finishedAt: new Date().toISOString(),
  };
}
