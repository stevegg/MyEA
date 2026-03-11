/**
 * myEA — Skills API Routes
 *
 *   GET    /api/skills               — list all skills (DB registry) with status
 *   GET    /api/skills/:name         — single skill with tool details
 *   PUT    /api/skills/:name/toggle  — enable or disable a skill
 *   POST   /api/skills/reload        — signal hot-reload of all custom skills
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { eq, desc } from "drizzle-orm";
import type { DrizzleDB } from "../db";
import type { Orchestrator } from "../services/orchestrator";
import { skillsRegistry } from "../db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────────────

interface SkillsPluginOptions {
  db: DrizzleDB;
  orchestrator?: Orchestrator;
  /** Trigger a full reload of custom skills from disk. */
  reloadSkills?: () => Promise<void>;
}

const skillsPlugin: FastifyPluginAsync<SkillsPluginOptions> = async (
  app: FastifyInstance,
  opts: SkillsPluginOptions
) => {
  const { db } = opts;

  // ── GET /api/skills ────────────────────────────────────────

  app.get(
    "/api/skills",
    { preHandler: [app.authenticate] },
    async (_request, reply) => {
      const rows = await db
        .select()
        .from(skillsRegistry)
        .orderBy(desc(skillsRegistry.builtIn), skillsRegistry.name);

      return reply.send({
        data: rows.map(formatSkill),
        total: rows.length,
      });
    }
  );

  // ── GET /api/skills/:name ──────────────────────────────────

  app.get<{ Params: { name: string } }>(
    "/api/skills/:name",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { name } = request.params;

      const [row] = await db
        .select()
        .from(skillsRegistry)
        .where(eq(skillsRegistry.name, name))
        .limit(1);

      if (!row) {
        return reply.status(404).send({ error: `Skill "${name}" not found` });
      }

      return reply.send(formatSkill(row));
    }
  );

  // ── PATCH /api/skills/:name ────────────────────────────────
  // Accepts { enabled: boolean } — used by the admin UI toggle.

  app.patch<{ Params: { name: string }; Body: { enabled: boolean } }>(
    "/api/skills/:name",
    {
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: "object",
          required: ["enabled"],
          properties: {
            enabled: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const { name } = request.params;
      const { enabled } = request.body;

      const [existing] = await db
        .select()
        .from(skillsRegistry)
        .where(eq(skillsRegistry.name, name))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({ error: `Skill "${name}" not found` });
      }

      const [updated] = await db
        .update(skillsRegistry)
        .set({ enabled, updatedAt: new Date() })
        .where(eq(skillsRegistry.name, name))
        .returning();

      request.log.info({ name, enabled }, "Skill toggled via PATCH");
      return reply.send(formatSkill(updated));
    }
  );

  // ── PUT /api/skills/:name/toggle ───────────────────────────

  app.put<{ Params: { name: string }; Body: { enabled: boolean } }>(
    "/api/skills/:name/toggle",
    {
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: "object",
          required: ["enabled"],
          properties: {
            enabled: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const { name } = request.params;
      const { enabled } = request.body;

      const [existing] = await db
        .select()
        .from(skillsRegistry)
        .where(eq(skillsRegistry.name, name))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({ error: `Skill "${name}" not found` });
      }

      const [updated] = await db
        .update(skillsRegistry)
        .set({ enabled, updatedAt: new Date() })
        .where(eq(skillsRegistry.name, name))
        .returning();

      request.log.info({ name, enabled }, "Skill toggled");
      return reply.send(formatSkill(updated));
    }
  );

  // ── POST /api/skills/reload ────────────────────────────────

  app.post(
    "/api/skills/reload",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (opts.reloadSkills) {
        try {
          await opts.reloadSkills();
          request.log.info("Skills reload triggered via API");
          return reply.send({ message: "Skills reload initiated" });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return reply.status(500).send({ error: "Reload failed", detail: message });
        }
      }

      return reply.send({
        message: "Reload not available — skill hot-loader handles file changes automatically via chokidar",
      });
    }
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatSkill(row: typeof skillsRegistry.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    filePath: row.filePath,
    enabled: row.enabled,
    builtIn: row.builtIn,
    tools: row.tools ?? [],
    loadError: row.loadError,
    loadedAt: row.loadedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default fp(skillsPlugin, {
  name: "skills-routes",
  dependencies: ["auth"],
});
