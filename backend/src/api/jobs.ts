/**
 * myEA — Scheduled Jobs API Routes
 *
 *   GET    /api/jobs        — list all scheduled jobs
 *   POST   /api/jobs        — create a new job (cron or one-shot)
 *   PUT    /api/jobs/:id    — update a job (cancel + reschedule)
 *   DELETE /api/jobs/:id    — cancel a job
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { eq } from "drizzle-orm";
import type { DrizzleDB } from "../db";
import type { SchedulerService, Platform } from "../types";
import { scheduledJobs } from "../db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────────────

interface JobsPluginOptions {
  db: DrizzleDB;
  scheduler: SchedulerService;
}

const jobsPlugin: FastifyPluginAsync<JobsPluginOptions> = async (
  app: FastifyInstance,
  opts: JobsPluginOptions
) => {
  const { db, scheduler } = opts;

  // ── GET /api/jobs ──────────────────────────────────────────

  app.get<{ Querystring: { enabled?: string } }>(
    "/api/jobs",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const jobs = await scheduler.list();

      // Optional filter by enabled state
      const enabledFilter = request.query.enabled;
      const filtered =
        enabledFilter === undefined
          ? jobs
          : jobs.filter((j) => j.enabled === (enabledFilter === "true"));

      return reply.send({ data: filtered, total: filtered.length });
    }
  );

  // ── POST /api/jobs ─────────────────────────────────────────

  app.post<{
    Body: {
      name: string;
      description?: string;
      schedule: string;
      recurring: boolean;
      payload?: Record<string, unknown>;
      targetPlatform?: Platform;
      targetChannelId?: string;
    };
  }>(
    "/api/jobs",
    {
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: "object",
          required: ["name", "schedule", "recurring"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 128 },
            description: { type: "string" },
            schedule: { type: "string", minLength: 1 },
            recurring: { type: "boolean" },
            payload: { type: "object" },
            targetPlatform: {
              type: "string",
              enum: ["telegram", "discord", "slack", "whatsapp", "signal", "internal"],
            },
            targetChannelId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const {
        name,
        description,
        schedule,
        recurring,
        payload = {},
        targetPlatform,
        targetChannelId,
      } = request.body;

      // Merge target platform into payload for the scheduler handlers
      const fullPayload: Record<string, unknown> = {
        ...payload,
        ...(targetPlatform ? { platform: targetPlatform } : {}),
        ...(targetChannelId ? { channelId: targetChannelId } : {}),
      };

      let jobId: string;

      if (recurring) {
        // Validate as cron expression (basic check)
        const cronParts = schedule.trim().split(/\s+/);
        if (cronParts.length < 5 || cronParts.length > 6) {
          return reply.status(400).send({
            error: "Invalid cron expression. Expected 5 or 6 space-separated fields.",
          });
        }
        jobId = await scheduler.scheduleCron(name, schedule, fullPayload);
      } else {
        // One-shot: schedule must be an ISO-8601 datetime
        const runAt = new Date(schedule);
        if (isNaN(runAt.getTime())) {
          return reply.status(400).send({
            error: "Invalid schedule. One-shot jobs require an ISO-8601 datetime string.",
          });
        }
        if (runAt <= new Date()) {
          return reply.status(400).send({
            error: "Scheduled time must be in the future.",
          });
        }
        jobId = await scheduler.scheduleOnce(name, runAt, fullPayload);
      }

      // Update the description if provided
      if (description) {
        await db
          .update(scheduledJobs)
          .set({ description, updatedAt: new Date() })
          .where(eq(scheduledJobs.id, jobId));
      }

      request.log.info({ jobId, name, recurring }, "Scheduled job created via API");

      const [row] = await db
        .select()
        .from(scheduledJobs)
        .where(eq(scheduledJobs.id, jobId))
        .limit(1);

      return reply.status(201).send(formatJob(row));
    }
  );

  // ── PUT /api/jobs/:id ──────────────────────────────────────

  app.put<{
    Params: { id: string };
    Body: {
      description?: string;
      schedule?: string;
      payload?: Record<string, unknown>;
      enabled?: boolean;
      targetPlatform?: Platform;
      targetChannelId?: string;
    };
  }>(
    "/api/jobs/:id",
    {
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: "object",
          properties: {
            description: { type: "string" },
            schedule: { type: "string" },
            payload: { type: "object" },
            enabled: { type: "boolean" },
            targetPlatform: { type: "string" },
            targetChannelId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { description, schedule, payload, enabled, targetPlatform, targetChannelId } =
        request.body;

      const [existing] = await db
        .select()
        .from(scheduledJobs)
        .where(eq(scheduledJobs.id, id))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({ error: "Scheduled job not found" });
      }

      // If schedule is changing, cancel the old job and reschedule
      if (schedule && schedule !== existing.schedule) {
        // Cancel the existing pg-boss job
        try {
          await scheduler.cancel(id);
        } catch {
          // May already be completed for one-shot jobs
        }

        const newPayload = payload ?? (existing.payload as Record<string, unknown>);

        let newJobId: string;
        if (existing.recurring) {
          newJobId = await scheduler.scheduleCron(existing.name, schedule, newPayload);
        } else {
          const runAt = new Date(schedule);
          if (isNaN(runAt.getTime())) {
            return reply.status(400).send({ error: "Invalid schedule datetime" });
          }
          // For one-shot jobs, existing.name has a UUID suffix (e.g. "reminder:one-shot:UUID").
          // The actual pg-boss queue name is stored in the payload under _pgBossQueueName.
          // Fall back to stripping the UUID suffix if that field is absent.
          const existingPayloadObj = (existing.payload as Record<string, unknown>) ?? {};
          const pgBossQueueName =
            (existingPayloadObj._pgBossQueueName as string | undefined) ??
            existing.name.replace(/:[0-9a-f-]{36}$/, "");
          newJobId = await scheduler.scheduleOnce(pgBossQueueName, runAt, newPayload);
        }

        // The new row was inserted; delete the old one
        if (newJobId !== id) {
          await db.delete(scheduledJobs).where(eq(scheduledJobs.id, id));
        }

        const [row] = await db
          .select()
          .from(scheduledJobs)
          .where(eq(scheduledJobs.id, newJobId))
          .limit(1);

        return reply.send(formatJob(row));
      }

      // Otherwise just update fields in place
      const updateValues: Partial<typeof scheduledJobs.$inferInsert> = { updatedAt: new Date() };
      if (description !== undefined) updateValues.description = description;
      if (payload !== undefined) updateValues.payload = payload;
      if (enabled !== undefined) updateValues.enabled = enabled;
      if (targetPlatform !== undefined) updateValues.targetPlatform = targetPlatform;
      if (targetChannelId !== undefined) updateValues.targetChannelId = targetChannelId;

      const [updated] = await db
        .update(scheduledJobs)
        .set(updateValues)
        .where(eq(scheduledJobs.id, id))
        .returning();

      return reply.send(formatJob(updated));
    }
  );

  // ── DELETE /api/jobs/:id ───────────────────────────────────

  app.delete<{ Params: { id: string } }>(
    "/api/jobs/:id",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params;

      const [existing] = await db
        .select({ id: scheduledJobs.id })
        .from(scheduledJobs)
        .where(eq(scheduledJobs.id, id))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({ error: "Scheduled job not found" });
      }

      await scheduler.cancel(id);
      await db.delete(scheduledJobs).where(eq(scheduledJobs.id, id));

      request.log.info({ jobId: id }, "Scheduled job cancelled and deleted");
      return reply.status(204).send();
    }
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatJob(row: typeof scheduledJobs.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    schedule: row.schedule,
    recurring: row.recurring,
    payload: row.payload,
    targetPlatform: row.targetPlatform,
    targetChannelId: row.targetChannelId,
    enabled: row.enabled,
    pgBossJobId: row.pgBossJobId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastError: row.lastError,
  };
}

export default fp(jobsPlugin, {
  name: "jobs-routes",
  dependencies: ["auth"],
});
