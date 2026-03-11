/**
 * myEA — Abstract Base Platform Connector
 *
 * Provides shared infrastructure for all platform connectors:
 *   - Message deduplication via a bounded LRU-style Set
 *   - Centralised error handling with exponential-backoff reconnection
 *   - Token-bucket rate limiting per platform
 *   - Handler registration and fan-out
 *
 * Every concrete connector extends BasePlatformConnector and calls
 * super() then implements the three abstract lifecycle methods.
 */

import { EventEmitter } from "events";
import type { PlatformConnector, Platform, PlatformMessage, OutboundMessage, Logger, AppConfig } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiter (token bucket)
// ─────────────────────────────────────────────────────────────────────────────

interface TokenBucketOptions {
  /** Maximum tokens the bucket can hold. */
  capacity: number;
  /** Tokens added per second. */
  refillRate: number;
}

export class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillRate: number;
  private lastRefill: number;

  constructor(options: TokenBucketOptions) {
    this.capacity = options.capacity;
    this.refillRate = options.refillRate;
    this.tokens = options.capacity;
    this.lastRefill = Date.now();
  }

  /** Returns the number of ms to wait, or 0 if immediately available. */
  consume(cost = 1): number {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return 0;
    }
    const deficit = cost - this.tokens;
    return Math.ceil((deficit / this.refillRate) * 1000);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Message deduplication cache
// ─────────────────────────────────────────────────────────────────────────────

export class DeduplicationCache {
  private readonly cache = new Map<string, number>(); // id → expiry timestamp
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs = 60_000, maxSize = 2_000) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  /** Returns true if this id has been seen recently (duplicate). */
  isDuplicate(id: string): boolean {
    this.evictExpired();
    const expiry = this.cache.get(id);
    if (expiry !== undefined && expiry > Date.now()) {
      return true;
    }
    // Not a duplicate — record it
    if (this.cache.size >= this.maxSize) {
      // Evict oldest entry to stay within bounds
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(id, Date.now() + this.ttlMs);
    return false;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, expiry] of this.cache) {
      if (expiry <= now) this.cache.delete(id);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconnection controller
// ─────────────────────────────────────────────────────────────────────────────

export interface ReconnectionOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  backoffMultiplier?: number;
}

export class ReconnectionController {
  private attempt = 0;
  private readonly initialDelay: number;
  private readonly maxDelay: number;
  private readonly maxAttempts: number;
  private readonly multiplier: number;

  constructor(opts: ReconnectionOptions = {}) {
    this.initialDelay = opts.initialDelayMs ?? 1_000;
    this.maxDelay = opts.maxDelayMs ?? 60_000;
    this.maxAttempts = opts.maxAttempts ?? 10;
    this.multiplier = opts.backoffMultiplier ?? 2;
  }

  get currentAttempt(): number {
    return this.attempt;
  }

  get exhausted(): boolean {
    return this.attempt >= this.maxAttempts;
  }

  /** Returns the delay in ms for the next attempt, or -1 if exhausted. */
  nextDelay(): number {
    if (this.exhausted) return -1;
    const delay = Math.min(
      this.initialDelay * Math.pow(this.multiplier, this.attempt),
      this.maxDelay
    );
    // Add ±10 % jitter to avoid thundering-herd
    const jitter = delay * 0.1 * (Math.random() * 2 - 1);
    this.attempt++;
    return Math.round(delay + jitter);
  }

  reset(): void {
    this.attempt = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Base connector
// ─────────────────────────────────────────────────────────────────────────────

export interface BaseConnectorOptions {
  config: AppConfig;
  logger: Logger;
  /** Override token-bucket defaults per connector. */
  rateLimitCapacity?: number;
  rateLimitRefillRate?: number;
  reconnection?: ReconnectionOptions;
  dedupTtlMs?: number;
}

export abstract class BasePlatformConnector
  extends EventEmitter
  implements PlatformConnector
{
  abstract readonly platform: Platform;

  readonly enabled: boolean;

  protected readonly config: AppConfig;
  protected readonly log: Logger;

  private _connected = false;
  private _stopping = false;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly dedup: DeduplicationCache;
  protected readonly rateLimiter: TokenBucket;
  protected readonly reconnection: ReconnectionController;

  private readonly handlers: Array<(msg: PlatformMessage) => Promise<void>> = [];

  constructor(enabled: boolean, opts: BaseConnectorOptions) {
    super();
    this.enabled = enabled;
    this.config = opts.config;
    this.log = opts.logger.child({ connector: this.constructor.name });

    this.dedup = new DeduplicationCache(opts.dedupTtlMs);
    this.rateLimiter = new TokenBucket({
      capacity: opts.rateLimitCapacity ?? 30,
      refillRate: opts.rateLimitRefillRate ?? 5,
    });
    this.reconnection = new ReconnectionController(opts.reconnection);
  }

  // ── Public PlatformConnector interface ──────────────────────────────────────

  async start(): Promise<void> {
    if (!this.enabled) {
      this.log.info("Connector is disabled — skipping start");
      return;
    }
    this._stopping = false;
    this.log.info("Starting connector");
    await this.doStart();
    this._setConnected(true);
    this.reconnection.reset();
  }

  async stop(): Promise<void> {
    this._stopping = true;
    this._clearReconnectTimer();
    if (this._connected) {
      this.log.info("Stopping connector");
      await this.doStop();
      this._setConnected(false);
    }
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this._connected) {
      throw new Error(`[${this.platform}] Cannot send: not connected`);
    }

    // Rate limiting
    const waitMs = this.rateLimiter.consume();
    if (waitMs > 0) {
      this.log.warn({ waitMs }, "Rate limit reached — waiting before sending");
      await this._sleep(waitMs);
    }

    await this.doSend(message);
  }

  onMessage(handler: (msg: PlatformMessage) => Promise<void>): void {
    this.handlers.push(handler);
  }

  // ── State helpers ─────────────────────────────────────────────────────────

  get isConnected(): boolean {
    return this._connected;
  }

  protected _setConnected(connected: boolean): void {
    this._connected = connected;
    this.emit(connected ? "connected" : "disconnected");
  }

  // ── Message dispatch ──────────────────────────────────────────────────────

  /**
   * Call this from the concrete connector when a new inbound message arrives.
   * Handles deduplication before dispatching to registered handlers.
   */
  protected async dispatchMessage(msg: PlatformMessage): Promise<void> {
    if (this.dedup.isDuplicate(msg.id)) {
      this.log.debug({ id: msg.id }, "Dropping duplicate message");
      return;
    }

    this.emit("message", msg);

    for (const handler of this.handlers) {
      try {
        await handler(msg);
      } catch (err) {
        this.log.error({ err, msgId: msg.id }, "Message handler threw an error");
      }
    }
  }

  // ── Reconnection ──────────────────────────────────────────────────────────

  /**
   * Call this from the concrete connector when an unexpected disconnection
   * occurs (e.g. WebSocket close, API error).
   */
  protected handleDisconnect(reason?: string): void {
    if (this._stopping) return;

    this._setConnected(false);
    this.log.warn({ reason }, "Connector disconnected unexpectedly");

    this._scheduleReconnect();
  }

  private _scheduleReconnect(): void {
    if (this._stopping || this.reconnection.exhausted) {
      if (this.reconnection.exhausted) {
        this.log.error(
          { attempts: this.reconnection.currentAttempt },
          "Max reconnection attempts exhausted — giving up"
        );
        this.emit("reconnect_failed");
      }
      return;
    }

    const delay = this.reconnection.nextDelay();
    if (delay < 0) return;

    this.log.info(
      { delayMs: delay, attempt: this.reconnection.currentAttempt },
      "Scheduling reconnect"
    );

    this._reconnectTimer = setTimeout(async () => {
      try {
        this.log.info("Attempting to reconnect");
        await this.doStart();
        this._setConnected(true);
        this.reconnection.reset();
        this.log.info("Reconnection successful");
        this.emit("reconnected");
      } catch (err) {
        this.log.error({ err }, "Reconnection attempt failed");
        this._scheduleReconnect();
      }
    }, delay);
  }

  private _clearReconnectTimer(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  // ── Abstract lifecycle hooks ──────────────────────────────────────────────

  /** Perform the platform-specific connection logic. */
  protected abstract doStart(): Promise<void>;

  /** Perform the platform-specific disconnection logic. */
  protected abstract doStop(): Promise<void>;

  /** Platform-specific send implementation. */
  protected abstract doSend(message: OutboundMessage): Promise<void>;

  // ── Utilities ─────────────────────────────────────────────────────────────

  protected _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Classify a MIME content-type string into a broad attachment category.
   * Shared by all connectors that receive file attachments.
   */
  protected attachmentType(
    contentType: string | null | undefined
  ): "image" | "audio" | "video" | "document" | "other" {
    if (!contentType) return "other";
    if (contentType.startsWith("image/")) return "image";
    if (contentType.startsWith("audio/")) return "audio";
    if (contentType.startsWith("video/")) return "video";
    if (contentType.startsWith("application/") || contentType.startsWith("text/"))
      return "document";
    return "other";
  }

  /**
   * Split a long string into chunks that fit within `maxLength`,
   * breaking on newlines or spaces where possible.
   */
  protected splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLength) {
      let splitAt = remaining.lastIndexOf("\n", maxLength);
      if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", maxLength);
      if (splitAt <= 0) splitAt = maxLength;

      chunks.push(remaining.slice(0, splitAt).trimEnd());
      remaining = remaining.slice(splitAt).trimStart();
    }

    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
  }
}
