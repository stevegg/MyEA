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
import { eq } from "drizzle-orm";
import type { DrizzleDB } from "../db";
import type { Orchestrator } from "../services/orchestrator";
import type { SkillEngine } from "../skills/engine";
import { skillsRegistry } from "../db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────────────

interface SkillsPluginOptions {
  db: DrizzleDB;
  orchestrator?: Orchestrator;
  /** Ref container — engine is assigned after plugin registration. */
  skillEngineRef?: { engine?: SkillEngine };
  /** Trigger a full reload of custom skills from disk. */
  reloadSkills?: () => Promise<void>;
}

const skillsPlugin: FastifyPluginAsync<SkillsPluginOptions> = async (
  app: FastifyInstance,
  opts: SkillsPluginOptions
) => {
  const { db } = opts;
  // skillEngine may be undefined at registration time; read via ref at request time
  const getEngine = () => opts.skillEngineRef?.engine;

  // ── GET /api/skills ────────────────────────────────────────
  // Read from in-memory engine if available (always up-to-date), fall back to DB.

  app.get(
    "/api/skills",
    { preHandler: [app.authenticate] },
    async (_request, reply) => {
      const skillEngine = getEngine();
      if (skillEngine) {
        const entries = skillEngine.getRegistry();
        // Merge with DB to pick up persisted `enabled` overrides
        const dbRows = await db.select().from(skillsRegistry);
        const enabledMap = new Map(dbRows.map((r) => [r.name, r.enabled]));
        const data = entries
          .map((e) => ({
            ...e,
            enabled: enabledMap.has(e.name) ? enabledMap.get(e.name)! : e.enabled,
          }))
          .sort((a, b) => (b.builtIn ? 1 : 0) - (a.builtIn ? 1 : 0) || a.name.localeCompare(b.name));
        return reply.send({ data, total: data.length });
      }

      // Fallback: read from DB
      const rows = await db.select().from(skillsRegistry);
      rows.sort((a, b) => (b.builtIn ? 1 : 0) - (a.builtIn ? 1 : 0) || a.name.localeCompare(b.name));
      return reply.send({ data: rows.map(formatSkill), total: rows.length });
    }
  );

  // ── GET /api/skills/:name ──────────────────────────────────

  app.get<{ Params: { name: string } }>(
    "/api/skills/:name",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { name } = request.params;

      const skillEngine = getEngine();
      if (skillEngine) {
        const entry = skillEngine.getRegistry().find((e) => e.name === name);
        if (!entry) {
          return reply.status(404).send({ error: `Skill "${name}" not found` });
        }
        // Merge DB-persisted enabled state
        const [dbRow] = await db.select().from(skillsRegistry).where(eq(skillsRegistry.name, name)).limit(1);
        return reply.send({ ...entry, enabled: dbRow ? dbRow.enabled : entry.enabled });
      }

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
      const skillEngine = getEngine();

      // Check the skill exists (in engine or DB)
      const entry = skillEngine?.getRegistry().find((e) => e.name === name);
      if (!entry) {
        const [existing] = await db.select().from(skillsRegistry).where(eq(skillsRegistry.name, name)).limit(1);
        if (!existing) {
          return reply.status(404).send({ error: `Skill "${name}" not found` });
        }
      }

      // Persist the enabled state to DB (upsert)
      await db
        .insert(skillsRegistry)
        .values({
          id: entry?.id ?? name,
          name,
          description: entry?.description ?? "",
          version: entry?.version ?? "0.0.0",
          filePath: entry?.filePath ?? null,
          enabled,
          builtIn: entry?.builtIn ?? false,
          tools: (entry?.tools ?? []) as any,
          loadedAt: entry?.loadedAt ? new Date(entry.loadedAt) : new Date(),
        })
        .onConflictDoUpdate({
          target: skillsRegistry.name,
          set: { enabled, updatedAt: new Date() },
        });

      // Also update the in-memory engine state
      skillEngine?.setEnabled(name, enabled);

      request.log.info({ name, enabled }, "Skill toggled via PATCH");
      return reply.send({ ...(entry ?? { name }), enabled });
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
      const skillEngine = getEngine();

      const entry = skillEngine?.getRegistry().find((e) => e.name === name);
      if (!entry) {
        const [existing] = await db.select().from(skillsRegistry).where(eq(skillsRegistry.name, name)).limit(1);
        if (!existing) {
          return reply.status(404).send({ error: `Skill "${name}" not found` });
        }
      }

      await db
        .insert(skillsRegistry)
        .values({
          id: entry?.id ?? name,
          name,
          description: entry?.description ?? "",
          version: entry?.version ?? "0.0.0",
          filePath: entry?.filePath ?? null,
          enabled,
          builtIn: entry?.builtIn ?? false,
          tools: (entry?.tools ?? []) as any,
          loadedAt: entry?.loadedAt ? new Date(entry.loadedAt) : new Date(),
        })
        .onConflictDoUpdate({
          target: skillsRegistry.name,
          set: { enabled, updatedAt: new Date() },
        });

      skillEngine?.setEnabled(name, enabled);

      request.log.info({ name, enabled }, "Skill toggled");
      return reply.send({ ...(entry ?? { name }), enabled });
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
