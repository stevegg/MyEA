/**
 * myEA — iMessage Connector (via BlueBubbles Server)
 *
 * Connects to a BlueBubbles server running on the macOS host, which exposes
 * iMessage via a REST + Socket.IO API.
 *
 * API reference: https://docs.bluebubbles.app/server/developer-guides/rest-api-and-webhooks
 *
 * Features:
 *   - Real-time inbound messages via Socket.IO `new-message` event
 *   - Sends messages via POST /api/v1/message/text
 *   - Health check via GET /api/v1/ping
 *   - Reconnects on disconnection with exponential backoff
 *   - Message deduplication via the base class
 *
 * Docker note:
 *   BlueBubbles runs on the macOS host; the container reaches it via
 *   host.docker.internal (resolved automatically by Docker Desktop on macOS).
 */

import { io, type Socket } from "socket.io-client";
import type { OutboundMessage, PlatformMessage } from "../types";
import { BasePlatformConnector, type BaseConnectorOptions } from "./base";

// ─────────────────────────────────────────────────────────────────────────────
// BlueBubbles API types (minimal subset)
// ─────────────────────────────────────────────────────────────────────────────

interface BBHandle {
  address: string;
  displayName?: string;
}

interface BBChat {
  guid: string;
  displayName?: string;
}

interface BBMessage {
  guid?: string;
  text?: string | null;
  isFromMe?: boolean;
  handle?: BBHandle | null;
  chats?: BBChat[];
  dateCreated?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connector
// ─────────────────────────────────────────────────────────────────────────────

export class IMessageConnector extends BasePlatformConnector {
  readonly platform = "imessage" as const;

  private socket: Socket | null = null;

  constructor(opts: BaseConnectorOptions) {
    super(opts.config.platforms.imessage.enabled, {
      ...opts,
      rateLimitCapacity: 10,
      rateLimitRefillRate: 1,
      reconnection: { initialDelayMs: 5_000, maxDelayMs: 60_000, maxAttempts: 10 },
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  protected async doStart(): Promise<void> {
    const { bridgeUrl, password } = this.config.platforms.imessage;

    if (!password) {
      throw new Error("IMESSAGE_PASSWORD is required but not set");
    }

    await this._healthCheck(bridgeUrl, password);
    this._connectSocket(bridgeUrl, password);

    this.log.info({ bridgeUrl }, "iMessage connector connected via BlueBubbles");
  }

  protected async doStop(): Promise<void> {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  protected async doSend(message: OutboundMessage): Promise<void> {
    const { bridgeUrl, password } = this.config.platforms.imessage;

    const tempGuid = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const res = await fetch(
      `${bridgeUrl}/api/v1/message/text?password=${encodeURIComponent(password)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatGuid: message.channelId,
          tempGuid,
          message: message.text,
        }),
        signal: AbortSignal.timeout(15_000),
      }
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => "(no body)");
      throw new Error(`BlueBubbles send failed [${res.status}]: ${errText}`);
    }
  }

  // ── Socket.IO connection ───────────────────────────────────────────────────

  private _connectSocket(bridgeUrl: string, password: string): void {
    this.socket = io(bridgeUrl, {
      query: { password },
      transports: ["websocket"],
      reconnection: false, // We handle reconnection via BasePlatformConnector
    });

    this.socket.on("connect", () => {
      this.log.info("BlueBubbles Socket.IO connected");
    });

    this.socket.on("new-message", async (data: BBMessage | { data: BBMessage }) => {
      // BlueBubbles may wrap the payload in a `data` field
      const msg: BBMessage = "data" in data && typeof (data as any).data === "object"
        ? (data as any).data
        : data;

      await this._handleMessage(msg);
    });

    this.socket.on("disconnect", (reason: string) => {
      this.log.warn({ reason }, "BlueBubbles Socket.IO disconnected");
      this.handleDisconnect(reason);
    });

    this.socket.on("connect_error", (err: Error) => {
      this.log.error({ err: err.message }, "BlueBubbles Socket.IO connection error");
      this.handleDisconnect(err.message);
    });
  }

  // ── Message normalization ──────────────────────────────────────────────────

  private async _handleMessage(msg: BBMessage): Promise<void> {
    // Skip messages sent by us (echo prevention)
    if (msg.isFromMe) return;

    // Need at least text and a sender handle
    const text = msg.text;
    if (!text || text.trim() === "") return;

    const handle = msg.handle;
    if (!handle?.address) return;

    // Use the first chat GUID as the channelId so replies route correctly
    const chatGuid = msg.chats?.[0]?.guid ?? `any;-;${handle.address}`;
    const msgGuid = msg.guid ?? `${handle.address}-${Date.now()}`;

    const platformMsg: PlatformMessage = {
      id: `imessage:${chatGuid}:${msgGuid}`,
      platform: "imessage",
      userId: handle.address,
      userName: handle.displayName || undefined,
      channelId: chatGuid,
      text: text.trim(),
      timestamp: msg.dateCreated
        ? new Date(msg.dateCreated).toISOString()
        : new Date().toISOString(),
      raw: msg,
    };

    await this.dispatchMessage(platformMsg);
  }

  // ── Health check ───────────────────────────────────────────────────────────

  private async _healthCheck(bridgeUrl: string, password: string): Promise<void> {
    const res = await fetch(
      `${bridgeUrl}/api/v1/ping?password=${encodeURIComponent(password)}`,
      { signal: AbortSignal.timeout(8_000) }
    );

    if (!res.ok) {
      throw new Error(`BlueBubbles health check failed: HTTP ${res.status}`);
    }

    this.log.info({ bridgeUrl }, "BlueBubbles server is reachable");
  }
}
