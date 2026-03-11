/**
 * myEA — Scheduler Service
 *
 * Wraps pg-boss to provide a typed, database-backed job queue. Supports both
 * cron recurring jobs and one-shot "run at this datetime" jobs. Job definitions
 * are also mirrored into the `scheduled_jobs` table so the admin UI can display
 * and manage them without reading pg-boss internal tables directly.
 *
 * Built-in job types:
 *   SEND_MESSAGE  — deliver a proactive message to the user on a platform
 *   RUN_SKILL     — invoke a named skill tool with a payload
 *   REMINDER      — convenience wrapper around SEND_MESSAGE
 */

import PgBoss from "pg-boss";
import { eq, desc } from "drizzle-orm";
import type {
  SchedulerService,
  ScheduledJob,
  JobHandler,
  Platform,
  Logger,
  OutboundMessage,
} from "../types";
import type { DrizzleDB } from "../db";
import { scheduledJobs } from "../db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Job type constants
// ─────────────────────────────────────────────────────────────────────────────

export const JOB_TYPE = {
  SEND_MESSAGE: "SEND_MESSAGE",
  RUN_SKILL: "RUN_SKILL",
  REMINDER: "REMINDER",
} as const;

export type JobType = (typeof JOB_TYPE)[keyof typeof JOB_TYPE];

// ─────────────────────────────────────────────────────────────────────────────
// Payload shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface SendMessagePayload {
  platform: Platform;
  channelId: string;
  userId?: string;
  text: string;
  proactive?: boolean;
}

export interface RunSkillPayload {
  skillName: string;
  toolName: string;
  params: Record<string, unknown>;
  conversationId?: string;
}

export interface ReminderPayload extends SendMessagePayload {
  reminderText: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SchedulerServiceImpl
// ─────────────────────────────────────────────────────────────────────────────

export class SchedulerServiceImpl implements SchedulerService {
  private readonly handlers = new Map<string, JobHandler>();

  constructor(
    private readonly boss: PgBoss,
    private readonly db: DrizzleDB,
    private readonly logger: Logger,
    /** Callback to actually dispatch outbound platform messages. */
    private readonly sendMessage?: (msg: OutboundMessage) => Promise<void>
  ) {
    this._registerBuiltInHandlers();
  }

  // ── Built-in handlers ──────────────────────────────────────

  private _registerBuiltInHandlers(): void {
    // SEND_MESSAGE
    this.boss.work<SendMessagePayload>(
      JOB_TYPE.SEND_MESSAGE,
      async (jobs) => {
        const job = jobs[0];
        try {
          const { platform, channelId, userId, text, proactive } = job.data;
          this.logger.info({ jobId: job.id, platform, channelId }, "Executing SEND_MESSAGE job");

          if (!this.sendMessage) {
            this.logger.warn({ jobId: job.id }, "No sendMessage callback registered — message dropped");
            return;
          }

          await this.sendMessage({ platform, channelId, userId, text, proactive: proactive ?? true });
          await this._recordLastRun(job.id ?? "", job.name);
        } catch (err) {
          this.logger.error({ err, jobId: job.id }, "SEND_MESSAGE job handler error — job will not be retried by this throw");
        }
      }
    ).catch((err) => this.logger.error({ err }, "Failed to register SEND_MESSAGE worker"));

    // REMINDER — alias that wraps SEND_MESSAGE
    this.boss.work<ReminderPayload>(
      JOB_TYPE.REMINDER,
      async (jobs) => {
        const job = jobs[0];
        try {
          const { platform, channelId, userId, reminderText } = job.data;
          this.logger.info({ jobId: job.id, platform, channelId }, "Executing REMINDER job");

          if (!this.sendMessage) {
            this.logger.warn({ jobId: job.id }, "No sendMessage callback registered — reminder dropped");
            return;
          }

          await this.sendMessage({
            platform,
            channelId,
            userId,
            text: reminderText,
            proactive: true,
          });
          await this._recordLastRun(job.id ?? "", job.name);
        } catch (err) {
          this.logger.error({ err, jobId: job.id }, "REMINDER job handler error — job will not be retried by this throw");
        }
      }
    ).catch((err) => this.logger.error({ err }, "Failed to register REMINDER worker"));

    // RUN_SKILL — execution delegated to orchestrator at runtime
    this.boss.work<RunSkillPayload>(
      JOB_TYPE.RUN_SKILL,
      async (jobs) => {
        const job = jobs[0];
        try {
          const handler = this.handlers.get(JOB_TYPE.RUN_SKILL);
          if (handler) {
            await handler({ id: job.id ?? "", name: job.name, data: job.data as unknown as Record<string, unknown> });
          } else {
            this.logger.warn({ jobId: job.id }, "No handler registered for RUN_SKILL");
          }
          await this._recordLastRun(job.id ?? "", job.name);
        } catch (err) {
          this.logger.error({ err, jobId: job.id }, "RUN_SKILL job handler error — job will not be retried by this throw");
        }
      }
    ).catch((err) => this.logger.error({ err }, "Failed to register RUN_SKILL worker"));
  }

  // ── SchedulerService interface ─────────────────────────────

  async register(jobName: string, handler: JobHandler): Promise<void> {
    this.handlers.set(jobName, handler);

    // Also register with pg-boss if it's not one of the built-in types
    const builtIns = new Set(Object.values(JOB_TYPE));
    if (!builtIns.has(jobName as JobType)) {
      await this.boss.work<Record<string, unknown>>(jobName, async (jobs) => {
        const job = jobs[0];
        try {
          await handler({ id: job.id ?? "", name: job.name, data: job.data });
          await this._recordLastRun(job.id ?? "", job.name);
        } catch (err) {
          this.logger.error({ err, jobName, jobId: job.id }, "Custom job handler error — caught to protect pg-boss worker");
        }
      });
      this.logger.debug({ jobName }, "Registered custom job handler");
    }
  }

  async scheduleCron(
    name: string,
    cron: string,
    payload: Record<string, unknown> = {}
  ): Promise<string> {
    // pg-boss schedule() for recurring jobs
    await this.boss.schedule(name, cron, payload);

    this.logger.info({ name, cron }, "Scheduled recurring cron job");

    const [row] = await this.db
      .insert(scheduledJobs)
      .values({
        name,
        description: `Recurring job: ${name}`,
        schedule: cron,
        recurring: true,
        payload,
        enabled: true,
        targetPlatform: (payload["platform"] as Platform) ?? null,
        targetChannelId: (payload["channelId"] as string) ?? null,
      })
      .onConflictDoUpdate({
        target: scheduledJobs.name,
        set: {
          schedule: cron,
          payload,
          enabled: true,
          updatedAt: new Date(),
        },
      })
      .returning({ id: scheduledJobs.id });

    return row.id;
  }

  async scheduleOnce(
    name: string,
    runAt: Date,
    payload: Record<string, unknown> = {}
  ): Promise<string> {
    const pgBossId = await this.boss.sendAfter(name, payload, {}, runAt);

    this.logger.info({ name, runAt, pgBossId }, "Scheduled one-shot job");

    const [row] = await this.db
      .insert(scheduledJobs)
      .values({
        name,
        description: `One-time job: ${name}`,
        schedule: runAt.toISOString(),
        recurring: false,
        payload,
        enabled: true,
        pgBossJobId: pgBossId ?? undefined,
        nextRunAt: runAt,
        targetPlatform: (payload["platform"] as Platform) ?? null,
        targetChannelId: (payload["channelId"] as string) ?? null,
      })
      .returning({ id: scheduledJobs.id });

    return row.id;
  }

  async cancel(jobId: string): Promise<void> {
    // jobId here is our internal DB UUID — retrieve the pg-boss ID
    const [row] = await this.db
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.id, jobId))
      .limit(1);

    if (!row) {
      throw new Error(`Scheduled job not found: ${jobId}`);
    }

    if (row.pgBossJobId) {
      try {
        await this.boss.cancel(row.name, row.pgBossJobId!);
      } catch (err) {
        this.logger.warn({ err, pgBossJobId: row.pgBossJobId }, "Could not cancel pg-boss job (may already be done)");
      }
    }

    if (row.recurring) {
      try {
        await this.boss.unschedule(row.name);
      } catch (err) {
        this.logger.warn({ err, name: row.name }, "Could not unschedule recurring job");
      }
    }

    await this.db
      .update(scheduledJobs)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(scheduledJobs.id, jobId));

    this.logger.info({ jobId }, "Cancelled scheduled job");
  }

  async list(): Promise<ScheduledJob[]> {
    const rows = await this.db
      .select()
      .from(scheduledJobs)
      .orderBy(desc(scheduledJobs.createdAt));

    return rows.map(rowToScheduledJob);
  }

  // ── Internal helpers ───────────────────────────────────────

  private async _recordLastRun(pgBossJobId: string, name: string): Promise<void> {
    try {
      await this.db
        .update(scheduledJobs)
        .set({ lastRunAt: new Date(), updatedAt: new Date() })
        .where(eq(scheduledJobs.name, name));
    } catch {
      // Best-effort — do not throw from a job handler
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function rowToScheduledJob(row: typeof scheduledJobs.$inferSelect): ScheduledJob {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    schedule: row.schedule,
    recurring: row.recurring,
    payload: (row.payload as Record<string, unknown>) ?? {},
    targetPlatform: row.targetPlatform ?? undefined,
    targetChannelId: row.targetChannelId ?? undefined,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    lastRunAt: row.lastRunAt?.toISOString(),
    nextRunAt: row.nextRunAt?.toISOString(),
    lastError: row.lastError ?? undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createSchedulerService(
  boss: PgBoss,
  db: DrizzleDB,
  logger: Logger,
  sendMessage?: (msg: OutboundMessage) => Promise<void>
): SchedulerService {
  return new SchedulerServiceImpl(boss, db, logger, sendMessage);
}
