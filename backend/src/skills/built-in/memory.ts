/**
 * myEA — Built-in Skill: Memory Management
 *
 * Gives the AI first-class tools for reading and writing to the persistent
 * memory store. The MemoryService is injected at setup time and keeps the
 * implementation decoupled from the underlying storage backend (currently
 * PostgreSQL full-text search, future: pgvector semantic search).
 *
 * Tools exposed to the AI:
 *
 *   remember              — store a named fact, preference, or note
 *   recall                — retrieve a memory by its unique key
 *   search_memory         — full-text search across all stored memories
 *   forget                — permanently delete a memory entry by key
 *   list_memories         — list all memories, with optional category filter
 *   summarize_conversation — summarise a recent conversation and store as memory
 */

import type {
  Skill,
  SkillContext,
  ExecutionContext,
  ToolResult,
  MemoryService,
  MemoryEntry,
  MemoryEntryType,
} from "../../types";
import { getErrorMessage, BUILT_IN_SKILL_VERSION } from "../../utils";

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────────────────────────

let _memory: MemoryService | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Key → ID index
//
// The MemoryService interface does not have a built-in concept of a "key" — it
// uses opaque UUIDs. We store the caller-chosen key inside the metadata field
// and retrieve it by running a search. This is fast enough for the expected
// cardinality (hundreds of entries).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find a memory entry whose metadata.key matches the provided key string.
 * Returns null if not found.
 */
async function findByKey(key: string): Promise<MemoryEntry | null> {
  if (!_memory) return null;
  // Search by key; since FTS matches against content we also include the key
  // in the content field as a prefix so it is reliably indexed.
  const results = await _memory.search({ query: key, limit: 20 });
  return results.find((e) => (e.metadata as Record<string, unknown>)["key"] === key) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────────────────────────────────────

async function remember(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { key, value, category } = params as {
    key: string;
    value: string;
    category?: MemoryEntryType;
  };

  if (!_memory) return { content: "Memory service unavailable.", isError: true };

  try {
    // Upsert: if an entry with this key already exists, update it
    const existing = await findByKey(key);

    // Encode the key into the content as a prefix so the FTS index can find it
    // during subsequent recall/search calls.
    const content = `[${key}] ${value}`;

    let entry: MemoryEntry;
    if (existing) {
      entry = await _memory.update(existing.id, {
        content,
        metadata: { ...(existing.metadata as Record<string, unknown>), key, category: category ?? existing.metadata["category"] ?? "note" },
      });
    } else {
      entry = await _memory.store({
        type: (category ?? "note") as MemoryEntryType,
        content,
        metadata: { key, category: category ?? "note", source: "memory_skill" },
      });
    }

    return {
      content: `Memory stored: key="${key}", value="${value}"${category ? `, category="${category}"` : ""}.`,
      data: { id: entry.id, key, value, category: category ?? "note" },
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to store memory: ${msg}`, isError: true };
  }
}

async function recall(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { key } = params as { key: string };

  if (!_memory) return { content: "Memory service unavailable.", isError: true };

  try {
    const entry = await findByKey(key);

    if (!entry) {
      return {
        content: `No memory found for key "${key}".`,
        data: { key, found: false },
      };
    }

    // Strip the [key] prefix we added in remember()
    const rawContent = entry.content.startsWith(`[${key}] `)
      ? entry.content.slice(`[${key}] `.length)
      : entry.content;

    return {
      content: `Memory for "${key}": ${rawContent}`,
      data: { id: entry.id, key, value: rawContent, type: entry.type, createdAt: entry.createdAt, updatedAt: entry.updatedAt },
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to recall memory: ${msg}`, isError: true };
  }
}

async function searchMemory(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { query } = params as { query: string };

  if (!_memory) return { content: "Memory service unavailable.", isError: true };

  try {
    const results = await _memory.search({ query, limit: 20 });

    if (results.length === 0) {
      return {
        content: `No memories found matching "${query}".`,
        data: { query, results: [] },
      };
    }

    const lines = results.map((e) => {
      const meta = e.metadata as Record<string, unknown>;
      const key = meta["key"] as string | undefined;
      // Strip the [key] prefix from the displayed content if present
      const displayContent =
        key && e.content.startsWith(`[${key}] `)
          ? e.content.slice(`[${key}] `.length)
          : e.content;
      const score = e.score !== undefined ? ` (score: ${e.score.toFixed(2)})` : "";
      return `• ${key ? `[${key}] ` : ""}${displayContent}${score}`;
    });

    return {
      content: `Found ${results.length} memories matching "${query}":\n${lines.join("\n")}`,
      data: {
        query,
        results: results.map((e) => {
          const meta = e.metadata as Record<string, unknown>;
          const key = meta["key"] as string | undefined;
          const displayContent =
            key && e.content.startsWith(`[${key}] `)
              ? e.content.slice(`[${key}] `.length)
              : e.content;
          return { id: e.id, key, value: displayContent, type: e.type, score: e.score };
        }),
      },
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Memory search failed: ${msg}`, isError: true };
  }
}

async function forget(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { key } = params as { key: string };

  if (!_memory) return { content: "Memory service unavailable.", isError: true };

  try {
    const entry = await findByKey(key);

    if (!entry) {
      return {
        content: `No memory found for key "${key}". Nothing deleted.`,
        data: { key, deleted: false },
      };
    }

    await _memory.delete(entry.id);

    return {
      content: `Memory "${key}" has been deleted.`,
      data: { key, deleted: true, id: entry.id },
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to delete memory: ${msg}`, isError: true };
  }
}

async function listMemories(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { category } = params as { category?: MemoryEntryType };

  if (!_memory) return { content: "Memory service unavailable.", isError: true };

  try {
    // Search with a broad query or filter by category.
    // We use a wildcard-like approach: search for a space character which
    // matches virtually all entries, then optionally filter by type.
    const results = await _memory.search({
      query: category ? category : " ",
      type: category,
      limit: 200,
    });

    if (results.length === 0) {
      return {
        content: category ? `No memories in category "${category}".` : "No memories stored.",
        data: { category, results: [] },
      };
    }

    const lines = results.map((e) => {
      const meta = e.metadata as Record<string, unknown>;
      const key = meta["key"] as string | undefined;
      const displayContent =
        key && e.content.startsWith(`[${key}] `)
          ? e.content.slice(`[${key}] `.length)
          : e.content;
      const truncated = displayContent.length > 120 ? displayContent.slice(0, 120) + "…" : displayContent;
      return `• [${e.type}]${key ? ` ${key}:` : ""} ${truncated}`;
    });

    const heading = category
      ? `Memories in category "${category}" (${results.length}):`
      : `All memories (${results.length}):`;

    return {
      content: `${heading}\n${lines.join("\n")}`,
      data: {
        category,
        total: results.length,
        memories: results.map((e) => {
          const meta = e.metadata as Record<string, unknown>;
          const key = meta["key"] as string | undefined;
          const displayContent =
            key && e.content.startsWith(`[${key}] `)
              ? e.content.slice(`[${key}] `.length)
              : e.content;
          return { id: e.id, key, value: displayContent, type: e.type, createdAt: e.createdAt };
        }),
      },
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to list memories: ${msg}`, isError: true };
  }
}

async function summarizeConversation(params: unknown, ctx: ExecutionContext): Promise<ToolResult> {
  const { conversationId } = params as { conversationId?: string };

  if (!_memory) return { content: "Memory service unavailable.", isError: true };

  try {
    // Use the active conversation ID if none was provided
    const targetId = conversationId ?? ctx.conversationId;

    if (!targetId) {
      return {
        content: "No conversation ID available to summarize.",
        isError: true,
      };
    }

    // Retrieve recent messages from the DB via the DatabaseService
    const db = ctx.db.db as import("../../db").DrizzleDB;
    const { messages, conversations } = await import("../../db/schema");
    const { eq, desc } = await import("drizzle-orm");

    // Fetch the last 40 messages from the conversation
    const rows = await db
      .select({
        role: messages.role,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, targetId))
      .orderBy(desc(messages.createdAt))
      .limit(40);

    if (rows.length === 0) {
      return {
        content: "No messages found in this conversation to summarize.",
        data: { conversationId: targetId, summarized: false },
      };
    }

    // Reverse so messages are in chronological order
    const chronological = [...rows].reverse();

    // Build a plain-text transcript (truncated for sanity)
    const transcript = chronological
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 500)}`)
      .join("\n");

    // Create a deterministic key for this conversation's summary
    const summaryKey = `conversation_summary_${targetId.slice(0, 8)}`;

    // Fetch conversation metadata for context
    const [conv] = await db
      .select({ platform: conversations.platform, platformUserId: conversations.platformUserId })
      .from(conversations)
      .where(eq(conversations.id, targetId))
      .limit(1);

    const platformNote = conv ? ` (${conv.platform} user: ${conv.platformUserId})` : "";

    // Store the raw transcript as a summary memory — the AI will later read
    // this as context. A more advanced implementation would call the AI to
    // produce a condensed summary first.
    const summaryContent =
      `Conversation summary${platformNote}, ${chronological.length} messages (${new Date(chronological[0].createdAt).toISOString()} – ${new Date(chronological[chronological.length - 1].createdAt).toISOString()}):\n\n` +
      transcript.slice(0, 3000) +
      (transcript.length > 3000 ? "\n\n[...truncated]" : "");

    const existing = await findByKey(summaryKey);

    let stored: MemoryEntry;
    if (existing) {
      stored = await _memory.update(existing.id, {
        content: `[${summaryKey}] ${summaryContent}`,
        metadata: {
          ...(existing.metadata as Record<string, unknown>),
          key: summaryKey,
          conversationId: targetId,
          messageCount: chronological.length,
          updatedAt: new Date().toISOString(),
        },
      });
    } else {
      stored = await _memory.store({
        type: "summary",
        content: `[${summaryKey}] ${summaryContent}`,
        metadata: {
          key: summaryKey,
          conversationId: targetId,
          messageCount: chronological.length,
          source: "memory_skill",
        },
      });
    }

    return {
      content: `Conversation summarized and stored as memory "${summaryKey}" (${chronological.length} messages).`,
      data: {
        id: stored.id,
        key: summaryKey,
        conversationId: targetId,
        messageCount: chronological.length,
      },
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to summarize conversation: ${msg}`, isError: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill definition
// ─────────────────────────────────────────────────────────────────────────────

const memorySkill: Skill = {
  name: "memory",
  description:
    "Store, retrieve, search, and manage persistent memories. Use this to remember facts, user preferences, conversation summaries, and notes across sessions.",
  version: BUILT_IN_SKILL_VERSION,

  async setup(context: SkillContext): Promise<void> {
    _memory = context.memory;
    context.logger.info("Memory skill ready.");
  },

  async teardown(): Promise<void> {
    _memory = null;
  },

  tools: [
    {
      name: "remember",
      description:
        "Store a named memory. If a memory with the same key already exists it will be updated. Use a clear, specific key so you can recall it later.",
      parameters: {
        type: "object",
        required: ["key", "value"],
        properties: {
          key: {
            type: "string",
            description:
              "A unique identifier for this memory, e.g. \"user_name\", \"preferred_language\", \"project_deadline\".",
          },
          value: {
            type: "string",
            description: "The information to store.",
          },
          category: {
            type: "string",
            enum: ["fact", "preference", "summary", "context", "note"],
            description:
              "Category of the memory (default: note). Use 'preference' for user preferences, 'fact' for objective facts, 'summary' for conversation summaries.",
          },
        },
      },
      execute: remember,
    },

    {
      name: "recall",
      description: "Retrieve a specific memory by its key. Returns the stored value if found.",
      parameters: {
        type: "object",
        required: ["key"],
        properties: {
          key: {
            type: "string",
            description: "The key used when the memory was stored.",
          },
        },
      },
      execute: recall,
    },

    {
      name: "search_memory",
      description:
        "Full-text search across all stored memories. Useful when you don't know the exact key but remember part of the content.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Search terms to match against stored memory content.",
          },
        },
      },
      execute: searchMemory,
    },

    {
      name: "forget",
      description: "Permanently delete a memory entry by its key.",
      parameters: {
        type: "object",
        required: ["key"],
        properties: {
          key: {
            type: "string",
            description: "The key of the memory to delete.",
          },
        },
      },
      execute: forget,
    },

    {
      name: "list_memories",
      description:
        "List all stored memories, optionally filtered by category. Returns keys and truncated values.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["fact", "preference", "summary", "context", "note"],
            description:
              "Only return memories of this category. Omit to list all memories.",
          },
        },
      },
      execute: listMemories,
    },

    {
      name: "summarize_conversation",
      description:
        "Summarize the recent conversation and store it as a summary memory for future context. Call this at the end of long conversations.",
      parameters: {
        type: "object",
        properties: {
          conversationId: {
            type: "string",
            description:
              "The conversation UUID to summarize. Defaults to the current active conversation.",
          },
        },
      },
      execute: summarizeConversation,
    },
  ],
};

export default memorySkill;
