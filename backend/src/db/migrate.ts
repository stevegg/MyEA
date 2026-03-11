/**
 * myEA — Database Migration & Seed Runner
 *
 * Responsibilities (run in order):
 *  1. Apply all pending drizzle-kit migrations from ./drizzle/
 *  2. Ensure at least one admin user exists (created from env vars on first boot)
 *  3. Seed the initial settings record if absent
 *
 * Invoked by entrypoint.sh before the server process starts.
 * Safe to run multiple times — all operations are idempotent.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as bcrypt from "bcryptjs";
import { eq, count } from "drizzle-orm";
import path from "path";
import { users } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function log(message: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  if (data) {
    console.log(`[${ts}] [migrate] ${message}`, JSON.stringify(data));
  } else {
    console.log(`[${ts}] [migrate] ${message}`);
  }
}

function fail(message: string, err?: unknown): never {
  const ts = new Date().toISOString();
  console.error(`[${ts}] [migrate] FATAL: ${message}`, err ?? "");
  process.exit(1);
}

/** Resolve the drizzle migrations folder.
 *
 * In the Docker production image the compiled output lands in /app/dist/,
 * but the migrations folder lives at /app/drizzle/ (copied by the Dockerfile).
 * In development (tsx watch) the CWD is /app and drizzle/ is a sibling of src/.
 */
function resolveMigrationsDir(): string {
  // Allow explicit override via env (useful in tests)
  if (process.env.MIGRATIONS_DIR) {
    return process.env.MIGRATIONS_DIR;
  }

  // Walk up from __dirname until we find the drizzle folder
  const candidates = [
    path.resolve(__dirname, "../../drizzle"),   // production: dist/db -> root
    path.resolve(__dirname, "../../../drizzle"), // extra level if nested
    path.resolve(process.cwd(), "drizzle"),      // dev: cwd is /app
  ];

  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("fs").accessSync(candidate);
      return candidate;
    } catch {
      // try next
    }
  }

  // Fall back to cwd-relative path — drizzle-kit always creates ./drizzle
  return path.resolve(process.cwd(), "drizzle");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    fail("DATABASE_URL environment variable is not set");
  }

  log("Starting database migration sequence");

  // Use a dedicated single-connection client for migrations
  // (postgres-js does not support migrations over a pool)
  const migrationClient = postgres(databaseUrl, { max: 1 });
  const db = drizzle(migrationClient);

  // ── Step 1: Apply drizzle migrations ──────────────────────
  const migrationsFolder = resolveMigrationsDir();
  log("Applying migrations", { folder: migrationsFolder });

  try {
    await migrate(db, { migrationsFolder });
    log("Migrations applied successfully");
  } catch (err) {
    await migrationClient.end();
    fail("Migration failed", err);
  }

  // ── Step 2: Seed initial admin user ───────────────────────
  try {
    await seedAdminUser(db);
  } catch (err) {
    await migrationClient.end();
    fail("Admin user seed failed", err);
  }

  await migrationClient.end();
  log("Migration sequence complete");
}

async function seedAdminUser(
  db: ReturnType<typeof drizzle>
): Promise<void> {
  // Count existing users
  const result = await (db as ReturnType<typeof drizzle<typeof import("./schema")>>)
    .select({ count: count() })
    .from(users);

  const userCount = Number(result[0]?.count ?? 0);

  if (userCount > 0) {
    log("Admin user already exists — skipping seed", { existingUsers: userCount });
    return;
  }

  log("No users found — creating initial admin user");

  const adminUsername = process.env.ADMIN_USERNAME;
  if (!adminUsername) {
    fail(
      "ADMIN_USERNAME environment variable is required on first boot to seed the admin user"
    );
  }

  // Support two seeding modes:
  //  1. ADMIN_PASSWORD      — plain-text password (hashed here at startup)
  //  2. ADMIN_PASSWORD_HASH — pre-hashed bcrypt hash (for automation pipelines)
  let passwordHash: string;

  if (process.env.ADMIN_PASSWORD_HASH && !process.env.ADMIN_PASSWORD_HASH.startsWith("$2b$12$replace")) {
    passwordHash = process.env.ADMIN_PASSWORD_HASH;
    log("Using pre-hashed ADMIN_PASSWORD_HASH");
  } else if (process.env.ADMIN_PASSWORD) {
    log("Hashing ADMIN_PASSWORD (bcrypt, 12 rounds) — this may take a moment");
    passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
  } else {
    fail(
      "Either ADMIN_PASSWORD or ADMIN_PASSWORD_HASH must be set on first boot. " +
        "Set ADMIN_PASSWORD to a plain-text password and it will be hashed automatically."
    );
  }

  await (db as ReturnType<typeof drizzle<typeof import("./schema")>>)
    .insert(users)
    .values({
      username: adminUsername,
      passwordHash,
      isAdmin: true,
      displayName: adminUsername,
    });

  log("Initial admin user created", { username: adminUsername });
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry-point
// ─────────────────────────────────────────────────────────────────────────────

// Allow running this file directly: `node dist/db/migrate.js`
// or via tsx:                       `tsx src/db/migrate.ts`
if (require.main === module) {
  runMigrations().catch((err) => {
    console.error("Unhandled error in migrate.ts:", err);
    process.exit(1);
  });
}
