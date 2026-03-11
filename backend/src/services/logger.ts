/**
 * myEA — Logger Service
 *
 * Wraps the Fastify/Pino logger and also persists structured log entries to
 * the `logs` table in PostgreSQL. Every log method is non-throwing: DB write
 * failures are silently swallowed so that logging never crashes the app.
 */

import type { Logger, LogEntry } from "../types";
import type { DrizzleDB } from "../db";
import { logs } from "../db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type PinoLike = {
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  fatal(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): PinoLike;
};

type LogLevel = LogEntry["level"];

// ─────────────────────────────────────────────────────────────────────────────
// DBLoggerService implementation
// ─────────────────────────────────────────────────────────────────────────────

export class DBLogger implements Logger {
  private readonly pino: PinoLike;
  private readonly db: DrizzleDB | null;
  private readonly source: string;
  private readonly bindings: Record<string, unknown>;

  constructor(
    pino: PinoLike,
    db: DrizzleDB | null,
    source = "app",
    bindings: Record<string, unknown> = {}
  ) {
    this.pino = pino;
    this.db = db;
    this.source = source;
    this.bindings = bindings;
  }

  // ── Private helpers ────────────────────────────────────────

  private async writeToDb(level: LogLevel, obj: unknown, msg?: string): Promise<void> {
    if (!this.db) return;

    try {
      const message = msg ?? (typeof obj === "string" ? obj : "");
      const data: Record<string, unknown> = {
        ...this.bindings,
        ...(typeof obj === "object" && obj !== null && typeof obj !== "string"
          ? (obj as Record<string, unknown>)
          : {}),
      };

      await this.db.insert(logs).values({
        level,
        message,
        data,
        source: this.source,
      });
    } catch {
      // Never throw from logger
    }
  }

  // ── Logger interface ───────────────────────────────────────

  trace(obj: unknown, msg?: string): void {
    msg ? this.pino.trace(obj, msg) : this.pino.trace(obj);
    void this.writeToDb("trace", obj, msg);
  }

  debug(obj: unknown, msg?: string): void {
    msg ? this.pino.debug(obj, msg) : this.pino.debug(obj);
    void this.writeToDb("debug", obj, msg);
  }

  info(obj: unknown, msg?: string): void {
    msg ? this.pino.info(obj, msg) : this.pino.info(obj);
    void this.writeToDb("info", obj, msg);
  }

  warn(obj: unknown, msg?: string): void {
    msg ? this.pino.warn(obj, msg) : this.pino.warn(obj);
    void this.writeToDb("warn", obj, msg);
  }

  error(obj: unknown, msg?: string): void {
    msg ? this.pino.error(obj, msg) : this.pino.error(obj);
    void this.writeToDb("error", obj, msg);
  }

  fatal(obj: unknown, msg?: string): void {
    msg ? this.pino.fatal(obj, msg) : this.pino.fatal(obj);
    void this.writeToDb("fatal", obj, msg);
  }

  child(bindings: Record<string, unknown>): Logger {
    const childSource = (bindings["source"] as string) ?? this.source;
    return new DBLogger(
      this.pino.child(bindings),
      this.db,
      childSource,
      { ...this.bindings, ...bindings }
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a DBLogger instance that writes to both Pino and PostgreSQL.
 * Pass `db = null` during early boot before the DB is available.
 */
export function createLogger(
  pino: PinoLike,
  db: DrizzleDB | null,
  source = "app"
): Logger {
  return new DBLogger(pino, db, source);
}
