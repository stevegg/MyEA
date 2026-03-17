/**
 * myEA — System Prompt Builder
 *
 * Dynamically composes the assistant's system prompt from multiple contextual
 * layers. Each layer is independently optional so callers can omit whatever
 * is not yet available (e.g. memory context on the first ever message).
 *
 * Layer order:
 *   1. Core identity
 *   2. Current date / time
 *   3. Platform context
 *   4. Active integrations
 *   5. Available tools / skills
 *   6. Memory context (most relevant entries)
 *   7. Tool-use instructions
 *   8. Personality & behaviour guidelines
 */

import type {
  MemoryEntry,
  SkillRegistryEntry,
  IntegrationRecord,
  Platform,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Builder options
// ─────────────────────────────────────────────────────────────────────────────

export interface PromptBuilderOptions {
  /** The user's display name, if known. */
  userName?: string;

  /** ISO-8601 string or Date. Defaults to now. */
  currentTime?: string | Date;

  /** Which platform the user is messaging from. */
  platform?: Platform;

  /** Platform-specific context (channel name, guild name, etc.). */
  platformContext?: Record<string, string>;

  /** Skills currently loaded and enabled. */
  skills?: SkillRegistryEntry[];

  /**
   * Memory entries already retrieved and ranked by relevance.
   * The builder formats these into the prompt; the caller is responsible
   * for fetching them (e.g. via MemoryService.search()).
   */
  memoryEntries?: MemoryEntry[];

  /** Maximum number of memory entries to include. Default: 10. */
  maxMemoryEntries?: number;

  /** Active integrations (only connected ones should be included). */
  integrations?: IntegrationRecord[];

  /** Override the core assistant name. Default: "myEA". */
  assistantName?: string;

  /**
   * Whether to include verbose tool-use instructions.
   * Set to false when tools array will be empty to keep the prompt lean.
   * Default: true
   */
  includeToolInstructions?: boolean;

  /**
   * Additional custom instructions to append at the end of the prompt.
   * Useful for per-conversation or per-platform overrides.
   */
  customInstructions?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform display names
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORM_DISPLAY: Record<Platform, string> = {
  telegram:  "Telegram",
  discord:   "Discord",
  slack:     "Slack",
  whatsapp:  "WhatsApp",
  signal:    "Signal",
  imessage:  "iMessage",
  web:       "Web Admin UI",
  internal:  "internal scheduler",
};

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builder
// ─────────────────────────────────────────────────────────────────────────────

export class PromptBuilder {
  /**
   * Builds the complete system prompt string from the provided options.
   * Returns a clean, newline-separated document ready to pass as the
   * `systemPrompt` field in AIGenerateOptions.
   */
  build(options: PromptBuilderOptions = {}): string {
    const {
      userName,
      currentTime,
      platform,
      platformContext,
      skills = [],
      memoryEntries = [],
      maxMemoryEntries = 10,
      integrations = [],
      assistantName = "myEA",
      includeToolInstructions = true,
      customInstructions,
    } = options;

    const sections: string[] = [];

    // ── 1. Core identity ──────────────────────────────────────────────────
    sections.push(this.buildIdentitySection(assistantName, userName));

    // ── 2. Current date / time ────────────────────────────────────────────
    sections.push(this.buildDateTimeSection(currentTime));

    // ── 3. Platform context ───────────────────────────────────────────────
    if (platform) {
      sections.push(this.buildPlatformSection(platform, platformContext));
    }

    // ── 4. Active integrations ────────────────────────────────────────────
    const connectedIntegrations = integrations.filter(
      (i) => i.enabled && i.status === "connected"
    );
    if (connectedIntegrations.length > 0) {
      sections.push(this.buildIntegrationsSection(connectedIntegrations));
    }

    // ── 5. Available tools / skills ───────────────────────────────────────
    const enabledSkills = skills.filter((s) => s.enabled && !s.loadError);
    if (enabledSkills.length > 0) {
      sections.push(this.buildSkillsSection(enabledSkills));
    }

    // ── 6. Memory context ─────────────────────────────────────────────────
    const relevantMemory = memoryEntries.slice(0, maxMemoryEntries);
    if (relevantMemory.length > 0) {
      sections.push(this.buildMemorySection(relevantMemory));
    }

    // ── 7. Tool-use instructions ──────────────────────────────────────────
    if (includeToolInstructions && enabledSkills.length > 0) {
      sections.push(this.buildToolInstructionsSection());
    }

    // ── 8. Personality & behaviour ────────────────────────────────────────
    sections.push(this.buildPersonalitySection());

    // ── 9. Custom instructions ────────────────────────────────────────────
    if (customInstructions?.trim()) {
      sections.push("## Custom Instructions\n\n" + customInstructions.trim());
    }

    return sections.filter(Boolean).join("\n\n---\n\n");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Section builders
  // ─────────────────────────────────────────────────────────────────────────

  private buildIdentitySection(assistantName: string, userName?: string): string {
    const greeting = userName ? ` You are assisting **${userName}**.` : "";

    return [
      `# You are ${assistantName}`,
      "",
      `You are a personal AI assistant running as **${assistantName}** — a powerful,` +
        ` privacy-focused assistant that lives entirely on the user's own infrastructure.${greeting}`,
      "",
      "Your purpose is to help the user manage their digital life: answering questions," +
        " taking actions via integrated services, remembering important information," +
        " and proactively surfacing things the user cares about.",
      "",
      "You have access to the user's calendar, emails, smart home, music, code repositories," +
        " and more — through the skills and integrations described below.",
    ].join("\n");
  }

  private buildDateTimeSection(currentTime?: string | Date): string {
    const now = currentTime ? new Date(currentTime) : new Date();

    const formatted = now.toLocaleString("en-US", {
      weekday:      "long",
      year:         "numeric",
      month:        "long",
      day:          "numeric",
      hour:         "2-digit",
      minute:       "2-digit",
      timeZoneName: "short",
    });

    const iso = now.toISOString();

    return [
      "## Current Date & Time",
      "",
      `- **Local time**: ${formatted}`,
      `- **ISO-8601**: ${iso}`,
      "",
      "Always use this as your reference for any time-sensitive reasoning or scheduling.",
    ].join("\n");
  }

  private buildPlatformSection(
    platform: Platform,
    context?: Record<string, string>
  ): string {
    const displayName = PLATFORM_DISPLAY[platform] ?? platform;
    const lines = [
      "## Platform Context",
      "",
      `The user is currently messaging you via **${displayName}**.`,
    ];

    if (context && Object.keys(context).length > 0) {
      lines.push("");
      for (const [key, value] of Object.entries(context)) {
        lines.push(`- **${key}**: ${value}`);
      }
    }

    // Platform-specific guidance
    const guidance = PLATFORM_GUIDANCE[platform];
    if (guidance) {
      lines.push("", guidance);
    }

    return lines.join("\n");
  }

  private buildIntegrationsSection(integrations: IntegrationRecord[]): string {
    const lines = [
      "## Active Integrations",
      "",
      "The following external services are currently connected and available:",
      "",
    ];

    for (const integration of integrations) {
      lines.push(`- **${integration.displayName}** (${integration.name})`);
    }

    return lines.join("\n");
  }

  private buildSkillsSection(skills: SkillRegistryEntry[]): string {
    const lines = [
      "## Available Skills & Tools",
      "",
      "You have access to the following skills. Each skill exposes one or more tools" +
        " you can call to take actions on behalf of the user:",
      "",
    ];

    for (const skill of skills) {
      lines.push(`### ${skill.name} (v${skill.version})`);
      lines.push(skill.description);

      if (skill.tools.length > 0) {
        lines.push("");
        lines.push("**Tools:**");
        for (const tool of skill.tools) {
          lines.push(`- \`${tool.name}\`: ${tool.description}`);
        }
      }
      lines.push("");
    }

    return lines.join("\n").trimEnd();
  }

  private buildMemorySection(entries: MemoryEntry[]): string {
    const lines = [
      "## Memory Context",
      "",
      "The following information has been retrieved from your memory store as relevant" +
        " to this conversation. Use it to personalise your responses:",
      "",
    ];

    // Group by type for readability
    const byType = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      const group = byType.get(entry.type) ?? [];
      group.push(entry);
      byType.set(entry.type, group);
    }

    const typeLabels: Record<string, string> = {
      fact:       "Facts",
      preference: "User Preferences",
      summary:    "Conversation Summaries",
      context:    "Working Context",
      note:       "Notes",
    };

    for (const [type, typeEntries] of byType) {
      const label = typeLabels[type] ?? type;
      lines.push(`### ${label}`);
      for (const entry of typeEntries) {
        const score =
          entry.score !== undefined
            ? ` _(relevance: ${(entry.score * 100).toFixed(0)}%)_`
            : "";
        lines.push(`- ${entry.content}${score}`);
      }
      lines.push("");
    }

    return lines.join("\n").trimEnd();
  }

  private buildToolInstructionsSection(): string {
    return [
      "## Tool Use Instructions",
      "",
      "When a user request requires taking an action or looking up live information,",
      "use the appropriate tool rather than guessing or making things up.",
      "",
      "**Guidelines:**",
      "- Call tools proactively when they would clearly help — don't ask for permission",
      "  unless the action is destructive or irreversible.",
      "- You may call multiple tools in a single turn if the task requires it.",
      "- After receiving tool results, synthesise them into a natural language response.",
      "- If a tool returns an error, explain what went wrong and suggest alternatives.",
      "- Never expose raw JSON tool responses directly to the user; always interpret them.",
      "- If you are uncertain whether a tool call is needed, prefer to attempt it rather",
      "  than asking the user to clarify, unless the missing information is critical.",
      "",
      "**Tool naming convention:** `skill_name__tool_name`",
      "Tools are namespaced by skill to avoid collisions. The skill name is the prefix",
      "before the double underscore.",
    ].join("\n");
  }

  private buildPersonalitySection(): string {
    return [
      "## Personality & Behaviour",
      "",
      "**Communication style:**",
      "- Be **concise** — respect the user's time. Prefer short answers unless detail is",
      "  explicitly requested or clearly necessary.",
      "- Be **proactive** — if you notice something the user would likely care about",
      "  (e.g. a meeting conflict, an unread important email), mention it.",
      "- Be **direct** — avoid filler phrases like 'Certainly!', 'Of course!', or",
      "  'Great question!'. Get to the point.",
      "- Use **markdown** formatting where the platform supports it (bold, code blocks,",
      "  lists), but keep prose conversational.",
      "",
      "**Tone:**",
      "- Warm and helpful without being sycophantic.",
      "- Professional but not formal — you're a trusted assistant, not a corporate bot.",
      "- Honest: if you don't know something, say so. If a task is outside your",
      "  capabilities, explain why and offer the closest alternative.",
      "",
      "**Privacy & security:**",
      "- Never share credentials, tokens, or sensitive configuration values in responses.",
      "- Treat all personal data with discretion — don't volunteer private information",
      "  unless directly asked.",
      "- If asked to do something that could cause irreversible harm (delete files,",
      "  send mass messages, etc.), confirm with the user first.",
    ].join("\n");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform-specific guidance snippets
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORM_GUIDANCE: Partial<Record<Platform, string>> = {
  telegram:
    "Telegram supports Markdown formatting. Use *bold*, `code`, and ```code blocks```" +
    " where appropriate. Keep messages short — Telegram users prefer concise replies.",

  discord:
    "Discord supports Markdown. Use **bold**, `inline code`, and ```code blocks```." +
    " You may use embeds for structured data (the platform connector will handle formatting).",

  slack:
    "Slack uses its own mrkdwn format. Use *bold*, `code`, and ```code blocks```." +
    " Avoid overly long messages — prefer bullet points and short paragraphs.",

  whatsapp:
    "WhatsApp supports basic formatting: *bold*, _italic_, ~strikethrough~, ```code```." +
    " Keep responses conversational and short — WhatsApp is a mobile-first platform.",

  signal:
    "Signal is a privacy-focused platform. No tracking, no analytics." +
    " Keep responses text-only — rich formatting may not render.",

  internal:
    "This is a proactive/scheduled message, not a reply to a user. " +
    "Be informative and to the point. The message will be delivered to the user's" +
    " configured notification channel.",
};

// ─────────────────────────────────────────────────────────────────────────────
// Singleton export
// ─────────────────────────────────────────────────────────────────────────────

/** Module-level singleton — instantiate once and reuse across all requests. */
export const promptBuilder = new PromptBuilder();
