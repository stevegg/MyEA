/**
 * myEA — Conversations API Routes
 *
 *   GET    /api/conversations              — paginated list
 *   GET    /api/conversations/:id          — single conversation with messages
 *   DELETE /api/conversations/:id          — delete conversation + cascade messages
 *   GET    /api/conversations/:id/messages — paginated message history
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { eq, desc, asc, count, and } from "drizzle-orm";
import type { DrizzleDB } from "../db";
import { conversations, messages } from "../db/schema";
import { parsePagination } from "../utils";

// ─────────────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────────────

interface ConversationsPluginOptions {
  db: DrizzleDB;
}

const conversationsPlugin: FastifyPluginAsync<ConversationsPluginOptions> = async (
  app: FastifyInstance,
  opts: ConversationsPluginOptions
) => {
  const { db } = opts;

  // ── GET /api/conversations ─────────────────────────────────

  app.get<{ Querystring: { limit?: string; offset?: string; platform?: string } }>(
    "/api/conversations",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { limit, offset } = parsePagination(request.query);

      const query = db
        .select()
        .from(conversations)
        .orderBy(desc(conversations.updatedAt))
        .limit(limit)
        .offset(offset);

      const [rows, [{ value: total }]] = await Promise.all([
        query,
        db.select({ value: count() }).from(conversations),
      ]);

      return reply.send({
        data: rows.map((r) => ({
          id: r.id,
          platform: r.platform,
          platformUserId: r.platformUserId,
          platformUserName: r.platformUserName,
          platformChannelId: r.platformChannelId,
          platformGuildId: r.platformGuildId,
          messageCount: r.messageCount,
          metadata: r.metadata,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
        pagination: { limit, offset, total: Number(total) },
      });
    }
  );

  // ── GET /api/conversations/:id ─────────────────────────────

  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params;

      const [conv] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1);

      if (!conv) {
        return reply.status(404).send({ error: "Conversation not found" });
      }

      // Include the last 50 messages inline
      const msgs = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, id))
        .orderBy(asc(messages.createdAt))
        .limit(50);

      return reply.send({
        id: conv.id,
        platform: conv.platform,
        platformUserId: conv.platformUserId,
        platformUserName: conv.platformUserName,
        platformChannelId: conv.platformChannelId,
        platformGuildId: conv.platformGuildId,
        messageCount: conv.messageCount,
        metadata: conv.metadata,
        createdAt: conv.createdAt.toISOString(),
        updatedAt: conv.updatedAt.toISOString(),
        messages: msgs.map(formatMessage),
      });
    }
  );

  // ── DELETE /api/conversations/:id ──────────────────────────

  app.delete<{ Params: { id: string } }>(
    "/api/conversations/:id",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params;

      const [existing] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({ error: "Conversation not found" });
      }

      // Cascade to messages is handled by the FK constraint
      await db.delete(conversations).where(eq(conversations.id, id));

      request.log.info({ conversationId: id }, "Conversation deleted");
      return reply.status(204).send();
    }
  );

  // ── GET /api/conversations/:id/messages ────────────────────

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/api/conversations/:id/messages",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params;
      const { limit, offset } = parsePagination(request.query);

      // Verify conversation exists
      const [conv] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1);

      if (!conv) {
        return reply.status(404).send({ error: "Conversation not found" });
      }

      const [rows, [{ value: total }]] = await Promise.all([
        db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, id))
          .orderBy(asc(messages.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ value: count() })
          .from(messages)
          .where(eq(messages.conversationId, id)),
      ]);

      return reply.send({
        data: rows.map(formatMessage),
        pagination: { limit, offset, total: Number(total) },
      });
    }
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatMessage(m: typeof messages.$inferSelect) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    platform: m.platform,
    toolName: m.toolName,
    toolCallId: m.toolCallId,
    aiProvider: m.aiProvider,
    aiModel: m.aiModel,
    tokenUsage: m.tokenUsage,
    platformMessageId: m.platformMessageId,
    createdAt: m.createdAt.toISOString(),
  };
}

export default fp(conversationsPlugin, {
  name: "conversations",
  dependencies: ["auth"],
});
