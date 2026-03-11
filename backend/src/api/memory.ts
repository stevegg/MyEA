/**
 * myEA — Memory API Routes
 *
 *   GET    /api/memory                 — paginated list of all active memory entries
 *   POST   /api/memory                 — manually add a memory entry
 *   PUT    /api/memory/:id             — update an existing entry
 *   DELETE /api/memory/:id             — delete an entry
 *   GET    /api/memory/search?q=...    — full-text search
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { MemoryService, MemoryEntryType } from "../types";
import { parsePagination } from "../utils";

// ─────────────────────────────────────────────────────────────────────────────
// Plugin options
// ─────────────────────────────────────────────────────────────────────────────

interface MemoryPluginOptions {
  memory: MemoryService & {
    getAll(limit?: number, offset?: number): Promise<{ entries: import("../types").MemoryEntry[]; total: number }>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────────────

const memoryPlugin: FastifyPluginAsync<MemoryPluginOptions> = async (
  app: FastifyInstance,
  opts: MemoryPluginOptions
) => {
  const { memory } = opts;

  // ── GET /api/memory/search — must be registered before /:id ───

  app.get<{ Querystring: { q?: string; type?: string; limit?: string } }>(
    "/api/memory/search",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const q = request.query.q?.trim();
      if (!q) {
        return reply.status(400).send({ error: 'Query parameter "q" is required' });
      }

      const limit = Math.min(parseInt(request.query.limit ?? "20", 10), 100);
      const type = request.query.type as MemoryEntryType | undefined;

      const entries = await memory.search({ query: q, type, limit });
      return reply.send({ data: entries, query: q, total: entries.length });
    }
  );

  // ── GET /api/memory ────────────────────────────────────────

  app.get<{ Querystring: { limit?: string; offset?: string; type?: string } }>(
    "/api/memory",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const limit = Math.min(parseInt(request.query.limit ?? "50", 10), 200);
      const offset = Math.max(parseInt(request.query.offset ?? "0", 10), 0);

      const { entries, total } = await memory.getAll(limit, offset);
      return reply.send({ data: entries, pagination: { limit, offset, total } });
    }
  );

  // ── POST /api/memory ───────────────────────────────────────

  app.post<{
    Body: {
      type?: MemoryEntryType;
      content: string;
      metadata?: Record<string, unknown>;
      expiresAt?: string;
    };
  }>(
    "/api/memory",
    {
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: "object",
          required: ["content"],
          properties: {
            type: { type: "string", enum: ["fact", "preference", "summary", "context", "note"] },
            content: { type: "string", minLength: 1 },
            metadata: { type: "object" },
            expiresAt: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { type = "note", content, metadata = {}, expiresAt } = request.body;

      const entry = await memory.store({
        type,
        content,
        metadata: { ...metadata, source: "api", createdBy: "admin" },
        expiresAt,
      });

      request.log.info({ id: entry.id, type }, "Memory entry created via API");
      return reply.status(201).send(entry);
    }
  );

  // ── PUT /api/memory/:id ────────────────────────────────────

  app.put<{
    Params: { id: string };
    Body: {
      content?: string;
      metadata?: Record<string, unknown>;
      expiresAt?: string | null;
    };
  }>(
    "/api/memory/:id",
    {
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: "object",
          properties: {
            content: { type: "string", minLength: 1 },
            metadata: { type: "object" },
            expiresAt: { type: ["string", "null"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      // Verify the entry exists
      const existing = await memory.get(id);
      if (!existing) {
        return reply.status(404).send({ error: "Memory entry not found" });
      }

      const patch: Partial<Pick<import("../types").MemoryEntry, "content" | "metadata" | "expiresAt">> = {};
      if (request.body.content !== undefined) patch.content = request.body.content;
      if (request.body.metadata !== undefined) patch.metadata = request.body.metadata;
      if (request.body.expiresAt !== undefined) patch.expiresAt = request.body.expiresAt ?? undefined;

      const updated = await memory.update(id, patch);
      return reply.send(updated);
    }
  );

  // ── DELETE /api/memory/:id ─────────────────────────────────

  app.delete<{ Params: { id: string } }>(
    "/api/memory/:id",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params;

      const existing = await memory.get(id);
      if (!existing) {
        return reply.status(404).send({ error: "Memory entry not found" });
      }

      await memory.delete(id);
      request.log.info({ id }, "Memory entry deleted via API");
      return reply.status(204).send();
    }
  );

  // ── POST /api/memory/prune — utility endpoint ──────────────

  app.post(
    "/api/memory/prune",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const count = await memory.pruneExpired();
      return reply.send({ pruned: count });
    }
  );
};

export default fp(memoryPlugin, {
  name: "memory-routes",
  dependencies: ["auth"],
});
