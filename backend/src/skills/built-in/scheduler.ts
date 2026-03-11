/**
 * myEA — Built-in Skill: Scheduler
 *
 * Creates, lists, and cancels reminders and recurring tasks using the
 * platform's SchedulerService (pg-boss under the hood). One-time reminders
 * use scheduleOnce(); recurring tasks use scheduleCron().
 *
 * Job names are namespaced under "reminder:" and "recurring:" to avoid
 * collisions with other pg-boss jobs registered elsewhere.
 */

// @ts-ignore - luxon lacks bundled types in this env
import { DateTime } from "luxon";

import type { Skill, SkillContext, ExecutionContext, ToolResult, SchedulerService } from "../../types";
import { getErrorMessage, BUILT_IN_SKILL_VERSION } from "../../utils";

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────────────────────────

let schedulerService: SchedulerService | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function requireScheduler(): ToolResult | null {
  if (!schedulerService) {
    return { content: "Scheduler service is not available.", isError: true };
  }
  return null;
}

function parseDateTime(datetime: string): Date | null {
  // Try ISO first, then natural formats via Luxon.
  const iso = DateTime.fromISO(datetime, { setZone: true });
  if (iso.isValid) return iso.toJSDate();

  const http = DateTime.fromHTTP(datetime);
  if (http.isValid) return http.toJSDate();

  const sql = DateTime.fromSQL(datetime);
  if (sql.isValid) return sql.toJSDate();

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────────────────────────────────────

async function createReminder(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const err = requireScheduler();
  if (err) return err;

  const { message, datetime, platform } = params as { message: string; datetime: string; platform?: string };

  const runAt = parseDateTime(datetime);
  if (!runAt) {
    return {
      content: `Could not parse datetime "${datetime}". Use ISO-8601 (e.g. "2024-12-25T09:00:00Z").`,
      isError: true,
    };
  }

  if (runAt <= new Date()) {
    return { content: "The reminder datetime is in the past.", isError: true };
  }

  try {
    const jobId = await schedulerService!.scheduleOnce(
      "reminder:one-shot",
      runAt,
      { message, platform: platform ?? "internal", createdAt: new Date().toISOString() }
    );
    const formatted = DateTime.fromJSDate(runAt).toLocaleString(DateTime.DATETIME_FULL);
    return {
      content: `Reminder set for ${formatted}. Job ID: ${jobId}`,
      data: { jobId, runAt: runAt.toISOString(), message },
    };
  } catch (e) {
    const msg = getErrorMessage(e);
    return { content: `Failed to create reminder: ${msg}`, isError: true };
  }
}

async function createRecurringTask(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const err = requireScheduler();
  if (err) return err;

  const { message, cronExpression, platform } = params as { message: string; cronExpression: string; platform?: string };

  try {
    const jobId = await schedulerService!.scheduleCron(
      "reminder:recurring",
      cronExpression,
      { message, platform: platform ?? "internal", createdAt: new Date().toISOString() }
    );
    return {
      content: `Recurring task created with cron "${cronExpression}". Job ID: ${jobId}`,
      data: { jobId, cronExpression, message },
    };
  } catch (e) {
    const msg = getErrorMessage(e);
    return { content: `Failed to create recurring task: ${msg}`, isError: true };
  }
}

async function listReminders(_params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const err = requireScheduler();
  if (err) return err;

  try {
    const jobs = await schedulerService!.list();
    const reminders = jobs.filter((j) => j.name.startsWith("reminder:"));

    if (reminders.length === 0) {
      return { content: "No active reminders or recurring tasks.", data: { reminders: [] } };
    }

    const lines = reminders.map((j) => {
      const payload = j.payload as { message?: string };
      const next = j.nextRunAt ? DateTime.fromISO(j.nextRunAt).toLocaleString(DateTime.DATETIME_FULL) : "unknown";
      return `[${j.id}] ${j.recurring ? "RECURRING" : "ONE-TIME"} | Next: ${next}\n  Message: ${payload.message ?? "(no message)"}\n  Schedule: ${j.schedule}`;
    });

    return {
      content: lines.join("\n\n"),
      data: { count: reminders.length, reminders },
    };
  } catch (e) {
    const msg = getErrorMessage(e);
    return { content: `Failed to list reminders: ${msg}`, isError: true };
  }
}

async function cancelReminder(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const err = requireScheduler();
  if (err) return err;

  const { id } = params as { id: string };

  try {
    await schedulerService!.cancel(id);
    return { content: `Reminder ${id} cancelled.` };
  } catch (e) {
    const msg = getErrorMessage(e);
    return { content: `Failed to cancel reminder "${id}": ${msg}`, isError: true };
  }
}

async function getCurrentTime(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { timezone = "UTC" } = (params as { timezone?: string }) ?? {};

  try {
    const now = DateTime.now().setZone(timezone);
    if (!now.isValid) {
      return {
        content: `Invalid timezone "${timezone}". Use an IANA timezone name (e.g. "America/New_York").`,
        isError: true,
      };
    }
    return {
      content: `Current time in ${timezone}: ${now.toLocaleString(DateTime.DATETIME_FULL_WITH_SECONDS)} (${now.toISO()})`,
      data: {
        timezone,
        iso: now.toISO(),
        unix: now.toUnixInteger(),
        formatted: now.toLocaleString(DateTime.DATETIME_FULL_WITH_SECONDS),
      },
    };
  } catch (e) {
    const msg = getErrorMessage(e);
    return { content: `Failed to get time: ${msg}`, isError: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill definition
// ─────────────────────────────────────────────────────────────────────────────

const schedulerSkill: Skill = {
  name: "scheduler",
  description: "Create, list, and cancel one-time reminders and recurring tasks. Get the current time in any timezone.",
  version: BUILT_IN_SKILL_VERSION,

  async setup(context: SkillContext): Promise<void> {
    schedulerService = context.scheduler;

    // Register the handler that fires when a one-shot reminder is due.
    await schedulerService.register("reminder:one-shot", async (job) => {
      const payload = job.data as { message?: string; platform?: string };
      context.logger.info({ jobId: job.id, message: payload.message }, "Reminder fired.");
      // Find the user's preferred channel and deliver the reminder.
      // We send an internal platform message and let the routing layer handle delivery.
      await context.sendMessage({
        platform: (payload.platform as "internal") ?? "internal",
        channelId: "default",
        text: `Reminder: ${payload.message ?? "(no message)"}`,
        proactive: true,
      });
    });

    // Register the handler for recurring tasks.
    await schedulerService.register("reminder:recurring", async (job) => {
      const payload = job.data as { message?: string; platform?: string };
      context.logger.info({ jobId: job.id, message: payload.message }, "Recurring task fired.");
      await context.sendMessage({
        platform: (payload.platform as "internal") ?? "internal",
        channelId: "default",
        text: `Scheduled task: ${payload.message ?? "(no message)"}`,
        proactive: true,
      });
    });

    context.logger.info("Scheduler skill ready.");
  },

  async teardown(): Promise<void> {
    schedulerService = null;
  },

  tools: [
    {
      name: "create_reminder",
      description: "Set a one-time reminder to fire at a specific date and time.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "The reminder message to deliver when the time comes." },
          datetime: {
            type: "string",
            description: "When to fire the reminder. ISO-8601 format recommended (e.g. '2024-12-25T09:00:00Z').",
          },
          platform: {
            type: "string",
            description: "Target platform for delivery (telegram, discord, slack, internal). Defaults to internal.",
          },
        },
        required: ["message", "datetime"],
      },
      execute: createReminder,
    },
    {
      name: "create_recurring_task",
      description: "Create a recurring scheduled task using a cron expression.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "The task message to deliver on each occurrence." },
          cronExpression: {
            type: "string",
            description: "Standard 5-field cron expression (e.g. '0 9 * * 1-5' for weekdays at 9 AM).",
          },
          platform: {
            type: "string",
            description: "Target platform for delivery. Defaults to internal.",
          },
        },
        required: ["message", "cronExpression"],
      },
      execute: createRecurringTask,
    },
    {
      name: "list_reminders",
      description: "List all active one-time reminders and recurring tasks.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: listReminders,
    },
    {
      name: "cancel_reminder",
      description: "Cancel a reminder or recurring task by its job ID.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The job ID returned when the reminder was created." },
        },
        required: ["id"],
      },
      execute: cancelReminder,
    },
    {
      name: "get_current_time",
      description: "Get the current date and time in any IANA timezone.",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description: "IANA timezone name (e.g. 'America/New_York', 'Europe/London', 'Asia/Tokyo'). Defaults to UTC.",
          },
        },
        required: [],
      },
      execute: getCurrentTime,
    },
  ],
};

export default schedulerSkill;
