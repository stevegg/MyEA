/**
 * myEA — Signal Connector
 *
 * Communicates with the signal-cli-rest-api Docker sidecar over HTTP.
 * API reference: https://github.com/bbernhard/signal-cli-rest-api
 *
 * Features:
 *   - Polls GET /v1/receive/{number} on a configurable interval
 *   - Sends messages via POST /v1/send
 *   - Registration flow via PUT /v1/register/{number}
 *   - Reconnects on network errors with exponential backoff
 *   - Message deduplication via the base class
 */

import type { OutboundMessage, PlatformMessage } from "../types";
import { BasePlatformConnector, type BaseConnectorOptions } from "./base";

// ─────────────────────────────────────────────────────────────────────────────
// Signal REST API types (minimal subset we need)
// ─────────────────────────────────────────────────────────────────────────────

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceName?: string;
  sourceDevice?: number;
  timestamp?: number;
  dataMessage?: {
    message?: string;
    timestamp?: number;
    attachments?: Array<{
      id?: string;
      contentType?: string;
      filename?: string;
      size?: number;
    }>;
  };
  syncMessage?: unknown;
  receiptMessage?: unknown;
  typingMessage?: unknown;
  callMessage?: unknown;
}

interface SignalReceiveResponse {
  envelope: SignalEnvelope;
  account?: string;
}

interface SignalSendRequest {
  recipients: string[];
  message: string;
  number: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connector
// ─────────────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;
// Signal API default max: no hard limit, but keep messages reasonable
const SIGNAL_MAX_LENGTH = 4_096;

export class SignalConnector extends BasePlatformConnector {
  readonly platform = "signal" as const;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: BaseConnectorOptions) {
    super(opts.config.platforms.signal.enabled, {
      ...opts,
      rateLimitCapacity: 20,
      rateLimitRefillRate: 1,
      reconnection: { initialDelayMs: 5_000, maxDelayMs: 120_000, maxAttempts: 20 },
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  protected async doStart(): Promise<void> {
    const { phoneNumber, cliUrl } = this.config.platforms.signal;
    if (!phoneNumber) {
      throw new Error("SIGNAL_PHONE_NUMBER is required but not set");
    }

    // Verify connectivity to the sidecar
    await this._healthCheck(cliUrl);

    this.running = true;
    this._startPolling();
    this.log.info({ phoneNumber, cliUrl, intervalMs: POLL_INTERVAL_MS }, "Signal connector polling started");
  }

  protected async doStop(): Promise<void> {
    this.running = false;
    this._stopPolling();
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  protected async doSend(message: OutboundMessage): Promise<void> {
    const { phoneNumber, cliUrl } = this.config.platforms.signal;
    if (!phoneNumber) throw new Error("SIGNAL_PHONE_NUMBER is not configured");

    const chunks = this.splitMessage(message.text, SIGNAL_MAX_LENGTH);

    for (let i = 0; i < chunks.length; i++) {
      const body: SignalSendRequest = {
        number: phoneNumber,
        recipients: [message.channelId],
        message: chunks[i],
      };

      const res = await this._fetch(`${cliUrl}/v2/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "(no body)");
        throw new Error(`Signal send failed [${res.status}]: ${errText}`);
      }

      if (i < chunks.length - 1) await this._sleep(500);
    }
  }

  // ── Registration ───────────────────────────────────────────────────────────

  /**
   * Initiate device registration. Call this from an admin API route or
   * directly when `SIGNAL_PHONE_NUMBER` is set but the device is not yet
   * registered.
   *
   * @param captcha Optional hCaptcha token required by Signal in some regions.
   */
  async register(captcha?: string): Promise<void> {
    const { phoneNumber, cliUrl } = this.config.platforms.signal;
    if (!phoneNumber) throw new Error("SIGNAL_PHONE_NUMBER is not set");

    const url = `${cliUrl}/v1/register/${encodeURIComponent(phoneNumber)}`;
    const body: Record<string, unknown> = { use_voice: false };
    if (captcha) body.captcha = captcha;

    const res = await this._fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "(no body)");
      throw new Error(`Signal register failed [${res.status}]: ${errText}`);
    }

    this.log.info({ phoneNumber }, "Signal registration initiated — check for SMS/call");
  }

  /**
   * Verify the SMS/voice PIN received during registration.
   */
  async verify(pin: string): Promise<void> {
    const { phoneNumber, cliUrl } = this.config.platforms.signal;
    if (!phoneNumber) throw new Error("SIGNAL_PHONE_NUMBER is not set");

    const url = `${cliUrl}/v1/register/${encodeURIComponent(phoneNumber)}/verify/${encodeURIComponent(pin)}`;
    const res = await this._fetch(url, { method: "POST" });

    if (!res.ok) {
      const errText = await res.text().catch(() => "(no body)");
      throw new Error(`Signal verify failed [${res.status}]: ${errText}`);
    }

    this.log.info({ phoneNumber }, "Signal device verified successfully");
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  private _startPolling(): void {
    this.pollTimer = setInterval(async () => {
      if (!this.running) return;
      try {
        await this._poll();
      } catch (err) {
        this.log.error({ err }, "Signal poll error");
        // If polling fails consecutively the handleDisconnect will trigger reconnection
        this._stopPolling();
        this.handleDisconnect("poll error");
      }
    }, POLL_INTERVAL_MS);
  }

  private _stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async _poll(): Promise<void> {
    const { phoneNumber, cliUrl } = this.config.platforms.signal;
    if (!phoneNumber) return;

    const url = `${cliUrl}/v1/receive/${encodeURIComponent(phoneNumber)}`;
    const res = await this._fetch(url, { method: "GET" });

    if (!res.ok) {
      const errText = await res.text().catch(() => "(no body)");
      throw new Error(`Signal receive failed [${res.status}]: ${errText}`);
    }

    const body = await res.json() as SignalReceiveResponse[] | null;
    if (!body || !Array.isArray(body) || body.length === 0) return;

    for (const item of body) {
      await this._handleEnvelope(item.envelope);
    }
  }

  private async _handleEnvelope(envelope: SignalEnvelope): Promise<void> {
    const dataMsg = envelope.dataMessage;
    if (!dataMsg || !dataMsg.message) return;

    const source =
      envelope.sourceNumber || envelope.source || "unknown";
    const timestamp =
      dataMsg.timestamp != null
        ? new Date(dataMsg.timestamp).toISOString()
        : new Date().toISOString();

    const msgId = `signal:${source}:${dataMsg.timestamp ?? Date.now()}`;

    const platformMsg: PlatformMessage = {
      id: msgId,
      platform: "signal",
      userId: source,
      userName: envelope.sourceName || undefined,
      channelId: source,
      text: dataMsg.message,
      timestamp,
      attachments: dataMsg.attachments?.map((att) => ({
        id: att.id ?? String(Date.now()),
        type: this.attachmentType(att.contentType),
        mimeType: att.contentType,
        fileName: att.filename,
        size: att.size,
      })),
      raw: envelope,
    };

    await this.dispatchMessage(platformMsg);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async _healthCheck(cliUrl: string): Promise<void> {
    try {
      const res = await this._fetch(`${cliUrl}/v1/about`, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        throw new Error(`Health check returned ${res.status}`);
      }
      this.log.info({ cliUrl }, "Signal sidecar is reachable");
    } catch (err) {
      this.log.warn({ err, cliUrl }, "Signal sidecar health check failed — will retry on first poll");
    }
  }

  /** Thin fetch wrapper with a sensible timeout. */
  private async _fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      return await fetch(url, {
        ...init,
        signal: init.signal ?? controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

}
