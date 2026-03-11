/**
 * myEA — Built-in Skill: Web
 *
 * Provides browser-automation and web-search tools backed by Playwright
 * (headless Chromium). The browser is launched once at skill setup and
 * reused across calls. A new page is created per call so calls do not
 * interfere with each other.
 *
 * Search backend:
 *   - If SERP_API_KEY is set in the environment, SerpAPI is used.
 *   - Otherwise DuckDuckGo Instant Answer API is used (no key required).
 */

import axios from "axios";
import { chromium, Browser } from "playwright";

import type { Skill, SkillContext, ExecutionContext, ToolResult } from "../../types";
import { getErrorMessage, BUILT_IN_SKILL_VERSION } from "../../utils";

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state (owned by this skill, reset on reload)
// ─────────────────────────────────────────────────────────────────────────────

let browser: Browser | null = null;
let serpApiKey: string | undefined;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CONTENT_CHARS = 50_000;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      // Use system Chromium when PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH is set (Docker dev/prod)
      executablePath: process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"] || undefined,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return browser;
}

function truncate(text: string): string {
  if (text.length <= MAX_CONTENT_CHARS) return text;
  return text.slice(0, MAX_CONTENT_CHARS) + `\n\n[...truncated at ${MAX_CONTENT_CHARS} chars]`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────────────────────────────────────

async function webSearch(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { query, numResults = 10 } = params as { query: string; numResults?: number };

  try {
    if (serpApiKey) {
      // SerpAPI path.
      const resp = await axios.get("https://serpapi.com/search.json", {
        params: { q: query, num: numResults, api_key: serpApiKey },
        timeout: DEFAULT_TIMEOUT_MS,
      });
      const results = (resp.data.organic_results ?? []).slice(0, numResults) as Array<{
        title: string;
        link: string;
        snippet: string;
      }>;
      const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.link}\n   ${r.snippet}`);
      return {
        content: lines.join("\n\n") || "No results found.",
        data: { query, results },
      };
    }

    // DuckDuckGo Instant Answer API (fallback — limited, no organic results).
    const resp = await axios.get("https://api.duckduckgo.com/", {
      params: { q: query, format: "json", no_html: 1, skip_disambig: 1 },
      timeout: DEFAULT_TIMEOUT_MS,
    });
    const d = resp.data as {
      AbstractText: string;
      AbstractURL: string;
      RelatedTopics: Array<{ Text?: string; FirstURL?: string }>;
    };

    const lines: string[] = [];
    if (d.AbstractText) {
      lines.push(`Summary: ${d.AbstractText}\nSource: ${d.AbstractURL}`);
    }
    const topics = (d.RelatedTopics ?? [])
      .filter((t) => t.Text && t.FirstURL)
      .slice(0, numResults)
      .map((t, i) => `${i + 1}. ${t.Text}\n   ${t.FirstURL}`);
    lines.push(...topics);

    return {
      content: lines.join("\n\n") || `No instant-answer results for "${query}". Try web_browse on a specific URL.`,
      data: { query, source: "duckduckgo" },
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Web search failed: ${msg}`, isError: true };
  }
}

async function webBrowse(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { url } = params as { url: string };

  try {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
      const text = await page.evaluate(() => document.body?.innerText ?? "");
      const title = await page.title();
      return {
        content: truncate(text.trim()),
        data: { url, title, charCount: text.length },
      };
    } finally {
      await page.close();
    }
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to browse "${url}": ${msg}`, isError: true };
  }
}

async function webScreenshot(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { url } = params as { url: string };

  try {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
      const buffer = await page.screenshot({ type: "png", fullPage: false });
      const base64 = buffer.toString("base64");
      return {
        content: `Screenshot captured for "${url}". Base64 PNG data attached.`,
        data: { url, imageBase64: base64, mimeType: "image/png" },
      };
    } finally {
      await page.close();
    }
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Screenshot failed for "${url}": ${msg}`, isError: true };
  }
}

async function extractLinks(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { url } = params as { url: string };

  try {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a[href]"))
          .map((a) => ({
            href: (a as HTMLAnchorElement).href,
            text: (a as HTMLAnchorElement).textContent?.trim() ?? "",
          }))
          .filter((l) => l.href.startsWith("http"))
          .slice(0, 200)
      );
      const lines = links.map((l) => `${l.text || "(no text)"}: ${l.href}`);
      return {
        content: lines.join("\n") || "No links found.",
        data: { url, linkCount: links.length, links },
      };
    } finally {
      await page.close();
    }
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to extract links from "${url}": ${msg}`, isError: true };
  }
}

async function fillForm(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { url, formData } = params as { url: string; formData: Record<string, string> };

  try {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });

      // Fill each field. The key can be: a CSS selector, an input[name=...], or a label text.
      for (const [selector, value] of Object.entries(formData)) {
        try {
          // Try direct selector first, then name attribute, then placeholder.
          const handle =
            (await page.$(selector)) ??
            (await page.$(`[name="${selector}"]`)) ??
            (await page.$(`[placeholder="${selector}"]`));
          if (handle) {
            await handle.fill(value);
          }
        } catch {
          // Best-effort: skip fields that can't be found.
        }
      }

      // Submit the first form found.
      const submitted = await page.evaluate(() => {
        const form = document.querySelector("form");
        if (form) { form.submit(); return true; }
        return false;
      });

      if (!submitted) {
        return { content: "No form element found on the page.", isError: true };
      }

      // Wait briefly for navigation after submit.
      try {
        await page.waitForNavigation({ timeout: 10_000 });
      } catch {
        // Navigation may not happen for AJAX forms — that's ok.
      }

      const resultText = await page.evaluate(() => document.body?.innerText ?? "");
      return {
        content: `Form submitted. Page after submission:\n\n${truncate(resultText.trim())}`,
        data: { url, fieldsSet: Object.keys(formData) },
      };
    } finally {
      await page.close();
    }
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Form fill failed for "${url}": ${msg}`, isError: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill definition
// ─────────────────────────────────────────────────────────────────────────────

const webSkill: Skill = {
  name: "web",
  description: "Search the web, browse pages, take screenshots, extract links, and submit forms using headless Chromium.",
  version: BUILT_IN_SKILL_VERSION,

  async setup(context: SkillContext): Promise<void> {
    serpApiKey = process.env["SERP_API_KEY"] || undefined;
    // Pre-launch the browser so the first tool call is faster.
    try {
      await getBrowser();
      context.logger.info("Web skill ready — browser launched.");
    } catch (err) {
      // Non-fatal: browser will be launched on first use.
      // Log just the message to avoid spamming the log with the full Playwright install hint.
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      context.logger.warn(`Web skill: browser pre-launch failed (${msg}) — will retry on first use.`);
    }
  },

  async teardown(): Promise<void> {
    if (browser && browser.isConnected()) {
      await browser.close();
      browser = null;
    }
  },

  tools: [
    {
      name: "web_search",
      description:
        "Search the web for a query. Uses SerpAPI if SERP_API_KEY is configured, otherwise falls back to DuckDuckGo.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
          numResults: {
            type: "integer",
            description: "Maximum number of results to return (default 10).",
            minimum: 1,
            maximum: 50,
          },
        },
        required: ["query"],
      },
      execute: webSearch,
    },
    {
      name: "web_browse",
      description: "Fetch a URL with a real browser and return the visible text content of the page.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to browse." },
        },
        required: ["url"],
      },
      execute: webBrowse,
    },
    {
      name: "web_screenshot",
      description: "Take a screenshot of a URL and return it as base64-encoded PNG data.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to screenshot." },
        },
        required: ["url"],
      },
      execute: webScreenshot,
    },
    {
      name: "extract_links",
      description: "Extract all hyperlinks from a web page.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to extract links from." },
        },
        required: ["url"],
      },
      execute: extractLinks,
    },
    {
      name: "fill_form",
      description: "Navigate to a URL, fill in form fields, and submit the form.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL containing the form." },
          formData: {
            type: "object",
            description:
              "Key-value map of field selectors (CSS selector, name, or placeholder) to values to enter.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["url", "formData"],
      },
      execute: fillForm,
    },
  ],
};

export default webSkill;
