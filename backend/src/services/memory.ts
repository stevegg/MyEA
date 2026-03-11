/**
 * myEA — Memory Service
 *
 * Persists the assistant's "working memory": facts, preferences, summaries,
 * context, and notes about the user. Uses the `memory_entries` table with
 * PostgreSQL full-text search via tsvector for the `search()` method.
 */

import { eq, desc, sql, and, isNull, gt, or, lt, ilike } from "drizzle-orm";
import type { MemoryService, MemoryEntry, MemorySearchOptions, Logger } from "../types";
import type { DrizzleDB } from "../db";
import { memoryEntries } from "../db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function rowToEntry(row: typeof memoryEntries.$inferSelect): MemoryEntry {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : undefined,
  };
}

/** Build a tsvector-compatible search string from the user query. */
function toTsQuery(query: string): string {
  // Tokenise, strip punctuation, join with &
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/[^a-zA-Z0-9]/g, ""))
    .filter(Boolean)
    .join(" & ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Simple Map-based LRU cache for single-entry lookups
// ─────────────────────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class LRUCache<K, V> {
  private readonly cache = new Map<K, CacheEntry<V>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    // Move to end (most recently used) by re-inserting
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict the least recently used (first inserted) entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: K): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MemoryServiceImpl
// ─────────────────────────────────────────────────────────────────────────────

export class MemoryServiceImpl implements MemoryService {
  /**
   * LRU cache for single-entry `get()` lookups.
   * Caches up to 100 entries for 60 seconds.
   * Invalidated on update/delete.
   */
  private readonly entryCache = new LRUCache<string, MemoryEntry>(100, 60_000);

  constructor(
    private readonly db: DrizzleDB,
    private readonly logger: Logger
  ) {}

  // ── store ──────────────────────────────────────────────────

  async store(
    entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">
  ): Promise<MemoryEntry> {
    const searchVector = toSearchVector(entry.content);

    const [row] = await this.db
      .insert(memoryEntries)
      .values({
        type: entry.type,
        content: entry.content,
        metadata: entry.metadata ?? {},
        searchVector,
        expiresAt: entry.expiresAt ? new Date(entry.expiresAt) : null,
      })
      .returning();

    this.logger.debug({ id: row.id, type: row.type }, "Memory entry stored");
    return rowToEntry(row);
  }

  // ── search ─────────────────────────────────────────────────

  async search(options: MemorySearchOptions): Promise<MemoryEntry[]> {
    const { query, type, limit = 20 } = options;

    const now = new Date();
    const tsQuery = toTsQuery(query);

    try {
      if (tsQuery) {
        // Full-text search using tsvector column
        const rows = await this.db
          .select()
          .from(memoryEntries)
          .where(
            and(
              // Filter out expired entries
              or(
                isNull(memoryEntries.expiresAt),
                gt(memoryEntries.expiresAt, now)
              ),
              // Type filter
              type ? eq(memoryEntries.type, type) : undefined,
              // FTS condition using raw SQL against the stored search_vector text
              sql`to_tsvector('english', ${memoryEntries.content}) @@ plainto_tsquery('english', ${query})`
            )
          )
          .orderBy(
            sql`ts_rank(to_tsvector('english', ${memoryEntries.content}), plainto_tsquery('english', ${query})) DESC`
          )
          .limit(limit);

        return rows.map(rowToEntry);
      }
    } catch (err) {
      this.logger.warn({ err }, "FTS search failed, falling back to ILIKE");
    }

    // Fallback: ILIKE substring match
    const rows = await this.db
      .select()
      .from(memoryEntries)
      .where(
        and(
          or(isNull(memoryEntries.expiresAt), gt(memoryEntries.expiresAt, now)),
          type ? eq(memoryEntries.type, type) : undefined,
          ilike(memoryEntries.content, `%${query}%`)
        )
      )
      .orderBy(desc(memoryEntries.createdAt))
      .limit(limit);

    return rows.map(rowToEntry);
  }

  // ── get ────────────────────────────────────────────────────

  async get(id: string): Promise<MemoryEntry | null> {
    const cached = this.entryCache.get(id);
    if (cached !== undefined) return cached;

    const [row] = await this.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.id, id))
      .limit(1);

    const entry = row ? rowToEntry(row) : null;
    if (entry) this.entryCache.set(id, entry);
    return entry;
  }

  // ── update ─────────────────────────────────────────────────

  async update(
    id: string,
    patch: Partial<Pick<MemoryEntry, "content" | "metadata" | "expiresAt">>
  ): Promise<MemoryEntry> {
    const updateValues: Partial<typeof memoryEntries.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (patch.content !== undefined) {
      updateValues.content = patch.content;
      updateValues.searchVector = toSearchVector(patch.content);
    }
    if (patch.metadata !== undefined) {
      updateValues.metadata = patch.metadata;
    }
    if (patch.expiresAt !== undefined) {
      updateValues.expiresAt = patch.expiresAt ? new Date(patch.expiresAt) : null;
    }

    const [row] = await this.db
      .update(memoryEntries)
      .set(updateValues)
      .where(eq(memoryEntries.id, id))
      .returning();

    if (!row) {
      throw new Error(`Memory entry not found: ${id}`);
    }

    const entry = rowToEntry(row);
    // Invalidate and repopulate cache on update
    this.entryCache.set(id, entry);
    this.logger.debug({ id }, "Memory entry updated");
    return entry;
  }

  // ── delete ─────────────────────────────────────────────────

  async delete(id: string): Promise<void> {
    await this.db.delete(memoryEntries).where(eq(memoryEntries.id, id));
    // Invalidate cache on delete
    this.entryCache.delete(id);
    this.logger.debug({ id }, "Memory entry deleted");
  }

  // ── pruneExpired ───────────────────────────────────────────

  async pruneExpired(): Promise<number> {
    const now = new Date();
    const result = await this.db
      .delete(memoryEntries)
      .where(
        and(
          sql`${memoryEntries.expiresAt} IS NOT NULL`,
          lt(memoryEntries.expiresAt, now)
        )
      )
      .returning({ id: memoryEntries.id });

    const count = result.length;
    if (count > 0) {
      this.logger.info({ count }, "Pruned expired memory entries");
    }
    return count;
  }

  // ── getAll (pagination helper, not in interface but used by API) ───────────

  async getAll(limit = 50, offset = 0): Promise<{ entries: MemoryEntry[]; total: number }> {
    const now = new Date();

    const rows = await this.db
      .select()
      .from(memoryEntries)
      .where(
        or(
          isNull(memoryEntries.expiresAt),
          gt(memoryEntries.expiresAt, now)
        )
      )
      .orderBy(desc(memoryEntries.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(memoryEntries)
      .where(
        or(
          isNull(memoryEntries.expiresAt),
          gt(memoryEntries.expiresAt, now)
        )
      );

    return { entries: rows.map(rowToEntry), total: count };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a simple text representation suitable for storing in the search_vector column. */
function toSearchVector(content: string): string {
  // Normalise to lowercase, strip special chars for the stored text column.
  // The actual tsvector computation is done inline with to_tsvector() in queries.
  return content.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createMemoryService(db: DrizzleDB, logger: Logger): MemoryService & {
  getAll(limit?: number, offset?: number): Promise<{ entries: MemoryEntry[]; total: number }>;
} {
  return new MemoryServiceImpl(db, logger);
}
