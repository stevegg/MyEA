/**
 * myEA — Platform Manager
 *
 * Singleton that owns the lifecycle of all platform connectors. It:
 *   - Instantiates only the connectors that are enabled in config
 *   - Starts each connector and wires inbound messages to the orchestrator
 *   - Routes outbound messages to the correct connector by platform
 *   - Broadcasts WebSocket events when platforms connect/disconnect
 *   - Monitors connectors and triggers reconnection when they fail
 *   - Exposes a status map for the admin API
 */

import type {
  AppConfig,
  Logger,
  Platform,
  PlatformMessage,
  OutboundMessage,
  WSEvent,
} from "../types";

import { TelegramConnector } from "./telegram";
import { DiscordConnector } from "./discord";
import { SlackConnector } from "./slack";
import { WhatsAppConnector } from "./whatsapp";
import { SignalConnector } from "./signal";
import { IMessageConnector } from "./imessage";
import type { BasePlatformConnector } from "./base";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PlatformStatus {
  platform: Platform;
  enabled: boolean;
  connected: boolean;
  lastError?: string;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
}

export type MessageHandler = (msg: PlatformMessage) => Promise<void>;
export type BroadcastFn = (event: WSEvent) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Manager
// ─────────────────────────────────────────────────────────────────────────────

export class PlatformManager {
  private readonly config: AppConfig;
  private readonly log: Logger;
  private readonly broadcast: BroadcastFn;

  /** Map from platform name to connector instance */
  private readonly connectors = new Map<Platform, BasePlatformConnector>();

  /** Per-platform status tracked independently so we can report even before start() */
  private readonly statuses = new Map<Platform, PlatformStatus>();

  /** Registered inbound message handlers (forwarded to the orchestrator) */
  private readonly messageHandlers: MessageHandler[] = [];

  /** Health-check ticker */
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AppConfig, logger: Logger, broadcast: BroadcastFn) {
    this.config = config;
    this.log = logger.child({ component: "PlatformManager" });
    this.broadcast = broadcast;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Build connector instances, register event listeners, and start every
   * enabled connector. Returns after all start() calls settle (pass or fail).
   */
  async start(): Promise<void> {
    this._buildConnectors();

    const startPromises = [...this.connectors.values()].map((connector) =>
      this._startConnector(connector)
    );

    await Promise.allSettled(startPromises);

    // Periodic health check — restarts connectors that silently died
    this.healthCheckTimer = setInterval(() => {
      this._healthCheck();
    }, 60_000);

    this.log.info(
      {
        enabled: [...this.connectors.keys()],
        total: this.statuses.size,
      },
      "PlatformManager started"
    );
  }

  /** Gracefully stop all connectors. */
  async stop(): Promise<void> {
    if (this.healthCheckTimer !== null) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    const stopPromises = [...this.connectors.values()].map(async (connector) => {
      try {
        await connector.stop();
        this.log.info({ platform: connector.platform }, "Connector stopped");
      } catch (err) {
        this.log.error({ err, platform: connector.platform }, "Error stopping connector");
      }
    });

    await Promise.allSettled(stopPromises);
    this.log.info("PlatformManager stopped");
  }

  /**
   * Send a message on the appropriate platform.
   * Throws if the target platform is not connected.
   */
  async send(message: OutboundMessage): Promise<void> {
    const connector = this.connectors.get(message.platform);
    if (!connector) {
      throw new Error(
        `[PlatformManager] No connector registered for platform "${message.platform}"`
      );
    }
    if (!connector.isConnected) {
      throw new Error(
        `[PlatformManager] Connector for "${message.platform}" is not connected`
      );
    }
    await connector.send(message);
  }

  /**
   * Register a handler that fires for every inbound message across all
   * platforms. Typically wired to the orchestrator.
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /** Returns a snapshot of status for every known platform. */
  getStatuses(): PlatformStatus[] {
    return [...this.statuses.values()];
  }

  /** Returns the status for a single platform. */
  getStatus(platform: Platform): PlatformStatus | undefined {
    return this.statuses.get(platform);
  }

  /** Returns the Signal connector, if it was created, so callers can invoke register()/verify(). */
  getSignalConnector(): SignalConnector | undefined {
    return this.connectors.get("signal") as SignalConnector | undefined;
  }

  // ── Connector construction ─────────────────────────────────────────────────

  private _buildConnectors(): void {
    const opts = { config: this.config, logger: this.log };

    // Telegram
    if (this.config.platforms.telegram.enabled) {
      const c = new TelegramConnector(opts);
      this._register(c);
    } else {
      this._initStatus("telegram", false);
    }

    // Discord
    if (this.config.platforms.discord.enabled) {
      const c = new DiscordConnector(opts);
      this._register(c);
    } else {
      this._initStatus("discord", false);
    }

    // Slack
    if (this.config.platforms.slack.enabled) {
      const c = new SlackConnector(opts);
      this._register(c);
    } else {
      this._initStatus("slack", false);
    }

    // WhatsApp
    if (this.config.platforms.whatsapp.enabled) {
      const c = new WhatsAppConnector(opts, (qrBase64) => {
        this.log.info("Emitting WhatsApp QR code to admin UI");
        this.broadcast({
          type: "integration_status" as any,
          payload: { name: "whatsapp_qr", status: "pending_auth", qrBase64 } as any,
        });
      });
      this._register(c);
    } else {
      this._initStatus("whatsapp", false);
    }

    // Signal
    if (this.config.platforms.signal.enabled) {
      const c = new SignalConnector(opts);
      this._register(c);
    } else {
      this._initStatus("signal", false);
    }

    // iMessage (via BlueBubbles)
    if (this.config.platforms.imessage.enabled) {
      const c = new IMessageConnector(opts);
      this._register(c);
    } else {
      this._initStatus("imessage", false);
    }
  }

  private _register(connector: BasePlatformConnector): void {
    const platform = connector.platform;

    this._initStatus(platform, true);
    this.connectors.set(platform, connector);

    // Wire inbound messages to the fan-out handler
    connector.onMessage(async (msg) => {
      this.log.debug({ platform, msgId: msg.id }, "Inbound message received");

      // Broadcast to admin WebSocket
      this.broadcast({ type: "message_received", payload: msg });

      // Dispatch to all registered orchestrator handlers
      for (const handler of this.messageHandlers) {
        try {
          await handler(msg);
        } catch (err) {
          this.log.error({ err, platform, msgId: msg.id }, "Message handler threw");
        }
      }
    });

    // Listen for lifecycle events from the connector
    connector.on("connected", () => {
      const status = this.statuses.get(platform)!;
      status.connected = true;
      status.lastConnectedAt = new Date().toISOString();
      delete status.lastError;

      this.log.info({ platform }, "Platform connected");
      this._broadcastPlatformStatus(platform, "connected");
    });

    connector.on("disconnected", () => {
      const status = this.statuses.get(platform)!;
      status.connected = false;
      status.lastDisconnectedAt = new Date().toISOString();

      this.log.warn({ platform }, "Platform disconnected");
      this._broadcastPlatformStatus(platform, "disconnected");
    });

    connector.on("reconnected", () => {
      const status = this.statuses.get(platform)!;
      status.connected = true;
      status.lastConnectedAt = new Date().toISOString();

      this.log.info({ platform }, "Platform reconnected");
      this._broadcastPlatformStatus(platform, "connected");
    });

    connector.on("reconnect_failed", () => {
      const status = this.statuses.get(platform)!;
      status.lastError = "Max reconnection attempts exhausted";

      this.log.error({ platform }, "Platform reconnection failed permanently");
      this._broadcastPlatformStatus(platform, "error");
    });
  }

  // ── Connector start ────────────────────────────────────────────────────────

  private async _startConnector(connector: BasePlatformConnector): Promise<void> {
    const platform = connector.platform;
    try {
      await connector.start();
      this.log.info({ platform }, "Connector started");
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      this.log.error({ err, platform }, "Connector failed to start");

      const status = this.statuses.get(platform);
      if (status) {
        status.lastError = msg;
        status.connected = false;
      }

      this._broadcastPlatformStatus(platform, "error");
    }
  }

  // ── Health check ───────────────────────────────────────────────────────────

  private async _healthCheck(): Promise<void> {
    for (const [platform, connector] of this.connectors) {
      if (!connector.enabled) continue;

      const status = this.statuses.get(platform);
      if (!status) continue;

      // If the connector reports itself as not connected but the manager
      // thinks it should be (enabled, no permanent failure), restart it.
      if (!connector.isConnected && !this._isPermanentlyFailed(status)) {
        this.log.warn({ platform }, "Health check: connector is down — attempting restart");
        await this._startConnector(connector);
      }
    }
  }

  private _isPermanentlyFailed(status: PlatformStatus): boolean {
    return status.lastError === "Max reconnection attempts exhausted";
  }

  // ── Status helpers ─────────────────────────────────────────────────────────

  private _initStatus(platform: Platform, enabled: boolean): void {
    this.statuses.set(platform, {
      platform,
      enabled,
      connected: false,
    });
  }

  private _broadcastPlatformStatus(
    platform: Platform,
    status: "connected" | "disconnected" | "error"
  ): void {
    // Re-use the integration_status WSEvent shape; the admin UI can filter on name
    this.broadcast({
      type: "integration_status",
      payload: {
        name: `platform:${platform}` as any,
        status: status === "connected"
          ? "connected"
          : status === "disconnected"
          ? "disconnected"
          : "error",
      },
    });
  }
}
