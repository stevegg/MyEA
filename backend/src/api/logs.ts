/**
 * myEA — Logs API Routes
 *
 *   GET    /api/logs           — paginated, filterable log history from the DB
 *   DELETE /api/logs           — bulk-delete logs older than N days
 *   GET    /api/logs/export    — download all (or filtered) logs as a JSON file
 *
 * All routes require a valid JWT (app.authenticate preHandler).
 *
 * Query parameters for GET /api/logs and GET /api/logs/export:
 *   level          — trace | debug | info | warn | error | fatal
 *   platform       — filter by source field prefix (e.g. "telegram")
 *   from           — ISO-8601 start timestamp (inclusive)
 *   to             — ISO-8601 end timestamp (inclusive)
 *   search         — full-text substring match against the message column
 *   limit          — page size (default 100, max 500)
 *   offset         — row offset for pagination (default 0)
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { eq, and, gte, lte, like, desc, lt, count, SQL } from "drizzle-orm";
import type { DrizzleDB } from "../db";
import { logs } from "../db/schema";
import type { LogEntry } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Plugin options
// ─────────────────────────────────────────────────────────────────────────────

interface LogsPluginOptions {
  db: DrizzleDB;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared filter query-string shape
// ─────────────────────────────────────────────────────────────────────────────

interface LogFilterQuery {
  level?: string;
  platform?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: string;
  offset?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────────────

const logsPlugin: FastifyPluginAsync<LogsPluginOptions> = async (
  app: FastifyInstance,
  opts: LogsPluginOptions
) => {
  const { db } = opts;

  // ── GET /api/logs/export — must come before GET /api/logs to avoid conflicts

  app.get<{ Querystring: LogFilterQuery }>(
    "/api/logs/export",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const conditions = buildConditions(request.query);

      const rows = await db
        .select()
        .from(logs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(logs.createdAt))
        // Hard cap at 50 000 rows for export to avoid OOM on large tables
        .limit(50_000);

      const payload = rows.map(formatLog);

      const filename = `myea-logs-${new Date().toISOString().slice(0, 10)}.json`;

      return reply
        .header("Content-Type", "application/json")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(JSON.stringify({ exportedAt: new Date().toISOString(), total: payload.length, logs: payload }, null, 2));
    }
  );

  // ── GET /api/logs ──────────────────────────────────────────

  app.get<{ Querystring: LogFilterQuery }>(
    "/api/logs",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const limit = Math.min(parseInt(request.query.limit ?? "100", 10), 500);
      const offset = Math.max(parseInt(request.query.offset ?? "0", 10), 0);

      const conditions = buildConditions(request.query);
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // Run the count and data queries in parallel
      const [countResult, rows] = await Promise.all([
        db
          .select({ value: count() })
          .from(logs)
          .where(whereClause),
        db
          .select()
          .from(logs)
          .where(whereClause)
          .orderBy(desc(logs.createdAt))
          .limit(limit)
          .offset(offset),
      ]);

      const total = Number(countResult[0]?.value ?? 0);

      return reply.send({
        data: rows.map(formatLog),
        pagination: { limit, offset, total },
      });
    }
  );

  // ── DELETE /api/logs ───────────────────────────────────────

  app.delete<{ Querystring: { olderThanDays?: string } }>(
    "/api/logs",
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: {
          type: "object",
          properties: {
            olderThanDays: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const days = Math.max(1, parseInt(request.query.olderThanDays ?? "30", 10));

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);

      // Count first so we can report how many were deleted
      const [{ value: totalBefore }] = await db
        .select({ value: count() })
        .from(logs)
        .where(lt(logs.createdAt, cutoff));

      await db.delete(logs).where(lt(logs.createdAt, cutoff));

      const deleted = Number(totalBefore ?? 0);
      request.log.info({ deleted, olderThanDays: days, cutoff: cutoff.toISOString() }, "Logs purged");

      return reply.send({
        deleted,
        olderThanDays: days,
        cutoff: cutoff.toISOString(),
      });
    }
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an array of Drizzle SQL conditions from the incoming filter query.
 * Only adds a condition when the corresponding query param is present and valid.
 */
function buildConditions(query: LogFilterQuery): SQL[] {
  const conditions: SQL[] = [];

  // Level filter — must be a valid log level enum value
  const validLevels = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);
  if (query.level && validLevels.has(query.level)) {
    conditions.push(
      eq(logs.level, query.level as "trace" | "debug" | "info" | "warn" | "error" | "fatal")
    );
  }

  // Platform / source filter — prefix match on the source column
  if (query.platform && query.platform.trim()) {
    // Use a LIKE pattern so "telegram" matches "telegram.connector", etc.
    conditions.push(like(logs.source, `${escapeLike(query.platform.trim())}%`));
  }

  // Timestamp range
  if (query.from) {
    const fromDate = new Date(query.from);
    if (!isNaN(fromDate.getTime())) {
      conditions.push(gte(logs.createdAt, fromDate));
    }
  }

  if (query.to) {
    const toDate = new Date(query.to);
    if (!isNaN(toDate.getTime())) {
      conditions.push(lte(logs.createdAt, toDate));
    }
  }

  // Substring search against the message column (case-insensitive via ILIKE pattern)
  if (query.search && query.search.trim()) {
    conditions.push(like(logs.message, `%${escapeLike(query.search.trim())}%`));
  }

  return conditions;
}

/** Escape special LIKE pattern characters in user-supplied strings. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Serialize a DB row to the public LogEntry shape. */
function formatLog(row: typeof logs.$inferSelect): LogEntry {
  return {
    id: row.id,
    level: row.level,
    message: row.message,
    data: (row.data as Record<string, unknown>) ?? undefined,
    source: row.source ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export default fp(logsPlugin, {
  name: "logs-routes",
  dependencies: ["auth"],
});
