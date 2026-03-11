/**
 * myEA — Message Orchestrator
 *
 * The brain of the system. Receives an inbound PlatformMessage from any
 * connector and drives the full response cycle:
 *
 *   1. Persist the inbound message (find or create conversation)
 *   2. Load conversation history + relevant memory context
 *   3. Build a prompt: system instructions, history, memory, tools
 *   4. Call the active AI provider
 *   5. Execute tool calls (multi-step loop, up to MAX_TOOL_TURNS iterations)
 *   6. Persist the assistant response
 *   7. Extract and store new memory entries
 *   8. Return the OutboundMessage to the connector
 *
 * Also provides `sendProactive()` for scheduler-initiated messages.
 */

import { eq, asc, desc, and, sql } from "drizzle-orm";
import type {
  PlatformMessage,
  OutboundMessage,
  AIMessage,
  AITool,
  AIToolCall,
  AIProvider,
  MemoryService,
  SchedulerService,
  Logger,
  AppConfig,
  DatabaseService,
  ExecutionContext,
  Skill,
  ToolDefinition,
} from "../types";
import type { DrizzleDB } from "../db";
import {
  conversations,
  messages,
  type NewMessage,
  type Conversation,
} from "../db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TOOL_TURNS = 10;
const HISTORY_WINDOW = 20; // messages to include in context (capped at 20 per production default)
const MEMORY_RESULTS = 8; // relevant memories to inject

// ─────────────────────────────────────────────────────────────────────────────
// System Prompt
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(
  config: AppConfig,
  memoryContext: string,
  platform: string
): string {
  const now = new Date().toISOString();

  return `You are myEA, a personal AI executive assistant. You are highly capable, proactive, and concise. You help your user manage their life: schedule, communications, information, tasks, and smart-home control.

Current time: ${now}
Active platform: ${platform}
AI model: ${config.ai.model} (${config.ai.activeProvider})

## Behaviour Guidelines
- Be direct and concise. Prefer bullet points over prose for lists.
- Always confirm before taking destructive actions (delete, send emails, etc.).
- If you need clarification, ask one focused question — not several at once.
- Use tools whenever possible instead of guessing.
- After completing a task, briefly confirm what was done.

## Memory Context
The following is what you know about the user and recent context. Treat this as ground truth:

${memoryContext || "(No memory context loaded yet.)"}

## Tool Use
You have access to tools provided by loaded skills. When calling tools:
- Prefer the most specific tool for the task.
- If a tool call fails, explain clearly and offer alternatives.
- Chain tools logically — do not ask the user for info a tool can fetch.
`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// OrchestratorOptions
// ─────────────────────────────────────────────────────────────────────────────

export interface OrchestratorOptions {
  db: DrizzleDB;
  dbService: DatabaseService;
  aiProvider: AIProvider;
  memory: MemoryService;
  scheduler: SchedulerService;
  logger: Logger;
  config: AppConfig;
  /** Called by the orchestrator to dispatch outbound messages during tool loops. */
  sendMessage: (msg: OutboundMessage) => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export class Orchestrator {
  /** Loaded skills, updated by the SkillRuntime via registerSkill(). */
  private readonly skills = new Map<string, Skill>();

  /**
   * Optional override for tool execution — set this to delegate tool dispatch
   * to the SkillEngine rather than searching the in-memory skills map.
   * Signature matches SkillEngine.executeTool().
   */
  private toolExecutor?: (
    toolName: string,
    params: unknown,
    context: ExecutionContext
  ) => Promise<import("../types").ToolResult>;

  constructor(private readonly opts: OrchestratorOptions) {}

  /**
   * Hot-swap the active AI provider (called when settings change at runtime).
   */
  setAIProvider(provider: AIProvider): void {
    this.opts.aiProvider = provider;
    this.opts.logger.info({ provider: provider.name, model: provider.model }, "AI provider updated in orchestrator");
  }

  /**
   * Wire in the SkillEngine's executeTool method so the orchestrator delegates
   * all tool calls through the engine (which supports hot-reload).
   * Call this after both the orchestrator and skill engine are created.
   */
  setToolExecutor(
    fn: (toolName: string, params: unknown, context: ExecutionContext) => Promise<import("../types").ToolResult>
  ): void {
    this.toolExecutor = fn;
  }

  /**
   * Wire in a function that returns all currently available AITools from the
   * SkillEngine. When set, this replaces the internal _collectTools() logic.
   */
  setToolsProvider(fn: () => AITool[]): void {
    this.toolsProvider = fn;
  }

  private toolsProvider?: () => AITool[];

  // ── Skill registry ─────────────────────────────────────────

  registerSkill(skill: Skill): void {
    this.skills.set(skill.name, skill);
    this.opts.logger.debug({ skill: skill.name }, "Skill registered with orchestrator");
  }

  unregisterSkill(name: string): void {
    this.skills.delete(name);
    this.opts.logger.debug({ skill: name }, "Skill unregistered from orchestrator");
  }

  // ── Main entry point ───────────────────────────────────────

  async handleInbound(inbound: PlatformMessage): Promise<OutboundMessage> {
    const { db, logger, config, aiProvider, memory } = this.opts;

    logger.info(
      { platform: inbound.platform, userId: inbound.userId, msgId: inbound.id },
      "Orchestrator: handling inbound message"
    );

    // 1. Find or create conversation
    const conversation = await this._findOrCreateConversation(inbound);

    // 2. Persist the user message
    await this._insertMessage({
      conversationId: conversation.id,
      role: "user",
      content: inbound.text,
      platform: inbound.platform,
      platformMessageId: inbound.id,
    });

    // Increment conversation message count
    await db
      .update(conversations)
      .set({
        messageCount: sql`${conversations.messageCount} + 1`,
        updatedAt: new Date(),
        platformUserName: inbound.userName ?? null,
      })
      .where(eq(conversations.id, conversation.id));

    // 3. Load history
    const history = await this._loadHistory(conversation.id);

    // 4. Load relevant memory
    const memoryEntries = await memory.search({ query: inbound.text, limit: MEMORY_RESULTS });
    const memoryContext = memoryEntries
      .map((e) => `[${e.type}] ${e.content}`)
      .join("\n");

    // 5. Collect available tools from enabled skills
    const tools = this._collectTools();

    // 6. Build messages array for the AI
    const aiMessages: AIMessage[] = history.map((m) => ({
      role: m.role as AIMessage["role"],
      content: m.content,
      toolCallId: m.toolCallId ?? undefined,
      toolName: m.toolName ?? undefined,
    }));

    // 7. Run the AI + tool loop
    const { finalContent, allNewMessages } = await this._runAILoop({
      conversation,
      inbound,
      aiMessages,
      tools,
      systemPrompt: buildSystemPrompt(config, memoryContext, inbound.platform),
    });

    // 8. Persist all new assistant/tool messages in a single batch insert
    if (allNewMessages.length > 0) {
      await this._insertMessages(allNewMessages);
    }

    // Increment message count for all new messages
    await db
      .update(conversations)
      .set({
        messageCount: sql`${conversations.messageCount} + ${allNewMessages.length}`,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversation.id));

    // 9. Extract memory from the conversation (async — non-blocking)
    void this._extractMemory(inbound.text, finalContent).catch((err) =>
      logger.warn({ err }, "Memory extraction failed")
    );

    // 10. Return the outbound message
    return {
      platform: inbound.platform,
      channelId: inbound.channelId,
      userId: inbound.userId,
      text: finalContent,
      replyToId: inbound.id,
    };
  }

  // ── Proactive outbound ─────────────────────────────────────

  async sendProactive(message: OutboundMessage): Promise<void> {
    const { logger } = this.opts;
    logger.info(
      { platform: message.platform, channelId: message.channelId },
      "Orchestrator: sending proactive message"
    );

    await this.opts.sendMessage(message);

    // Persist to the internal conversation for this channel if one exists
    const [conv] = await this.opts.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.platform, message.platform),
          eq(conversations.platformChannelId, message.channelId)
        )
      )
      .limit(1);

    if (conv) {
      await this._insertMessage({
        conversationId: conv.id,
        role: "assistant",
        content: message.text,
        platform: message.platform,
      });
      await this.opts.db
        .update(conversations)
        .set({
          messageCount: sql`${conversations.messageCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, conv.id));
    }
  }

  // ── AI + tool execution loop ───────────────────────────────

  private async _runAILoop(params: {
    conversation: Conversation;
    inbound: PlatformMessage;
    aiMessages: AIMessage[];
    tools: AITool[];
    systemPrompt: string;
  }): Promise<{ finalContent: string; allNewMessages: NewMessage[] }> {
    const { conversation, inbound, tools, systemPrompt } = params;
    const { aiProvider, logger, config, db, dbService, memory, scheduler } = this.opts;

    const aiMessages = [...params.aiMessages];
    const allNewMessages: NewMessage[] = [];
    let turnIndex = 0;
    let finalContent = "";

    while (turnIndex < MAX_TOOL_TURNS) {
      const response = await aiProvider.generate({
        messages: aiMessages,
        tools: tools.length > 0 ? tools : undefined,
        systemPrompt,
        maxTokens: 4096,
        temperature: 0.7,
      });

      // If no tool calls, we have our final answer
      if (!response.toolCalls || response.toolCalls.length === 0) {
        finalContent = response.content;

        allNewMessages.push({
          conversationId: conversation.id,
          role: "assistant",
          content: finalContent,
          platform: inbound.platform,
          aiProvider: response.provider,
          aiModel: response.model,
          tokenUsage: response.usage,
        });

        break;
      }

      // Persist the assistant turn that contains tool calls
      allNewMessages.push({
        conversationId: conversation.id,
        role: "assistant",
        content: response.content || `[Calling ${response.toolCalls.length} tool(s)]`,
        platform: inbound.platform,
        aiProvider: response.provider,
        aiModel: response.model,
        tokenUsage: response.usage,
      });

      // Push assistant message into the running history
      aiMessages.push({
        role: "assistant",
        content: response.content || "",
      });

      // Execute each tool call
      const executionContext: ExecutionContext = {
        triggerMessage: inbound,
        conversationId: conversation.id,
        turnIndex,
        turnState: {},
        config,
        db: dbService,
        memory,
        scheduler,
        logger,
      };

      for (const toolCall of response.toolCalls) {
        const result = await this._executeTool(toolCall, executionContext);

        const toolResultContent = result.isError
          ? `[Tool Error] ${result.content}`
          : result.content;

        // Push tool result as a "tool" message into history
        aiMessages.push({
          role: "tool",
          content: toolResultContent,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        });

        allNewMessages.push({
          conversationId: conversation.id,
          role: "tool",
          content: toolResultContent,
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          platform: inbound.platform,
        });

        logger.debug(
          { tool: toolCall.name, isError: result.isError },
          "Tool execution complete"
        );
      }

      turnIndex++;
    }

    if (!finalContent && turnIndex >= MAX_TOOL_TURNS) {
      finalContent = "I reached the maximum number of tool calls for this turn. Please try again.";
      allNewMessages.push({
        conversationId: conversation.id,
        role: "assistant",
        content: finalContent,
        platform: inbound.platform,
      });
    }

    return { finalContent, allNewMessages };
  }

  // ── Tool execution ─────────────────────────────────────────

  private async _executeTool(
    toolCall: AIToolCall,
    context: ExecutionContext
  ): Promise<{ content: string; isError?: boolean }> {
    const { logger } = this.opts;

    // If a SkillEngine executor is wired, delegate to it for hot-reload support.
    if (this.toolExecutor) {
      try {
        return await this.toolExecutor(toolCall.name, toolCall.input, context);
      } catch (err) {
        logger.error({ err, toolName: toolCall.name }, "Tool execution threw an error");
        const message = err instanceof Error ? err.message : String(err);
        return { content: `Tool "${toolCall.name}" failed: ${message}`, isError: true };
      }
    }

    // Fallback: search the in-memory skills map (used when engine is not wired).
    let toolDef: ToolDefinition | undefined;
    for (const skill of this.skills.values()) {
      const found = skill.tools.find((t) => t.name === toolCall.name);
      if (found) {
        toolDef = found;
        break;
      }
    }

    if (!toolDef) {
      logger.warn({ toolName: toolCall.name }, "Tool not found");
      return { content: `Tool "${toolCall.name}" is not available.`, isError: true };
    }

    try {
      const result = await toolDef.execute(toolCall.input, context);
      return result;
    } catch (err) {
      logger.error({ err, toolName: toolCall.name }, "Tool execution threw an error");
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Tool "${toolCall.name}" failed: ${message}`, isError: true };
    }
  }

  // ── Memory extraction ──────────────────────────────────────

  private async _extractMemory(userText: string, assistantText: string): Promise<void> {
    const { aiProvider, memory, logger } = this.opts;

    // Use the AI to extract durable facts / preferences from the exchange.
    // This runs in the background after the response is sent.
    const extractionPrompt: AIMessage[] = [
      {
        role: "user",
        content: `Review this conversation exchange and extract any durable facts, preferences, or context that should be remembered about the user. Return a JSON array of objects with "type" (fact|preference|note) and "content" fields. Return an empty array [] if nothing new is worth remembering.

User said: "${userText}"
Assistant responded: "${assistantText}"

JSON array only, no other text:`,
      },
    ];

    try {
      const response = await aiProvider.generate({
        messages: extractionPrompt,
        maxTokens: 512,
        temperature: 0.1,
      });

      let parsed: Array<{ type: string; content: string }> = [];
      try {
        const jsonMatch = response.content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        }
      } catch {
        return; // Ignore parse failures
      }

      // Store all extracted entries concurrently instead of sequentially
      const storePromises = parsed
        .filter((item) => item.content && item.content.trim().length > 10)
        .map((item) =>
          memory.store({
            type: (item.type as "fact" | "preference" | "note") ?? "note",
            content: item.content.trim(),
            metadata: { source: "orchestrator", extractedAt: new Date().toISOString() },
          })
        );
      await Promise.all(storePromises);

      if (parsed.length > 0) {
        logger.debug({ count: parsed.length }, "Extracted memory entries from conversation");
      }
    } catch (err) {
      logger.warn({ err }, "Memory extraction AI call failed");
    }
  }

  // ── Internal helpers ───────────────────────────────────────

  private async _findOrCreateConversation(
    msg: PlatformMessage
  ): Promise<Conversation> {
    const { db } = this.opts;

    const [existing] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.platform, msg.platform),
          eq(conversations.platformChannelId, msg.channelId)
        )
      )
      .limit(1);

    if (existing) return existing;

    const [created] = await db
      .insert(conversations)
      .values({
        platform: msg.platform,
        platformUserId: msg.userId,
        platformUserName: msg.userName ?? null,
        platformChannelId: msg.channelId,
        platformGuildId: msg.guildId ?? null,
        messageCount: 0,
        metadata: {},
      })
      .returning();

    this.opts.logger.info(
      { conversationId: created.id, platform: msg.platform },
      "Created new conversation"
    );

    return created;
  }

  private async _loadHistory(conversationId: string): Promise<typeof messages.$inferSelect[]> {
    const { db } = this.opts;

    return db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt))
      .limit(HISTORY_WINDOW);
  }

  private async _insertMessage(
    msg: Omit<NewMessage, "id" | "createdAt">
  ): Promise<typeof messages.$inferSelect> {
    const [row] = await this.opts.db.insert(messages).values(msg).returning();
    return row;
  }

  /** Batch-insert multiple messages in a single round-trip to the DB. */
  private async _insertMessages(
    msgs: Array<Omit<NewMessage, "id" | "createdAt">>
  ): Promise<void> {
    if (msgs.length === 0) return;
    await this.opts.db.insert(messages).values(msgs);
  }

  private _collectTools(): AITool[] {
    // If a SkillEngine tools provider is wired, use it (supports hot-reload).
    if (this.toolsProvider) {
      return this.toolsProvider();
    }

    // Fallback: collect from the in-memory skills map.
    const tools: AITool[] = [];
    for (const skill of this.skills.values()) {
      for (const tool of skill.tools) {
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        });
      }
    }

    return tools;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createOrchestrator(opts: OrchestratorOptions): Orchestrator {
  return new Orchestrator(opts);
}
