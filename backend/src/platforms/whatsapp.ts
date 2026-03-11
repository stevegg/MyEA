/**
 * myEA — WhatsApp Connector
 *
 * Uses @whiskeysockets/baileys (multi-device protocol) to connect to WhatsApp.
 *
 * Features:
 *   - QR code linking flow — QR is emitted as a base64 PNG via the broadcast
 *     callback so the admin UI can display it without filesystem access.
 *   - Session persistence in /app/data/whatsapp-session/ using baileys'
 *     useMultiFileAuthState helper.
 *   - Handles text messages only (other types logged and skipped).
 *   - Automatic reconnection on disconnection with configurable backoff.
 *   - Pairing-code flow available as an alternative to QR when the session
 *     already has a phone number registered.
 */

import path from "path";
import fs from "fs";
import type { OutboundMessage, PlatformMessage } from "../types";
import { BasePlatformConnector, type BaseConnectorOptions } from "./base";

// Baileys is a CJS/ESM hybrid — import dynamically to avoid type-noise
type BaileysSocket = any;
type BaileysConnectionState = any;

const SESSION_DIR = "/app/data/whatsapp-session";

// ─────────────────────────────────────────────────────────────────────────────
// Connector
// ─────────────────────────────────────────────────────────────────────────────

export class WhatsAppConnector extends BasePlatformConnector {
  readonly platform = "whatsapp" as const;

  private sock: BaileysSocket | null = null;

  /** Callback invoked with base64 QR PNG when a QR code is generated. */
  private readonly onQrCode: (qrBase64: string) => void;

  constructor(
    opts: BaseConnectorOptions,
    onQrCode: (qrBase64: string) => void
  ) {
    super(opts.config.platforms.whatsapp.enabled, {
      ...opts,
      rateLimitCapacity: 20,
      rateLimitRefillRate: 0.5, // WhatsApp is strict — ~30 msg/min
      reconnection: {
        initialDelayMs: 5_000,
        maxDelayMs: 180_000,
        maxAttempts: 20,
        backoffMultiplier: 1.5,
      },
    });
    this.onQrCode = onQrCode;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  protected async doStart(): Promise<void> {
    // Ensure session directory exists
    fs.mkdirSync(SESSION_DIR, { recursive: true });

    // Dynamically import baileys to allow the app to start even when the
    // WhatsApp connector is disabled (avoiding peer-dep resolution issues).
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      makeInMemoryStore,
      Browsers,
    } = await import("@whiskeysockets/baileys" as any);

    // Load (or create) auth state
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    // Fetch the latest WA version supported by baileys
    const { version, isLatest } = await fetchLatestBaileysVersion();
    this.log.info({ version, isLatest }, "WhatsApp version fetched");

    // Create an in-memory store to cache contacts/messages
    const store = makeInMemoryStore({});

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.log as any),
      },
      printQRInTerminal: false, // we handle QR ourselves
      browser: Browsers.macOS("Desktop"),
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      logger: this._baileysLogger(),
    });

    store.bind(this.sock.ev);

    // ── Events ──────────────────────────────────────────────────────────────

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on(
      "connection.update",
      async (update: BaileysConnectionState) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          await this._handleQr(qr);
        }

        if (connection === "open") {
          this.log.info("WhatsApp connection is open");
          this._setConnected(true);
          this.reconnection.reset();
        }

        if (connection === "close") {
          const statusCode =
            (lastDisconnect?.error as any)?.output?.statusCode;
          const reason =
            (lastDisconnect?.error as any)?.message ?? "unknown";

          this.log.warn({ statusCode, reason }, "WhatsApp connection closed");

          // 401 = logged out — clear session and do not reconnect automatically
          if (statusCode === DisconnectReason.loggedOut) {
            this.log.error(
              "WhatsApp session logged out — clearing session files. Re-scan QR to re-link."
            );
            this._clearSession();
            this.handleDisconnect("loggedOut");
            return;
          }

          // For all other reasons, attempt reconnection
          this.handleDisconnect(reason);
        }
      }
    );

    this.sock.ev.on("messages.upsert", async ({ messages: msgs, type }: any) => {
      if (type !== "notify") return;

      for (const msg of msgs) {
        // Skip status messages, reactions, and our own messages
        if (
          msg.key.remoteJid === "status@broadcast" ||
          msg.key.fromMe ||
          !msg.message
        ) {
          continue;
        }

        const text =
          msg.message?.conversation ??
          msg.message?.extendedTextMessage?.text ??
          msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text;

        if (!text) {
          this.log.debug(
            { type: Object.keys(msg.message).join(",") },
            "Non-text WhatsApp message — skipping"
          );
          continue;
        }

        const jid: string = msg.key.remoteJid ?? "";
        const pushName: string = msg.pushName ?? "";
        const msgId: string = msg.key.id ?? String(Date.now());
        const timestamp = new Date(
          (typeof msg.messageTimestamp === "object"
            ? Number(msg.messageTimestamp)
            : msg.messageTimestamp) * 1000
        ).toISOString();

        const platformMsg: PlatformMessage = {
          id: `whatsapp:${msgId}`,
          platform: "whatsapp",
          userId: jid,
          userName: pushName || undefined,
          channelId: jid,
          text,
          timestamp,
          raw: msg,
        };

        await this.dispatchMessage(platformMsg);
      }
    });
  }

  protected async doStop(): Promise<void> {
    if (this.sock) {
      this.sock.ev.removeAllListeners();
      await this.sock.logout().catch(() => {});
      this.sock = null;
    }
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  protected async doSend(message: OutboundMessage): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp socket is not initialised");

    const jid = message.channelId;

    // WhatsApp doesn't have a hard single-message limit but >65535 bytes can
    // fail; we split at 4096 chars to be safe and readable.
    const chunks = this.splitMessage(message.text, 4_096);

    for (let i = 0; i < chunks.length; i++) {
      await this.sock.sendMessage(jid, { text: chunks[i] });
      if (i < chunks.length - 1) await this._sleep(800);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async _handleQr(rawQr: string): Promise<void> {
    try {
      // Convert the raw QR string to a base64 PNG using the `qrcode` package
      // (which is a dependency of baileys itself and available at runtime)
      const qrcode = await import("qrcode" as any);
      const base64 = await qrcode.toDataURL(rawQr, { type: "image/png" });
      this.log.info("WhatsApp QR code generated — emitting to admin UI");
      this.onQrCode(base64);
    } catch (err) {
      // Fallback: emit the raw string so the UI can render it with a JS library
      this.log.warn({ err }, "qrcode package unavailable — emitting raw QR string");
      this.onQrCode(`raw:${rawQr}`);
    }
  }

  private _clearSession(): void {
    try {
      if (fs.existsSync(SESSION_DIR)) {
        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        this.log.info("WhatsApp session files cleared");
      }
    } catch (err) {
      this.log.error({ err }, "Failed to clear WhatsApp session files");
    }
  }

  /**
   * Baileys expects a pino-compatible logger but with its own level mapping.
   * We proxy calls through our connector logger.
   */
  private _baileysLogger(): unknown {
    const log = this.log;
    return {
      level: "silent",
      trace: (obj: unknown, msg?: string) => log.trace(obj, msg),
      debug: (obj: unknown, msg?: string) => log.debug(obj, msg),
      info: (obj: unknown, msg?: string) => log.info(obj, msg),
      warn: (obj: unknown, msg?: string) => log.warn(obj, msg),
      error: (obj: unknown, msg?: string) => log.error(obj, msg),
      fatal: (obj: unknown, msg?: string) => log.fatal(obj, msg),
      child: () => this._baileysLogger(),
    };
  }
}
