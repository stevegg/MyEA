/**
 * myEA — Database Connection
 *
 * Initialises a Drizzle ORM client backed by the `postgres` driver.
 * The connection pool is created once at startup and reused across the app.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import type { AppConfig, DatabaseService, Logger } from "../types";

export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;

let _db: DrizzleDB | null = null;
let _sql: ReturnType<typeof postgres> | null = null;

/**
 * Initialise the database connection.
 * Safe to call multiple times — returns the existing instance on subsequent calls.
 */
export function initDb(config: AppConfig, logger: Logger): DrizzleDB {
  if (_db) return _db;

  logger.info({ url: redactUrl(config.database.url) }, "Connecting to PostgreSQL");

  _sql = postgres(config.database.url, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: (notice) => {
      logger.debug({ notice }, "PostgreSQL notice");
    },
  });

  _db = drizzle(_sql, {
    schema,
    logger: {
      logQuery(query, params) {
        logger.trace({ query, params }, "SQL query");
      },
    },
  });

  logger.info("PostgreSQL connection pool initialised");
  return _db;
}

/**
 * Gracefully close the database connection pool.
 * Called during graceful shutdown.
 */
export async function closeDb(logger: Logger): Promise<void> {
  if (_sql) {
    logger.info("Closing PostgreSQL connection pool");
    await _sql.end({ timeout: 5 });
    _sql = null;
    _db = null;
    logger.info("PostgreSQL connection pool closed");
  }
}

/**
 * Returns the active Drizzle instance.
 * Throws if `initDb` has not been called yet.
 */
export function getDb(): DrizzleDB {
  if (!_db) {
    throw new Error("Database not initialised. Call initDb() first.");
  }
  return _db;
}

/**
 * DatabaseService implementation — thin wrapper that satisfies the interface
 * used by skills and other services without exposing the raw Drizzle instance.
 */
export function createDatabaseService(db: DrizzleDB, logger: Logger): DatabaseService {
  return {
    db,
    async ping(): Promise<boolean> {
      try {
        if (!_sql) return false;
        await _sql`SELECT 1`;
        return true;
      } catch (err) {
        logger.error({ err }, "Database ping failed");
        return false;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Remove password from connection URL for safe logging. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "<invalid-url>";
  }
}
