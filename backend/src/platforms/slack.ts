/**
 * myEA — Slack Connector
 *
 * Uses @slack/bolt with Socket Mode (app-level token) for real-time events
 * without a public inbound webhook endpoint.
 *
 * Features:
 *   - Receives direct messages to the bot
 *   - Receives @mentions in public/private channels
 *   - Block Kit rich formatting for outbound messages
 *   - Splits messages > 3000 characters (mrkdwn block limit)
 *   - Stores user/channel IDs for proactive messaging
 */

import { App as BoltApp, LogLevel } from "@slack/bolt";
import type {
  OutboundMessage,
  PlatformMessage,
  MessageEmbed,
  MessageAction,
  AppConfig,
  Logger,
} from "../types";
import { BasePlatformConnector, type BaseConnectorOptions } from "./base";

// Slack Block Kit section text max
const SLACK_SECTION_MAX = 3_000;

// ─────────────────────────────────────────────────────────────────────────────
// Block Kit builders
// ─────────────────────────────────────────────────────────────────────────────

function buildBlocks(
  text: string,
  embeds?: MessageEmbed[],
  actions?: MessageAction[]
): unknown[] {
  const blocks: unknown[] = [];

  // Primary text section
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: text.slice(0, SLACK_SECTION_MAX) },
  });

  // Embed sections
  if (embeds) {
    for (const embed of embeds) {
      if (embed.title || embed.description) {
        blocks.push({ type: "divider" });

        if (embed.title) {
          blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${embed.title}*${embed.description ? `\n${embed.description.slice(0, SLACK_SECTION_MAX - embed.title.length - 3)}` : ""}`,
            },
          });
        } else if (embed.description) {
          blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: embed.description.slice(0, SLACK_SECTION_MAX) },
          });
        }

        if (embed.fields && embed.fields.length > 0) {
          const fieldBlocks = embed.fields.slice(0, 10).map((f) => ({
            type: "mrkdwn",
            text: `*${f.name}*\n${f.value.slice(0, 2_000)}`,
          }));
          // Slack allows up to 10 fields per section
          blocks.push({ type: "section", fields: fieldBlocks });
        }

        if (embed.footer) {
          blocks.push({
            type: "context",
            elements: [{ type: "mrkdwn", text: embed.footer.slice(0, 2_000) }],
          });
        }
      }
    }
  }

  // Action buttons
  if (actions && actions.length > 0) {
    blocks.push({
      type: "actions",
      elements: actions.slice(0, 25).map((action) => ({
        type: "button",
        text: { type: "plain_text", text: action.label.slice(0, 75), emoji: true },
        action_id: action.id,
        value: action.value.slice(0, 2_000),
        ...(action.style === "danger" ? { style: "danger" } : {}),
        ...(action.style === "primary" ? { style: "primary" } : {}),
      })),
    });
  }

  return blocks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connector
// ─────────────────────────────────────────────────────────────────────────────

export class SlackConnector extends BasePlatformConnector {
  readonly platform = "slack" as const;

  private boltApp: BoltApp | null = null;

  constructor(opts: BaseConnectorOptions) {
    super(opts.config.platforms.slack.enabled, {
      ...opts,
      rateLimitCapacity: 50,
      rateLimitRefillRate: 1, // Slack tier-1 limit: ~1 msg/s per channel
      reconnection: { initialDelayMs: 3_000, maxDelayMs: 120_000, maxAttempts: 15 },
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  protected async doStart(): Promise<void> {
    const { botToken, appToken, signingSecret } = this.config.platforms.slack;

    if (!botToken) throw new Error("SLACK_BOT_TOKEN is required but not set");
    if (!appToken) throw new Error("SLACK_APP_TOKEN is required but not set (Socket Mode)");
    if (!signingSecret) throw new Error("SLACK_SIGNING_SECRET is required but not set");

    this.boltApp = new BoltApp({
      token: botToken,
      appToken,
      signingSecret,
      socketMode: true,
      logLevel: this.config.nodeEnv === "development" ? LogLevel.DEBUG : LogLevel.WARN,
    });

    this._registerHandlers(this.boltApp);

    await this.boltApp.start();
    this.log.info("Slack bolt app started (Socket Mode)");
  }

  protected async doStop(): Promise<void> {
    if (this.boltApp) {
      await this.boltApp.stop();
      this.boltApp = null;
    }
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  protected async doSend(message: OutboundMessage): Promise<void> {
    if (!this.boltApp) throw new Error("Slack app is not initialised");

    const chunks = this.splitMessage(message.text, SLACK_SECTION_MAX);

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;

      try {
        await this.boltApp.client.chat.postMessage({
          channel: message.channelId,
          text: chunks[i], // fallback plain text for notifications
          blocks: isLast
            ? (buildBlocks(chunks[i], message.embeds, message.actions) as any)
            : [{ type: "section", text: { type: "mrkdwn", text: chunks[i] } }],
          ...(i === 0 && message.replyToId && !message.proactive
            ? { thread_ts: message.replyToId }
            : {}),
        });
      } catch (err: any) {
        this.log.error({ err, channel: message.channelId }, "Slack chat.postMessage failed");
        throw err;
      }

      if (!isLast) await this._sleep(500);
    }
  }

  // ── Inbound ────────────────────────────────────────────────────────────────

  private _registerHandlers(app: BoltApp): void {
    // Direct messages
    app.message(async ({ message, say }) => {
      const msg = message as any;

      this.log.debug(
        {
          ts: msg.ts,
          channel: msg.channel,
          channel_type: msg.channel_type,
          subtype: msg.subtype ?? null,
          bot_id: msg.bot_id ?? null,
          user: msg.user ?? null,
          text: (msg.text ?? "").slice(0, 80),
        },
        "app.message() received"
      );

      // Only handle messages from humans (no bot messages, no message_changed subtypes)
      if (msg.bot_id || msg.subtype) {
        this.log.debug({ bot_id: msg.bot_id, subtype: msg.subtype }, "app.message() filtered out");
        return;
      }

      const platformMsg: PlatformMessage = {
        id: `slack:${msg.ts}`,
        platform: "slack",
        userId: msg.user ?? "unknown",
        channelId: msg.channel,
        text: msg.text ?? "",
        timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
        raw: message,
      };

      // Try to enrich with user display name
      try {
        const userInfo = await app.client.users.info({ user: msg.user });
        platformMsg.userName =
          userInfo.user?.profile?.display_name ||
          userInfo.user?.real_name ||
          userInfo.user?.name;
      } catch {
        // Non-fatal — proceed without display name
      }

      this.log.debug({ id: platformMsg.id, channel: platformMsg.channelId }, "app.message() dispatching");
      await this.dispatchMessage(platformMsg);
      this.log.debug({ id: platformMsg.id }, "app.message() dispatch complete");
    });

    // @Mentions in channels
    app.event("app_mention", async ({ event }) => {
      const ev = event as any;

      this.log.debug(
        { ts: ev.ts, channel: ev.channel, channel_type: ev.channel_type ?? null, user: ev.user },
        "app_mention received"
      );

      // Strip the mention from the text
      const text = (ev.text ?? "")
        .replace(/<@[A-Z0-9]+>/g, "")
        .trim();

      const platformMsg: PlatformMessage = {
        id: `slack:${ev.ts}`,
        platform: "slack",
        userId: ev.user,
        channelId: ev.channel,
        guildId: ev.team,
        text,
        timestamp: new Date(parseFloat(ev.ts) * 1000).toISOString(),
        raw: event,
      };

      try {
        const userInfo = await this.boltApp!.client.users.info({ user: ev.user });
        platformMsg.userName =
          userInfo.user?.profile?.display_name ||
          userInfo.user?.real_name ||
          userInfo.user?.name;
      } catch {
        // Non-fatal
      }

      await this.dispatchMessage(platformMsg);
    });

    // Button actions
    app.action(/.*/, async ({ action, ack, body }) => {
      await ack();
      const act = action as any;

      const platformMsg: PlatformMessage = {
        id: `slack:action:${act.action_id}:${Date.now()}`,
        platform: "slack",
        userId: (body as any).user?.id ?? "unknown",
        channelId: (body as any).channel?.id ?? (body as any).container?.channel_id ?? "unknown",
        text: act.value ?? act.action_id,
        timestamp: new Date().toISOString(),
        raw: { action, body },
      };

      await this.dispatchMessage(platformMsg);
    });

    // Error handler
    app.error(async (error) => {
      this.log.error({ err: error }, "Slack bolt error");
      // Socket Mode handles reconnection internally; we log but don't re-trigger
    });
  }
}
