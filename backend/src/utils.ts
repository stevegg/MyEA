/**
 * myEA — Shared backend utilities
 *
 * Small, pure helpers used across multiple modules. Keeping them here
 * avoids inline duplication and makes constants easy to update in one place.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** bcrypt work factor used for all password hashing. */
export const BCRYPT_SALT_ROUNDS = 12;

/** Semver version tag shared by all built-in skills. */
export const BUILT_IN_SKILL_VERSION = "1.0.0";

// ─────────────────────────────────────────────────────────────────────────────
// Error helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a human-readable message from an unknown thrown value.
 * Replaces the repeated inline pattern:
 *   `const msg = err instanceof Error ? err.message : String(err);`
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse `limit` and `offset` from a Fastify querystring object.
 * Clamps `limit` to [1, maxLimit] and `offset` to [0, ∞).
 */
export function parsePagination(
  query: Record<string, string | undefined>,
  options: { defaultLimit?: number; maxLimit?: number } = {}
): { limit: number; offset: number } {
  const { defaultLimit = 20, maxLimit = 100 } = options;
  const limit = Math.min(Math.max(parseInt(query["limit"] ?? String(defaultLimit), 10), 1), maxLimit);
  const offset = Math.max(parseInt(query["offset"] ?? "0", 10), 0);
  return { limit, offset };
}
