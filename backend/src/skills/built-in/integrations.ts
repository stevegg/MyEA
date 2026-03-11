/**
 * myEA — Built-in Skill: Integrations
 *
 * Provides the AI with tools to inspect configured integrations and interact
 * with the most common third-party services:
 *
 *   list_integrations        — list all integrations stored in the DB with status
 *   github_list_repos        — list GitHub repos for the authenticated user (or an org)
 *   github_create_issue      — open a GitHub issue on a repo
 *   github_list_issues       — list issues on a repo
 *   github_get_pr            — fetch a single pull request by number
 *   spotify_now_playing      — get the currently playing Spotify track
 *   spotify_search           — search Spotify for tracks, albums, or artists
 *   spotify_play             — start playback of a Spotify URI
 *   http_request             — make an authenticated HTTP request, optionally
 *                              injecting credentials from a stored integration
 */

import axios from "axios";
import { eq } from "drizzle-orm";
import type { Skill, SkillContext, ExecutionContext, ToolResult } from "../../types";
import { getErrorMessage, BUILT_IN_SKILL_VERSION } from "../../utils";
import type { DrizzleDB } from "../../db";
import { integrations } from "../../db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state (reset on hot-reload via teardown/setup lifecycle)
// ─────────────────────────────────────────────────────────────────────────────

let _db: DrizzleDB | null = null;

// Spotify token cache (short-lived access tokens aren't worth persisting)
let spotifyAccessToken: string | null = null;
let spotifyTokenExpiresAt = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Retrieve an integration row from the DB by name. Returns null if not found. */
async function getIntegration(name: string): Promise<Record<string, unknown> | null> {
  if (!_db) return null;
  const [row] = await _db
    .select()
    .from(integrations)
    .where(eq(integrations.name, name))
    .limit(1);
  return row ? (row.config as Record<string, unknown>) : null;
}

/** Obtain a valid Spotify access token, refreshing if necessary. */
async function getSpotifyToken(ctx: ExecutionContext): Promise<string> {
  // Return cached token if still valid (with 60 s margin)
  if (spotifyAccessToken && Date.now() < spotifyTokenExpiresAt - 60_000) {
    return spotifyAccessToken;
  }

  const storedCfg = await getIntegration("spotify");
  const appCfg = ctx.config.integrations.spotify;

  const clientId = (storedCfg?.["clientId"] as string) || appCfg.clientId;
  const clientSecret = (storedCfg?.["clientSecret"] as string) || appCfg.clientSecret;
  const refreshToken = (storedCfg?.["refreshToken"] as string) || appCfg.refreshToken;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Spotify integration is not configured. Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REFRESH_TOKEN."
    );
  }

  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const resp = await axios.post<{ access_token: string; expires_in: number }>(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    {
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 10_000,
    }
  );

  spotifyAccessToken = resp.data.access_token;
  spotifyTokenExpiresAt = Date.now() + resp.data.expires_in * 1000;

  return spotifyAccessToken;
}

/** Return a GitHub personal access token from stored config or app config. */
async function getGitHubToken(ctx: ExecutionContext): Promise<string> {
  const storedCfg = await getIntegration("github");
  const token = (storedCfg?.["token"] as string) || ctx.config.integrations.github.token;
  if (!token) {
    throw new Error(
      "GitHub integration is not configured. Set GITHUB_TOKEN or configure it via the integrations UI."
    );
  }
  return token;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────────────────────────────────────

async function listIntegrations(_params: unknown, ctx: ExecutionContext): Promise<ToolResult> {
  try {
    if (!_db) throw new Error("Database not available");

    const rows = await _db.select().from(integrations).orderBy(integrations.name);

    // Exclude the internal settings row
    const visible = rows.filter((r) => !r.name.startsWith("__"));

    const summary = visible.map((r) => ({
      name: r.name,
      displayName: r.displayName,
      enabled: r.enabled,
      status: r.status,
      lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
      errorMessage: r.errorMessage ?? null,
    }));

    const lines = summary.map(
      (i) =>
        `• ${i.displayName} (${i.name}): ${i.enabled ? "enabled" : "disabled"}, status=${i.status}${
          i.errorMessage ? ` — error: ${i.errorMessage}` : ""
        }`
    );

    return {
      content: lines.length
        ? `Configured integrations (${lines.length}):\n${lines.join("\n")}`
        : "No integrations configured.",
      data: summary,
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to list integrations: ${msg}`, isError: true };
  }
}

async function githubListRepos(params: unknown, ctx: ExecutionContext): Promise<ToolResult> {
  const { owner } = params as { owner?: string };
  try {
    const token = await getGitHubToken(ctx);
    const url = owner
      ? `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos?per_page=50&sort=pushed`
      : "https://api.github.com/user/repos?per_page=50&sort=pushed";

    const resp = await axios.get<
      Array<{ name: string; full_name: string; description: string | null; html_url: string; private: boolean; open_issues_count: number; stargazers_count: number }>
    >(url, {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
      timeout: 10_000,
    });

    const repos = resp.data.map((r) => ({
      name: r.name,
      fullName: r.full_name,
      description: r.description,
      url: r.html_url,
      private: r.private,
      openIssues: r.open_issues_count,
      stars: r.stargazers_count,
    }));

    const lines = repos.map(
      (r) =>
        `• ${r.fullName}${r.private ? " [private]" : ""} — ${r.description ?? "no description"} (${r.openIssues} open issues, ${r.stars} stars)`
    );

    return {
      content: lines.length
        ? `GitHub repos${owner ? ` for ${owner}` : ""}:\n${lines.join("\n")}`
        : "No repositories found.",
      data: repos,
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `GitHub list repos failed: ${msg}`, isError: true };
  }
}

async function githubCreateIssue(params: unknown, ctx: ExecutionContext): Promise<ToolResult> {
  const { owner, repo, title, body, labels } = params as {
    owner: string;
    repo: string;
    title: string;
    body?: string;
    labels?: string[];
  };

  try {
    const token = await getGitHubToken(ctx);
    const resp = await axios.post<{ number: number; html_url: string; title: string }>(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
      { title, body: body ?? "", labels: labels ?? [] },
      {
        headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
        timeout: 10_000,
      }
    );

    return {
      content: `Issue #${resp.data.number} created: "${resp.data.title}"\n${resp.data.html_url}`,
      data: { number: resp.data.number, url: resp.data.html_url, title: resp.data.title },
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `GitHub create issue failed: ${msg}`, isError: true };
  }
}

async function githubListIssues(params: unknown, ctx: ExecutionContext): Promise<ToolResult> {
  const { owner, repo, state = "open" } = params as {
    owner: string;
    repo: string;
    state?: "open" | "closed" | "all";
  };

  try {
    const token = await getGitHubToken(ctx);
    const resp = await axios.get<
      Array<{ number: number; title: string; state: string; html_url: string; labels: Array<{ name: string }>; created_at: string; user: { login: string } | null }>
    >(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}&per_page=50`,
      {
        headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
        timeout: 10_000,
      }
    );

    // The issues endpoint includes pull requests; filter them out
    const issues = resp.data.filter((i) => !(i as unknown as { pull_request?: unknown }).pull_request);

    const formatted = issues.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      url: i.html_url,
      labels: i.labels.map((l) => l.name),
      author: i.user?.login ?? "unknown",
      createdAt: i.created_at,
    }));

    const lines = formatted.map(
      (i) =>
        `#${i.number} [${i.state}] ${i.title}${i.labels.length ? ` [${i.labels.join(", ")}]` : ""} by ${i.author}`
    );

    return {
      content: lines.length
        ? `Issues for ${owner}/${repo} (${state}):\n${lines.join("\n")}`
        : `No ${state} issues found.`,
      data: formatted,
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `GitHub list issues failed: ${msg}`, isError: true };
  }
}

async function githubGetPR(params: unknown, ctx: ExecutionContext): Promise<ToolResult> {
  const { owner, repo, number } = params as { owner: string; repo: string; number: number };

  try {
    const token = await getGitHubToken(ctx);
    const resp = await axios.get<{
      number: number;
      title: string;
      state: string;
      html_url: string;
      body: string | null;
      user: { login: string } | null;
      head: { ref: string; sha: string };
      base: { ref: string };
      mergeable: boolean | null;
      merged: boolean;
      additions: number;
      deletions: number;
      changed_files: number;
      created_at: string;
      updated_at: string;
      draft: boolean;
    }>(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
      {
        headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
        timeout: 10_000,
      }
    );

    const pr = resp.data;
    const summary = [
      `PR #${pr.number}: ${pr.title}`,
      `State: ${pr.state}${pr.draft ? " (draft)" : ""}${pr.merged ? " (merged)" : ""}`,
      `Author: ${pr.user?.login ?? "unknown"}`,
      `Branch: ${pr.head.ref} → ${pr.base.ref}`,
      `Changes: +${pr.additions} -${pr.deletions} across ${pr.changed_files} files`,
      `URL: ${pr.html_url}`,
      pr.body ? `\nDescription:\n${pr.body.slice(0, 1000)}${pr.body.length > 1000 ? "..." : ""}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      content: summary,
      data: {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        merged: pr.merged,
        draft: pr.draft,
        author: pr.user?.login ?? "unknown",
        head: pr.head.ref,
        base: pr.base.ref,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
        url: pr.html_url,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
      },
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `GitHub get PR failed: ${msg}`, isError: true };
  }
}

async function spotifyNowPlaying(_params: unknown, ctx: ExecutionContext): Promise<ToolResult> {
  try {
    const token = await getSpotifyToken(ctx);
    const resp = await axios.get<{
      is_playing: boolean;
      item: {
        name: string;
        artists: Array<{ name: string }>;
        album: { name: string };
        duration_ms: number;
        external_urls: { spotify: string };
      } | null;
      progress_ms: number | null;
    } | "">("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8_000,
      validateStatus: (s) => s === 200 || s === 204,
    });

    if (resp.status === 204 || !resp.data || !(resp.data as Record<string, unknown>).item) {
      return { content: "Nothing is currently playing on Spotify.", data: { isPlaying: false } };
    }

    const data = resp.data as {
      is_playing: boolean;
      item: { name: string; artists: Array<{ name: string }>; album: { name: string }; duration_ms: number; external_urls: { spotify: string } };
      progress_ms: number | null;
    };

    const track = data.item;
    const artists = track.artists.map((a) => a.name).join(", ");
    const progressSec = Math.floor((data.progress_ms ?? 0) / 1000);
    const durationSec = Math.floor(track.duration_ms / 1000);
    const progressStr = `${Math.floor(progressSec / 60)}:${String(progressSec % 60).padStart(2, "0")} / ${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, "0")}`;

    return {
      content: `Now playing: "${track.name}" by ${artists} (${track.album.name}) — ${progressStr}\n${track.external_urls.spotify}`,
      data: {
        isPlaying: data.is_playing,
        track: track.name,
        artists,
        album: track.album.name,
        progress: progressStr,
        url: track.external_urls.spotify,
      },
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Spotify now-playing failed: ${msg}`, isError: true };
  }
}

async function spotifySearch(params: unknown, ctx: ExecutionContext): Promise<ToolResult> {
  const { query, type = "track" } = params as {
    query: string;
    type?: "track" | "album" | "artist" | "playlist";
  };

  try {
    const token = await getSpotifyToken(ctx);
    const resp = await axios.get<{
      tracks?: { items: Array<{ name: string; uri: string; artists: Array<{ name: string }>; album: { name: string }; external_urls: { spotify: string } }> };
      albums?: { items: Array<{ name: string; uri: string; artists: Array<{ name: string }>; external_urls: { spotify: string } }> };
      artists?: { items: Array<{ name: string; uri: string; genres: string[]; external_urls: { spotify: string } }> };
      playlists?: { items: Array<{ name: string; uri: string; owner: { display_name: string }; external_urls: { spotify: string } }> };
    }>("https://api.spotify.com/v1/search", {
      params: { q: query, type, limit: 10 },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8_000,
    });

    const lines: string[] = [];
    const items: unknown[] = [];

    if (type === "track" && resp.data.tracks) {
      for (const t of resp.data.tracks.items) {
        const artists = t.artists.map((a) => a.name).join(", ");
        lines.push(`• "${t.name}" by ${artists} (${t.album.name}) — ${t.uri}`);
        items.push({ name: t.name, uri: t.uri, artists, album: t.album.name, url: t.external_urls.spotify });
      }
    } else if (type === "album" && resp.data.albums) {
      for (const a of resp.data.albums.items) {
        const artists = a.artists.map((ar) => ar.name).join(", ");
        lines.push(`• "${a.name}" by ${artists} — ${a.uri}`);
        items.push({ name: a.name, uri: a.uri, artists, url: a.external_urls.spotify });
      }
    } else if (type === "artist" && resp.data.artists) {
      for (const a of resp.data.artists.items) {
        lines.push(`• ${a.name} [${a.genres.slice(0, 3).join(", ")}] — ${a.uri}`);
        items.push({ name: a.name, uri: a.uri, genres: a.genres, url: a.external_urls.spotify });
      }
    } else if (type === "playlist" && resp.data.playlists) {
      for (const p of resp.data.playlists.items) {
        lines.push(`• "${p.name}" by ${p.owner.display_name} — ${p.uri}`);
        items.push({ name: p.name, uri: p.uri, owner: p.owner.display_name, url: p.external_urls.spotify });
      }
    }

    return {
      content: lines.length
        ? `Spotify search results for "${query}" (${type}):\n${lines.join("\n")}`
        : `No Spotify ${type} results found for "${query}".`,
      data: { query, type, items },
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Spotify search failed: ${msg}`, isError: true };
  }
}

async function spotifyPlay(params: unknown, ctx: ExecutionContext): Promise<ToolResult> {
  const { uri } = params as { uri: string };

  try {
    const token = await getSpotifyToken(ctx);

    // Determine whether it's a track, album, or playlist URI
    const isContext = uri.includes(":album:") || uri.includes(":playlist:") || uri.includes(":artist:");

    const body = isContext
      ? { context_uri: uri }
      : { uris: [uri] };

    await axios.put("https://api.spotify.com/v1/me/player/play", body, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      timeout: 8_000,
      validateStatus: (s) => s === 204 || s === 200,
    });

    return {
      content: `Playback started for: ${uri}`,
      data: { uri, started: true },
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    // 403 typically means Spotify Premium is required
    if (axios.isAxiosError(err) && err.response?.status === 403) {
      return {
        content: "Spotify play requires Spotify Premium. Playback control is not available on free accounts.",
        isError: true,
      };
    }
    return { content: `Spotify play failed: ${msg}`, isError: true };
  }
}

async function httpRequest(params: unknown, ctx: ExecutionContext): Promise<ToolResult> {
  const {
    method,
    url,
    headers: extraHeaders = {},
    body,
    integrationName,
  } = params as {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
    integrationName?: string;
  };

  try {
    const requestHeaders: Record<string, string> = { ...extraHeaders };

    // If an integration name is provided, inject its stored credentials
    if (integrationName) {
      const storedCfg = await getIntegration(integrationName);
      if (storedCfg) {
        const token = storedCfg["token"] as string | undefined;
        const apiKey = storedCfg["apiKey"] as string | undefined;
        const accessToken = storedCfg["accessToken"] as string | undefined;

        if (token) requestHeaders["Authorization"] = `token ${token}`;
        else if (accessToken) requestHeaders["Authorization"] = `Bearer ${accessToken}`;
        else if (apiKey) requestHeaders["X-Api-Key"] = apiKey;
      }
    }

    const resp = await axios.request({
      method,
      url,
      headers: requestHeaders,
      data: body,
      timeout: 30_000,
      // Don't throw on 4xx/5xx — return the response body so the AI can reason about it
      validateStatus: () => true,
    });

    const responseBody =
      typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data, null, 2);

    const truncated = responseBody.length > 10_000
      ? responseBody.slice(0, 10_000) + "\n\n[...truncated]"
      : responseBody;

    return {
      content: `HTTP ${method} ${url} → ${resp.status} ${resp.statusText}\n\n${truncated}`,
      data: {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
        body: resp.data,
      },
      isError: resp.status >= 400,
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `HTTP request failed: ${msg}`, isError: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill definition
// ─────────────────────────────────────────────────────────────────────────────

const integrationsSkill: Skill = {
  name: "integrations",
  description:
    "Manage and interact with configured third-party integrations: GitHub, Spotify, and arbitrary HTTP endpoints.",
  version: BUILT_IN_SKILL_VERSION,

  async setup(context: SkillContext): Promise<void> {
    _db = context.db.db as DrizzleDB;
    context.logger.info("Integrations skill ready.");
  },

  async teardown(): Promise<void> {
    _db = null;
    spotifyAccessToken = null;
    spotifyTokenExpiresAt = 0;
  },

  tools: [
    {
      name: "list_integrations",
      description:
        "List all integrations configured in the myEA database with their current status.",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: listIntegrations,
    },

    // ── GitHub ──────────────────────────────────────────────────────────────

    {
      name: "github_list_repos",
      description:
        "List GitHub repositories for the authenticated user. Optionally pass an owner/org name to list an organisation's repos instead.",
      parameters: {
        type: "object",
        properties: {
          owner: {
            type: "string",
            description: "GitHub org or username. Omit to list the authenticated user's own repos.",
          },
        },
      },
      execute: githubListRepos,
    },

    {
      name: "github_create_issue",
      description: "Create a new GitHub issue on a repository.",
      parameters: {
        type: "object",
        required: ["owner", "repo", "title"],
        properties: {
          owner: { type: "string", description: "Repository owner (user or org)." },
          repo: { type: "string", description: "Repository name." },
          title: { type: "string", description: "Issue title." },
          body: { type: "string", description: "Issue body (Markdown supported)." },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Label names to apply.",
          },
        },
      },
      execute: githubCreateIssue,
    },

    {
      name: "github_list_issues",
      description: "List issues on a GitHub repository.",
      parameters: {
        type: "object",
        required: ["owner", "repo"],
        properties: {
          owner: { type: "string", description: "Repository owner." },
          repo: { type: "string", description: "Repository name." },
          state: {
            type: "string",
            enum: ["open", "closed", "all"],
            description: "Filter by issue state (default: open).",
          },
        },
      },
      execute: githubListIssues,
    },

    {
      name: "github_get_pr",
      description: "Fetch details of a specific GitHub pull request by its number.",
      parameters: {
        type: "object",
        required: ["owner", "repo", "number"],
        properties: {
          owner: { type: "string", description: "Repository owner." },
          repo: { type: "string", description: "Repository name." },
          number: { type: "integer", description: "Pull request number." },
        },
      },
      execute: githubGetPR,
    },

    // ── Spotify ─────────────────────────────────────────────────────────────

    {
      name: "spotify_now_playing",
      description: "Get the track currently playing on Spotify, including title, artist, and progress.",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: spotifyNowPlaying,
    },

    {
      name: "spotify_search",
      description: "Search Spotify for tracks, albums, artists, or playlists.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "The search query string." },
          type: {
            type: "string",
            enum: ["track", "album", "artist", "playlist"],
            description: "The type of Spotify content to search for (default: track).",
          },
        },
      },
      execute: spotifySearch,
    },

    {
      name: "spotify_play",
      description:
        "Start Spotify playback for a given URI (track, album, artist, or playlist). Requires Spotify Premium.",
      parameters: {
        type: "object",
        required: ["uri"],
        properties: {
          uri: {
            type: "string",
            description:
              "A Spotify URI, e.g. spotify:track:4iV5W9uYEdYUVa79Axb7Rh or spotify:playlist:37i9dQZF1DXcBWIGoYBM5M.",
          },
        },
      },
      execute: spotifyPlay,
    },

    // ── Generic HTTP ─────────────────────────────────────────────────────────

    {
      name: "http_request",
      description:
        "Make an arbitrary HTTP request. Optionally provide an integrationName to automatically inject stored credentials (token, API key, or OAuth access token) from that integration.",
      parameters: {
        type: "object",
        required: ["method", "url"],
        properties: {
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
            description: "HTTP method.",
          },
          url: { type: "string", description: "Fully qualified URL including query string if needed." },
          headers: {
            type: "object",
            description: "Additional request headers as key-value pairs.",
            additionalProperties: { type: "string" },
          },
          body: {
            type: "object",
            description: "Request body for POST/PUT/PATCH. Will be sent as JSON.",
          },
          integrationName: {
            type: "string",
            description:
              "Name of a stored integration (e.g. 'github', 'spotify') whose credentials should be injected into the request headers.",
          },
        },
      },
      execute: httpRequest,
    },
  ],
};

export default integrationsSkill;
