/**
 * myEA — Discord Connector
 *
 * Uses discord.js v14 to receive and send messages.
 * Features:
 *   - Handles DMs sent directly to the bot
 *   - Rich embed support (maps OutboundMessage.embeds → Discord EmbedBuilder)
 *   - Automatic splitting of messages > 2000 characters (Discord limit)
 *   - Stores channel/user IDs so the orchestrator can send proactive messages
 *   - Reconnects on WebSocket close / rate-limit errors
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message as DiscordMessage,
  ChannelType,
  Events,
  type TextChannel,
  type DMChannel,
} from "discord.js";
import type { OutboundMessage, PlatformMessage, MessageEmbed, MessageAction } from "../types";
import { BasePlatformConnector, type BaseConnectorOptions } from "./base";

const DISCORD_MAX_LENGTH = 2_000;
const DISCORD_EMBED_FIELD_MAX = 1_024;
const DISCORD_EMBED_DESC_MAX = 4_096;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildEmbeds(embeds: MessageEmbed[]): EmbedBuilder[] {
  return embeds.map((e) => {
    const builder = new EmbedBuilder();
    if (e.title) builder.setTitle(e.title.slice(0, 256));
    if (e.description) builder.setDescription(e.description.slice(0, DISCORD_EMBED_DESC_MAX));
    if (e.url) builder.setURL(e.url);
    if (e.color !== undefined) builder.setColor(e.color);
    if (e.footer) builder.setFooter({ text: e.footer.slice(0, 2_048) });
    if (e.thumbnail) builder.setThumbnail(e.thumbnail);
    if (e.image) builder.setImage(e.image);
    if (e.timestamp) builder.setTimestamp(new Date(e.timestamp));
    if (e.fields) {
      for (const field of e.fields.slice(0, 25)) {
        builder.addFields({
          name: field.name.slice(0, 256),
          value: field.value.slice(0, DISCORD_EMBED_FIELD_MAX),
          inline: field.inline,
        });
      }
    }
    return builder;
  });
}

function buildActionRows(
  actions: MessageAction[]
): ActionRowBuilder<ButtonBuilder>[] {
  // Discord allows max 5 buttons per row and max 5 rows
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const buttons = actions.slice(0, 25);

  for (let i = 0; i < buttons.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    const slice = buttons.slice(i, i + 5);
    for (const action of slice) {
      const btn = new ButtonBuilder()
        .setCustomId(action.id)
        .setLabel(action.label.slice(0, 80));

      switch (action.style) {
        case "primary":
          btn.setStyle(ButtonStyle.Primary);
          break;
        case "danger":
          btn.setStyle(ButtonStyle.Danger);
          break;
        case "link":
          btn.setStyle(ButtonStyle.Link).setURL(action.value);
          break;
        default:
          btn.setStyle(ButtonStyle.Secondary);
      }

      if (action.style !== "link") {
        btn.setCustomId(action.id);
      }

      row.addComponents(btn);
    }
    rows.push(row);
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connector
// ─────────────────────────────────────────────────────────────────────────────

export class DiscordConnector extends BasePlatformConnector {
  readonly platform = "discord" as const;

  private client: Client | null = null;

  constructor(opts: BaseConnectorOptions) {
    super(opts.config.platforms.discord.enabled, {
      ...opts,
      rateLimitCapacity: 50,
      rateLimitRefillRate: 5,
      reconnection: { initialDelayMs: 3_000, maxDelayMs: 120_000, maxAttempts: 15 },
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  protected async doStart(): Promise<void> {
    const { botToken } = this.config.platforms.discord;
    if (!botToken) {
      throw new Error("DISCORD_BOT_TOKEN is required but not set");
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this._registerHandlers(this.client);

    await this.client.login(botToken);

    // doStart resolves when the client is ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Discord login timed out after 30 s")),
        30_000
      );
      this.client!.once(Events.ClientReady, () => {
        clearTimeout(timeout);
        this.log.info(
          { username: this.client!.user?.tag },
          "Discord bot is ready"
        );
        resolve();
      });
      this.client!.once(Events.Error, (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  protected async doStop(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  protected async doSend(message: OutboundMessage): Promise<void> {
    if (!this.client) throw new Error("Discord client is not initialised");

    const channel = await this._resolveChannel(message.channelId);
    if (!channel) {
      throw new Error(`Cannot resolve Discord channel: ${message.channelId}`);
    }

    const chunks = this.splitMessage(message.text, DISCORD_MAX_LENGTH);

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const sendPayload: Parameters<typeof channel.send>[0] = { content: chunks[i] };

      // Attach embeds + actions only on the last chunk
      if (isLast) {
        if (message.embeds && message.embeds.length > 0) {
          sendPayload.embeds = buildEmbeds(message.embeds.slice(0, 10));
        }
        if (message.actions && message.actions.length > 0) {
          sendPayload.components = buildActionRows(message.actions) as any;
        }
      }

      // If replying, reference the original message on the first chunk only
      if (i === 0 && message.replyToId && !message.proactive) {
        sendPayload.reply = { messageReference: message.replyToId } as any;
      }

      await (channel as TextChannel | DMChannel).send(sendPayload);

      if (!isLast) await this._sleep(500);
    }
  }

  // ── Inbound ────────────────────────────────────────────────────────────────

  private _registerHandlers(client: Client): void {
    client.on(Events.MessageCreate, async (msg: DiscordMessage) => {
      // Ignore own messages
      if (msg.author.bot) return;

      // We handle:
      //   1. Direct messages (always)
      //   2. Guild messages where the bot is @mentioned
      const isDM = msg.channel.type === ChannelType.DM;
      const isMention =
        msg.guild !== null &&
        client.user !== null &&
        msg.mentions.has(client.user);

      if (!isDM && !isMention) return;

      // Strip the mention prefix from guild messages
      let text = msg.content;
      if (isMention && client.user) {
        text = text
          .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
          .trim();
      }

      const platformMsg: PlatformMessage = {
        id: `discord:${msg.id}`,
        platform: "discord",
        userId: msg.author.id,
        userName: msg.author.tag,
        channelId: msg.channel.id,
        guildId: msg.guild?.id,
        text,
        timestamp: msg.createdAt.toISOString(),
        attachments: msg.attachments.map((att) => ({
          id: att.id,
          type: this.attachmentType(att.contentType),
          url: att.url,
          mimeType: att.contentType ?? undefined,
          fileName: att.name ?? undefined,
          size: att.size,
        })),
        raw: {
          messageId: msg.id,
          channelId: msg.channel.id,
          guildId: msg.guild?.id,
          authorId: msg.author.id,
        },
      };

      await this.dispatchMessage(platformMsg);
    });

    // Interaction create (button presses, slash commands)
    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton()) return;

      const platformMsg: PlatformMessage = {
        id: `discord:interaction:${interaction.id}`,
        platform: "discord",
        userId: interaction.user.id,
        userName: interaction.user.tag,
        channelId: interaction.channelId,
        guildId: interaction.guildId ?? undefined,
        text: interaction.customId,
        timestamp: new Date().toISOString(),
        raw: interaction,
      };

      await interaction.deferUpdate().catch(() => {});
      await this.dispatchMessage(platformMsg);
    });

    client.on(Events.ShardDisconnect, (_, shardId) => {
      this.log.warn({ shardId }, "Discord shard disconnected");
      this.handleDisconnect(`Shard ${shardId} disconnected`);
    });

    client.on(Events.Error, (err) => {
      this.log.error({ err }, "Discord client error");
    });

    client.on(Events.Warn, (msg) => {
      this.log.warn({ msg }, "Discord warning");
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async _resolveChannel(
    channelId: string
  ): Promise<TextChannel | DMChannel | null> {
    if (!this.client) return null;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (
        channel &&
        (channel.type === ChannelType.DM ||
          channel.type === ChannelType.GuildText ||
          channel.type === ChannelType.GuildAnnouncement)
      ) {
        return channel as TextChannel | DMChannel;
      }
      return null;
    } catch (err) {
      this.log.error({ err, channelId }, "Failed to fetch Discord channel");
      return null;
    }
  }

}
