/**
 * myEA — Telegram Connector
 *
 * Uses the grammy framework (https://grammy.dev) to connect the bot.
 * Features:
 *   - Handles text messages and built-in commands (/start, /help, /memory, /skills)
 *   - Markdown (MarkdownV2) support in outbound messages
 *   - Automatic splitting of messages > 4096 characters (Telegram limit)
 *   - Persists the chat_id for proactive outbound messaging
 *   - Reconnects on polling errors with exponential backoff
 */

import { Bot, GrammyError, HttpError, type Context } from "grammy";
import type { OutboundMessage, PlatformMessage, AppConfig, Logger } from "../types";
import { BasePlatformConnector, type BaseConnectorOptions } from "./base";

// Telegram's hard limit for a single message
const TELEGRAM_MAX_LENGTH = 4_096;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Escape characters that have special meaning in Telegram MarkdownV2.
 * Only call this on plain text — do NOT escape pre-formatted blocks.
 */
function escapeMdV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Connector
// ─────────────────────────────────────────────────────────────────────────────

export class TelegramConnector extends BasePlatformConnector {
  readonly platform = "telegram" as const;

  private bot: Bot | null = null;

  constructor(opts: BaseConnectorOptions) {
    super(opts.config.platforms.telegram.enabled, {
      ...opts,
      rateLimitCapacity: 30,
      rateLimitRefillRate: 1, // Telegram global limit: ~30 msg/s
      reconnection: { initialDelayMs: 2_000, maxDelayMs: 120_000, maxAttempts: 20 },
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  protected async doStart(): Promise<void> {
    const { botToken } = this.config.platforms.telegram;
    if (!botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is required but not set");
    }

    this.bot = new Bot(botToken);
    this._registerHandlers(this.bot);

    // Start long-polling; grammy manages its own loop
    await this.bot.init();
    this.bot.start({
      onStart: (botInfo) => {
        this.log.info({ username: botInfo.username }, "Telegram bot started (long-polling)");
      },
    });

    // grammy's start() is non-blocking — errors surface through the error handler
    this.bot.catch((err) => {
      if (err instanceof GrammyError) {
        this.log.error({ code: err.error_code, description: err.description }, "Telegram API error");
      } else if (err instanceof HttpError) {
        this.log.error({ err }, "Telegram HTTP error — scheduling reconnect");
        this.handleDisconnect("HttpError");
      } else {
        this.log.error({ err }, "Telegram unexpected error");
        this.handleDisconnect("UnexpectedError");
      }
    });
  }

  protected async doStop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  protected async doSend(message: OutboundMessage): Promise<void> {
    if (!this.bot) throw new Error("Bot is not initialised");

    const chatId = message.channelId;
    const chunks = this.splitMessage(message.text, TELEGRAM_MAX_LENGTH);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isLast = i === chunks.length - 1;

      const sendOpts: Parameters<Bot["api"]["sendMessage"]>[2] = {
        parse_mode: "MarkdownV2",
      };

      // Only attach reply_to on first chunk and only when not proactive
      if (i === 0 && message.replyToId && !message.proactive) {
        sendOpts.reply_parameters = { message_id: parseInt(message.replyToId, 10) };
      }

      // Attach inline keyboard on last chunk if actions are specified
      if (isLast && message.actions && message.actions.length > 0) {
        sendOpts.reply_markup = {
          inline_keyboard: [
            message.actions.map((action) => ({
              text: action.label,
              callback_data: action.value,
            })),
          ],
        };
      }

      try {
        await this.bot.api.sendMessage(chatId, chunk, sendOpts);
      } catch (err) {
        // Fallback: retry without markdown if parsing failed
        if (
          err instanceof GrammyError &&
          err.description.includes("can't parse entities")
        ) {
          this.log.warn({ chatId }, "MarkdownV2 parse error — retrying as plain text");
          const plainOpts = { ...sendOpts };
          delete (plainOpts as any).parse_mode;
          await this.bot.api.sendMessage(chatId, chunks[i], plainOpts);
        } else {
          throw err;
        }
      }

      // Small inter-chunk delay to respect rate limits
      if (!isLast) await this._sleep(300);
    }
  }

  // ── Inbound handler registration ──────────────────────────────────────────

  private _registerHandlers(bot: Bot): void {
    // /start command
    bot.command("start", async (ctx) => {
      await this._handleCommand(ctx, "start");
    });

    // /help command
    bot.command("help", async (ctx) => {
      await this._handleCommand(ctx, "help");
    });

    // /memory command
    bot.command("memory", async (ctx) => {
      await this._handleCommand(ctx, "memory");
    });

    // /skills command
    bot.command("skills", async (ctx) => {
      await this._handleCommand(ctx, "skills");
    });

    // Regular text messages (no command prefix)
    bot.on("message:text", async (ctx) => {
      if (!ctx.message.text.startsWith("/")) {
        await this._handleMessage(ctx);
      }
    });

    // Callback queries from inline keyboards
    bot.on("callback_query:data", async (ctx) => {
      await ctx.answerCallbackQuery();
      const platformMsg = this._buildPlatformMessage(
        ctx.callbackQuery.id,
        ctx.callbackQuery.data,
        ctx.callbackQuery.from,
        String(ctx.callbackQuery.message?.chat.id ?? ctx.callbackQuery.from.id),
        new Date().toISOString(),
        ctx.callbackQuery
      );
      await this.dispatchMessage(platformMsg);
    });
  }

  private async _handleCommand(ctx: Context, command: string): Promise<void> {
    if (!ctx.message || !ctx.from) return;
    const text = `/${command}${ctx.message.text?.slice(command.length + 1) ?? ""}`;
    const platformMsg = this._buildPlatformMessage(
      String(ctx.message.message_id),
      text,
      ctx.from,
      String(ctx.message.chat.id),
      new Date(ctx.message.date * 1000).toISOString(),
      ctx.message
    );
    await this.dispatchMessage(platformMsg);
  }

  private async _handleMessage(ctx: Context): Promise<void> {
    if (!ctx.message || !ctx.from || !ctx.message.text) return;
    const platformMsg = this._buildPlatformMessage(
      String(ctx.message.message_id),
      ctx.message.text,
      ctx.from,
      String(ctx.message.chat.id),
      new Date(ctx.message.date * 1000).toISOString(),
      ctx.message
    );
    await this.dispatchMessage(platformMsg);
  }

  private _buildPlatformMessage(
    id: string,
    text: string,
    from: { id: number; first_name?: string; last_name?: string; username?: string },
    chatId: string,
    timestamp: string,
    raw: unknown
  ): PlatformMessage {
    const nameParts = [from.first_name, from.last_name].filter(Boolean);
    const userName = from.username
      ? `@${from.username}`
      : nameParts.join(" ") || String(from.id);

    return {
      id: `telegram:${id}`,
      platform: "telegram",
      userId: String(from.id),
      userName,
      channelId: chatId,
      text,
      timestamp,
      raw,
    };
  }
}
