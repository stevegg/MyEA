/**
 * myEA — Built-in Skill: Files
 *
 * Provides file-system tools sandboxed to the configured files volume
 * (/app/volumes/files by default). All paths are resolved and validated
 * against the sandbox root; any attempt to escape via "../" traversal is
 * rejected before any I/O occurs.
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";

import type { Skill, SkillContext, ExecutionContext, ToolResult } from "../../types";
import { getErrorMessage, BUILT_IN_SKILL_VERSION } from "../../utils";

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox helpers
// ─────────────────────────────────────────────────────────────────────────────

let sandboxRoot = "/app/volumes/files";

function resolveSafe(userPath: string): string | null {
  // Normalize and resolve against the sandbox root.
  const joined = path.resolve(sandboxRoot, userPath.replace(/^\/+/, ""));
  if (!joined.startsWith(sandboxRoot + path.sep) && joined !== sandboxRoot) {
    return null; // path traversal detected
  }
  return joined;
}

function sandboxError(userPath: string): ToolResult {
  return {
    content: `Access denied: "${userPath}" resolves outside the sandbox (${sandboxRoot}).`,
    isError: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────────────────────────────────────

async function readFile(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { path: userPath } = params as { path: string };
  const fullPath = resolveSafe(userPath);
  if (!fullPath) return sandboxError(userPath);

  try {
    const content = await fsp.readFile(fullPath, "utf-8");
    return { content, data: { path: userPath, size: content.length } };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to read "${userPath}": ${msg}`, isError: true };
  }
}

async function writeFile(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { path: userPath, content } = params as { path: string; content: string };
  const fullPath = resolveSafe(userPath);
  if (!fullPath) return sandboxError(userPath);

  try {
    // Ensure parent directory exists.
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, content, "utf-8");
    return {
      content: `File "${userPath}" written successfully (${content.length} chars).`,
      data: { path: userPath, size: content.length },
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to write "${userPath}": ${msg}`, isError: true };
  }
}

async function listFiles(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { directory = "" } = (params as { directory?: string }) ?? {};
  const fullPath = resolveSafe(directory || "");
  if (!fullPath) return sandboxError(directory);

  try {
    const entries = await fsp.readdir(fullPath, { withFileTypes: true });
    const items = entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "directory" : "file",
      path: path.join(directory || "/", e.name).replace(/\\/g, "/"),
    }));
    const lines = items.map((i) => `${i.type === "directory" ? "[DIR]  " : "[FILE] "} ${i.path}`);
    return {
      content: lines.length ? lines.join("\n") : "(empty directory)",
      data: { directory: directory || "/", items },
    };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return { content: `Directory "${directory || "/"}" does not exist.`, isError: true };
    }
    const msg = getErrorMessage(err);
    return { content: `Failed to list "${directory}": ${msg}`, isError: true };
  }
}

async function deleteFile(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { path: userPath } = params as { path: string };
  const fullPath = resolveSafe(userPath);
  if (!fullPath) return sandboxError(userPath);

  try {
    const stat = await fsp.stat(fullPath);
    if (stat.isDirectory()) {
      await fsp.rm(fullPath, { recursive: true, force: true });
    } else {
      await fsp.unlink(fullPath);
    }
    return { content: `"${userPath}" deleted successfully.` };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to delete "${userPath}": ${msg}`, isError: true };
  }
}

async function searchFiles(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { query, directory = "" } = params as { query: string; directory?: string };
  const fullDir = resolveSafe(directory || "");
  if (!fullDir) return sandboxError(directory);

  const matches: Array<{ path: string; line: number; text: string }> = [];
  const MAX_MATCHES = 100;
  const lowerQuery = query.toLowerCase();

  async function walk(dir: string): Promise<void> {
    if (matches.length >= MAX_MATCHES) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES) break;
      const fullEntry = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullEntry);
      } else if (entry.isFile()) {
        try {
          const text = await fsp.readFile(fullEntry, "utf-8");
          const lines = text.split("\n");
          lines.forEach((lineText, idx) => {
            if (lineText.toLowerCase().includes(lowerQuery)) {
              const relative = path.relative(sandboxRoot, fullEntry).replace(/\\/g, "/");
              matches.push({ path: relative, line: idx + 1, text: lineText.trim() });
            }
          });
        } catch {
          // skip binary / unreadable files
        }
      }
    }
  }

  await walk(fullDir);

  if (matches.length === 0) {
    return { content: `No matches found for "${query}".`, data: { query, matches: [] } };
  }

  const lines = matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
  return {
    content: lines.join("\n"),
    data: { query, matchCount: matches.length, matches },
  };
}

async function createDirectory(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { path: userPath } = params as { path: string };
  const fullPath = resolveSafe(userPath);
  if (!fullPath) return sandboxError(userPath);

  try {
    await fsp.mkdir(fullPath, { recursive: true });
    return { content: `Directory "${userPath}" created.` };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to create directory "${userPath}": ${msg}`, isError: true };
  }
}

async function moveFile(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const { from, to } = params as { from: string; to: string };
  const fullFrom = resolveSafe(from);
  const fullTo = resolveSafe(to);
  if (!fullFrom) return sandboxError(from);
  if (!fullTo) return sandboxError(to);

  try {
    await fsp.mkdir(path.dirname(fullTo), { recursive: true });
    await fsp.rename(fullFrom, fullTo);
    return { content: `Moved "${from}" → "${to}".` };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { content: `Failed to move "${from}" to "${to}": ${msg}`, isError: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill definition
// ─────────────────────────────────────────────────────────────────────────────

const filesSkill: Skill = {
  name: "files",
  description: "Read, write, list, search, and manage files in the assistant's data volume.",
  version: BUILT_IN_SKILL_VERSION,

  async setup(context: SkillContext): Promise<void> {
    sandboxRoot = context.config.volumes.filesDir;
    // Ensure the sandbox directory exists.
    await fsp.mkdir(sandboxRoot, { recursive: true });
    context.logger.info({ sandboxRoot }, "Files skill ready.");
  },

  tools: [
    {
      name: "read_file",
      description: "Read the contents of a file from the files sandbox.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file within the files sandbox (e.g. 'notes/todo.txt').",
          },
        },
        required: ["path"],
      },
      execute: readFile,
    },
    {
      name: "write_file",
      description: "Write (create or overwrite) a file in the files sandbox.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to write to.",
          },
          content: {
            type: "string",
            description: "Text content to write into the file.",
          },
        },
        required: ["path", "content"],
      },
      execute: writeFile,
    },
    {
      name: "list_files",
      description: "List files and directories within the files sandbox.",
      parameters: {
        type: "object",
        properties: {
          directory: {
            type: "string",
            description: "Relative directory path to list. Defaults to the root of the sandbox.",
          },
        },
        required: [],
      },
      execute: listFiles,
    },
    {
      name: "delete_file",
      description: "Delete a file or directory from the files sandbox.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file or directory to delete.",
          },
        },
        required: ["path"],
      },
      execute: deleteFile,
    },
    {
      name: "search_files",
      description: "Search file contents within the files sandbox for a text query.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text to search for (case-insensitive substring match).",
          },
          directory: {
            type: "string",
            description: "Relative directory to restrict the search to. Defaults to the sandbox root.",
          },
        },
        required: ["query"],
      },
      execute: searchFiles,
    },
    {
      name: "create_directory",
      description: "Create a directory (and any missing parent directories) in the files sandbox.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path of the directory to create.",
          },
        },
        required: ["path"],
      },
      execute: createDirectory,
    },
    {
      name: "move_file",
      description: "Move or rename a file or directory within the files sandbox.",
      parameters: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "Relative source path.",
          },
          to: {
            type: "string",
            description: "Relative destination path.",
          },
        },
        required: ["from", "to"],
      },
      execute: moveFile,
    },
  ],
};

export default filesSkill;
