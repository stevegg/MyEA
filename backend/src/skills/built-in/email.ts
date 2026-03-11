/**
 * myEA — Built-in Skill: Email (Gmail)
 *
 * Wraps the Gmail REST API via googleapis. OAuth2 credentials come from
 * config.integrations.gmail (populated by environment variables). The
 * refresh token is used to obtain short-lived access tokens automatically.
 *
 * All message bodies are returned as plain text (HTML stripped).
 */

import { google, gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { eq } from "drizzle-orm";

import type { Skill, SkillContext, ExecutionContext, ToolResult } from "../../types";
import { getErrorMessage, BUILT_IN_SKILL_VERSION } from "../../utils";
import { integrations } from "../../db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────────────────────────

let oauth2Client: OAuth2Client | null = null;
let gmailClient: gmail_v1.Gmail | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getGmail(): gmail_v1.Gmail {
  if (!gmailClient) throw new Error("Gmail skill is not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN.");
  return gmailClient;
}

function notConfigured(): ToolResult {
  return {
    content: "Gmail is not configured. Provide GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN.",
    isError: true,
  };
}

/** Decode base64url to a UTF-8 string. */
function base64Decode(encoded: string): string {
  return Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

/** Strip HTML tags from a string. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Recursively extract plain text from a MIME part tree. */
function extractText(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return base64Decode(part.body.data);
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return stripHtml(base64Decode(part.body.data));
  }
  if (part.parts) {
    for (const sub of part.parts) {
      const text = extractText(sub);
      if (text) return text;
    }
  }
  return "";
}

/** Extract a header value by name. */
function header(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Build a base64url-encoded RFC 2822 email message. */
function buildRawMessage(args: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const lines: string[] = [
    `To: ${args.to}`,
    `Subject: ${args.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
  ];
  if (args.cc) lines.push(`Cc: ${args.cc}`);
  if (args.inReplyTo) lines.push(`In-Reply-To: ${args.inReplyTo}`);
  if (args.references) lines.push(`References: ${args.references}`);
  lines.push("", args.body);
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────────────────────────────────────

async function listEmails(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  if (!gmailClient) return notConfigured();
  const { query = "", maxResults = 20 } = (params as { query?: string; maxResults?: number }) ?? {};
  try {
    const gmail = getGmail();
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: query || undefined,
      maxResults,
    });
    const messages = listRes.data.messages ?? [];
    if (messages.length === 0) {
      return { content: "No messages found.", data: { messages: [] } };
    }

    // Fetch metadata for each message in parallel (concurrent batch, not sequential).
    const summaries = await Promise.all(
      messages.slice(0, maxResults).map(async (msg) => {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"],
        });
        const hdrs = detail.data.payload?.headers ?? [];
        return {
          id: msg.id!,
          from: header(hdrs, "From"),
          subject: header(hdrs, "Subject"),
          date: header(hdrs, "Date"),
          snippet: detail.data.snippet ?? "",
        };
      })
    );

    const lines = summaries.map(
      (m) => `[${m.id}] ${m.date}\n  From: ${m.from}\n  Subject: ${m.subject}\n  ${m.snippet}`
    );
    return { content: lines.join("\n\n"), data: { messages: summaries } };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to list emails: ${msg}`, isError: true };
  }
}

async function readEmail(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  if (!gmailClient) return notConfigured();
  const { messageId } = params as { messageId: string };
  try {
    const gmail = getGmail();
    const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const msg = res.data;
    const hdrs = msg.payload?.headers ?? [];
    const body = extractText(msg.payload ?? undefined);
    const result = {
      id: msg.id ?? messageId,
      from: header(hdrs, "From"),
      to: header(hdrs, "To"),
      subject: header(hdrs, "Subject"),
      date: header(hdrs, "Date"),
      body,
    };
    return {
      content: `From: ${result.from}\nTo: ${result.to}\nDate: ${result.date}\nSubject: ${result.subject}\n\n${body}`,
      data: result,
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to read email: ${msg}`, isError: true };
  }
}

async function sendEmail(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  if (!gmailClient) return notConfigured();
  const { to, subject, body, cc } = params as { to: string; subject: string; body: string; cc?: string };
  try {
    const gmail = getGmail();
    const raw = buildRawMessage({ to, subject, body, cc });
    const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    return {
      content: `Email sent. Message ID: ${res.data.id}`,
      data: { messageId: res.data.id },
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to send email: ${msg}`, isError: true };
  }
}

async function replyToEmail(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  if (!gmailClient) return notConfigured();
  const { messageId, body } = params as { messageId: string; body: string };
  try {
    const gmail = getGmail();
    const original = await gmail.users.messages.get({ userId: "me", id: messageId, format: "metadata", metadataHeaders: ["From", "Subject", "Message-ID", "References"] });
    const hdrs = original.data.payload?.headers ?? [];
    const to = header(hdrs, "From");
    const subject = `Re: ${header(hdrs, "Subject").replace(/^Re:\s*/i, "")}`;
    const inReplyTo = header(hdrs, "Message-ID");
    const refs = [header(hdrs, "References"), inReplyTo].filter(Boolean).join(" ");

    const raw = buildRawMessage({ to, subject, body, inReplyTo, references: refs });
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId: original.data.threadId ?? undefined },
    });
    return { content: `Reply sent. Message ID: ${res.data.id}`, data: { messageId: res.data.id } };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to reply: ${msg}`, isError: true };
  }
}

async function searchEmails(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  // Delegates to listEmails with the query pre-filled.
  return listEmails({ ...(params as object), maxResults: 20 }, _ctx);
}

async function markRead(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  if (!gmailClient) return notConfigured();
  const { messageId } = params as { messageId: string };
  try {
    const gmail = getGmail();
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });
    return { content: `Message ${messageId} marked as read.` };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to mark read: ${msg}`, isError: true };
  }
}

async function deleteEmail(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  if (!gmailClient) return notConfigured();
  const { messageId } = params as { messageId: string };
  try {
    const gmail = getGmail();
    // Trash instead of permanently delete for safety.
    await gmail.users.messages.trash({ userId: "me", id: messageId });
    return { content: `Message ${messageId} moved to trash.` };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to delete email: ${msg}`, isError: true };
  }
}

async function listLabels(_params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  if (!gmailClient) return notConfigured();
  try {
    const gmail = getGmail();
    const res = await gmail.users.labels.list({ userId: "me" });
    const labels = (res.data.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type }));
    const lines = labels.map((l) => `${l.name} (${l.id})`);
    return { content: lines.join("\n") || "No labels.", data: { labels } };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to list labels: ${msg}`, isError: true };
  }
}

async function createDraft(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  if (!gmailClient) return notConfigured();
  const { to, subject, body } = params as { to: string; subject: string; body: string };
  try {
    const gmail = getGmail();
    const raw = buildRawMessage({ to, subject, body });
    const res = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
    return { content: `Draft created. Draft ID: ${res.data.id}`, data: { draftId: res.data.id } };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to create draft: ${msg}`, isError: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill definition
// ─────────────────────────────────────────────────────────────────────────────

const emailSkill: Skill = {
  name: "email",
  description: "Read, send, search, and manage Gmail messages using the Gmail API.",
  version: BUILT_IN_SKILL_VERSION,

  async setup(context: SkillContext): Promise<void> {
    const { clientId, clientSecret, redirectUri, refreshToken: envRefreshToken, enabled } = context.config.integrations.gmail;

    if (!clientId || !clientSecret) {
      context.logger.warn("Email skill: GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not set — skill unavailable.");
      return;
    }

    // Prefer the refresh token stored in the DB (from the OAuth web flow) over the
    // env-var token, since the DB token is always the most recently issued one.
    let refreshToken = envRefreshToken;
    try {
      const db = context.db.db as import("../../db").DrizzleDB;
      const [row] = await db
        .select({ config: integrations.config })
        .from(integrations)
        .where(eq(integrations.name, "gmail"))
        .limit(1);
      const dbToken = (row?.config as Record<string, unknown>)?.refreshToken as string | undefined;
      if (dbToken) {
        refreshToken = dbToken;
        context.logger.debug("Email skill: using DB-stored Gmail refresh token.");
      }
    } catch (err) {
      context.logger.warn({ err }, "Email skill: could not read Gmail token from DB, falling back to env var.");
    }

    if (!enabled || !refreshToken) {
      context.logger.warn("Email skill: Gmail not fully configured — tools will return an error until credentials are set.");
      return;
    }

    oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    gmailClient = google.gmail({ version: "v1", auth: oauth2Client });
    context.logger.info("Email skill ready (Gmail API).");
  },

  async teardown(): Promise<void> {
    gmailClient = null;
    oauth2Client = null;
  },

  tools: [
    {
      name: "list_emails",
      description: "List recent Gmail messages, optionally filtered by a Gmail search query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail search query (e.g. 'is:unread from:boss@example.com'). Optional." },
          maxResults: { type: "integer", description: "Max number of messages to return (default 20).", minimum: 1, maximum: 100 },
        },
        required: [],
      },
      execute: listEmails,
    },
    {
      name: "read_email",
      description: "Fetch and return the full content of a Gmail message by its ID.",
      parameters: {
        type: "object",
        properties: {
          messageId: { type: "string", description: "The Gmail message ID." },
        },
        required: ["messageId"],
      },
      execute: readEmail,
    },
    {
      name: "send_email",
      description: "Send an email via Gmail.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address." },
          subject: { type: "string", description: "Email subject line." },
          body: { type: "string", description: "Plain-text email body." },
          cc: { type: "string", description: "Optional CC recipient(s)." },
        },
        required: ["to", "subject", "body"],
      },
      execute: sendEmail,
    },
    {
      name: "reply_to_email",
      description: "Reply to an existing Gmail message, preserving the thread.",
      parameters: {
        type: "object",
        properties: {
          messageId: { type: "string", description: "The ID of the message to reply to." },
          body: { type: "string", description: "Plain-text reply body." },
        },
        required: ["messageId", "body"],
      },
      execute: replyToEmail,
    },
    {
      name: "search_emails",
      description: "Search Gmail using Gmail's query syntax (e.g. 'subject:invoice is:unread').",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail search query string." },
          maxResults: { type: "integer", description: "Max results (default 20).", minimum: 1, maximum: 100 },
        },
        required: ["query"],
      },
      execute: searchEmails,
    },
    {
      name: "mark_read",
      description: "Mark a Gmail message as read.",
      parameters: {
        type: "object",
        properties: {
          messageId: { type: "string", description: "The Gmail message ID to mark as read." },
        },
        required: ["messageId"],
      },
      execute: markRead,
    },
    {
      name: "delete_email",
      description: "Move a Gmail message to the trash.",
      parameters: {
        type: "object",
        properties: {
          messageId: { type: "string", description: "The Gmail message ID to trash." },
        },
        required: ["messageId"],
      },
      execute: deleteEmail,
    },
    {
      name: "list_labels",
      description: "List all Gmail labels (folders) in the account.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: listLabels,
    },
    {
      name: "create_draft",
      description: "Create a Gmail draft without sending it.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address." },
          subject: { type: "string", description: "Email subject." },
          body: { type: "string", description: "Plain-text draft body." },
        },
        required: ["to", "subject", "body"],
      },
      execute: createDraft,
    },
  ],
};

export default emailSkill;
