/**
 * myEA — Web Chat API
 *
 *   POST /api/chat   — send a message from the admin UI, get a reply
 *
 * Creates or continues a "web" platform conversation and routes the message
 * through the Orchestrator exactly like any other platform connector.
 */

import { randomUUID } from "crypto";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { eq } from "drizzle-orm";
import type { DrizzleDB } from "../db";
import type { Orchestrator } from "../services/orchestrator";
import type { WSEvent } from "../types";
import { conversations } from "../db/schema";

interface ChatPluginOptions {
  db: DrizzleDB;
  orchestrator: Orchestrator;
  broadcast: (event: WSEvent) => void;
}

const chatPlugin: FastifyPluginAsync<ChatPluginOptions> = async (
  app: FastifyInstance,
  opts: ChatPluginOptions
) => {
  const { db, orchestrator, broadcast } = opts;

  // ── POST /api/chat ─────────────────────────────────────────

  app.post<{
    Body: {
      message: string;
      conversationId?: string;
      images?: Array<{ base64: string; mimeType: string }>;
    };
  }>(
    "/api/chat",
    {
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: "object",
          required: ["message"],
          properties: {
            message: { type: "string", minLength: 0, maxLength: 32768 },
            conversationId: { type: "string" },
            images: {
              type: "array",
              maxItems: 5,
              items: {
                type: "object",
                required: ["base64", "mimeType"],
                properties: {
                  base64: { type: "string" },
                  mimeType: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { message, conversationId, images } = request.body;

      // Resolve channelId: continue existing conversation or start a new one
      let channelId: string;
      if (conversationId) {
        const [conv] = await db
          .select({ platformChannelId: conversations.platformChannelId })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .limit(1);
        if (!conv) {
          return reply.status(404).send({ error: "Conversation not found" });
        }
        channelId = conv.platformChannelId;
      } else {
        // New conversation — each web chat session gets its own channelId
        channelId = `web-${randomUUID()}`;
      }

      const attachments = images?.map((img: { base64: string; mimeType: string }, idx: number) => ({
        id: `web-img-${idx}`,
        type: "image" as const,
        mimeType: img.mimeType,
        // Store the base64 data in the url field so AI providers can read it inline
        url: `data:${img.mimeType};base64,${img.base64}`,
      }));

      const inbound = {
        id: randomUUID(),
        platform: "web" as const,
        userId: "web-admin",
        userName: "Admin",
        channelId,
        text: message,
        timestamp: new Date().toISOString(),
        ...(attachments?.length ? { attachments } : {}),
      };

      try {
        const outbound = await orchestrator.handleInbound(inbound);

        // Find the conversation that was created/reused to return its ID
        const [conv] = await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.platformChannelId, channelId))
          .limit(1);

        const resolvedConversationId = conv?.id ?? conversationId ?? null;

        broadcast({
          type: "conversation_updated",
          payload: { conversationId: resolvedConversationId, platform: "web" },
        });

        return reply.send({
          conversationId: resolvedConversationId,
          reply: outbound.text,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.error({ err }, "Web chat orchestrator error");
        return reply.status(500).send({ error: "Chat failed", detail: message });
      }
    }
  );
};

export default fp(chatPlugin, {
  name: "chat",
  dependencies: ["auth"],
});
