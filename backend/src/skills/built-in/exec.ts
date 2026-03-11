/**
 * myEA — Built-in Skill: Code Execution
 *
 * Provides shell-command and inline-script execution with hard timeouts and
 * output size limits. Commands are always run as the process owner (never
 * root-escalated). Timeouts are enforced via SIGKILL after the deadline.
 *
 * Safety guarantees:
 *  - Default timeout: 30 s, hard maximum: 120 s.
 *  - stdout + stderr capped at 50 KB before truncation.
 *  - The `MYEA_EXEC_ENABLED` environment variable must be set to "true" or
 *    the skill will refuse to execute commands (safe default).
 */

import { spawn } from "child_process";
import os from "os";
import fsp from "fs/promises";
import path from "path";
import { promisify } from "util";
import { randomUUID } from "crypto";

import type { Skill, SkillContext, ExecutionContext, ToolResult } from "../../types";
import { getErrorMessage, BUILT_IN_SKILL_VERSION } from "../../utils";

// ─────────────────────────────────────────────────────────────────────────────
// Constants & config
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 50_000;
const EXEC_ENABLED = process.env["MYEA_EXEC_ENABLED"] === "true";

// ─────────────────────────────────────────────────────────────────────────────
// Blocklist for catastrophically destructive command patterns
// These are checked against the raw command string before execution.
// This is defence-in-depth only — the primary protection is that exec is
// opt-in via MYEA_EXEC_ENABLED and runs as a non-root user inside Docker.
// ─────────────────────────────────────────────────────────────────────────────

const BLOCKED_PATTERNS: RegExp[] = [
  /rm\s+(-[^\s]*f[^\s]*|-[^\s]*r[^\s]*)\s+\/(?:\s|$)/i,  // rm -rf /
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/,               // fork bomb: :(){ :|:& };:
  />\s*\/dev\/sda/,                                         // overwrite raw disk
  /dd\s+.*of=\/dev\/(sda|hda|nvme)/i,                      // dd to raw disk
  /mkfs\s/i,                                                // format filesystem
  /chmod\s+[0-7]*7\s+\/etc\//i,                            // chmod 777 /etc/
  /chown\s+.*\s+\/etc\//i,                                  // chown /etc/
];

const BLOCKED_WORKING_DIRS: RegExp[] = [
  /^\/etc(?:\/|$)/,
  /^\/proc(?:\/|$)/,
  /^\/sys(?:\/|$)/,
  /^\/dev(?:\/|$)/,
  /^\/boot(?:\/|$)/,
  /^\/bin(?:\/|$)/,
  /^\/sbin(?:\/|$)/,
  /^\/usr\/bin(?:\/|$)/,
  /^\/usr\/sbin(?:\/|$)/,
];

function checkBlocklist(command: string): ToolResult | null {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return {
        content: "Command blocked: matches a prohibited destructive pattern.",
        isError: true,
      };
    }
  }
  return null;
}

function checkWorkingDir(resolvedDir: string): ToolResult | null {
  for (const pattern of BLOCKED_WORKING_DIRS) {
    if (pattern.test(resolvedDir)) {
      return {
        content: `Working directory "${resolvedDir}" is not permitted.`,
        isError: true,
      };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function clampTimeout(requested?: number): number {
  if (!requested || requested <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(requested * 1000, MAX_TIMEOUT_MS);
}

function truncateOutput(output: string): string {
  if (Buffer.byteLength(output) <= MAX_OUTPUT_BYTES) return output;
  const truncated = Buffer.from(output).slice(0, MAX_OUTPUT_BYTES).toString("utf-8");
  return truncated + "\n[...output truncated]";
}

function execEnabled(): ToolResult | null {
  if (!EXEC_ENABLED) {
    return {
      content: "Command execution is disabled. Set the MYEA_EXEC_ENABLED=true environment variable to enable it.",
      isError: true,
    };
  }
  return null;
}

/**
 * Run a shell command with a timeout.
 * Returns { stdout, stderr, exitCode }.
 */
function runWithTimeout(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd ?? os.tmpdir(),
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        stdout: truncateOutput(stdout),
        stderr: stderr + "\n[Process killed: timeout exceeded]",
        exitCode: -1,
      });
    }, opts.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        exitCode: code ?? 0,
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────────────────────────────────────

async function runCommand(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const disabled = execEnabled();
  if (disabled) return disabled;

  const { command, workingDir, timeout } = params as { command: string; workingDir?: string; timeout?: number };
  const timeoutMs = clampTimeout(timeout);

  // Blocklist check — defence-in-depth against catastrophically destructive patterns
  const blocked = checkBlocklist(command);
  if (blocked) return blocked;

  // Resolve workingDir. Default to /tmp; reject any system-critical directory.
  const cwd = workingDir ? path.resolve(workingDir) : os.tmpdir();
  const blockedDir = checkWorkingDir(cwd);
  if (blockedDir) return blockedDir;

  try {
    // NOTE: This passes the command string to `sh -c` which allows shell features
    // (pipes, redirects, etc.) requested by the AI. The exec skill is opt-in and
    // operates as non-root inside Docker. The blocklist above provides additional
    // defence-in-depth. The fundamental trust boundary is MYEA_EXEC_ENABLED=true.
    const result = await runWithTimeout("sh", ["-c", command], { cwd, timeoutMs });
    const output = [
      result.stdout ? `STDOUT:\n${result.stdout}` : "",
      result.stderr ? `STDERR:\n${result.stderr}` : "",
      `Exit code: ${result.exitCode}`,
    ].filter(Boolean).join("\n\n");
    return {
      content: output || `(no output) Exit code: ${result.exitCode}`,
      data: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
      isError: result.exitCode !== 0 && result.exitCode !== -1 ? true : undefined,
    };
  } catch (err) {
    return { content: `Command failed: ${getErrorMessage(err)}`, isError: true };
  }
}

async function runScript(params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const disabled = execEnabled();
  if (disabled) return disabled;

  const { language, code, timeout } = params as { language: "bash" | "python" | "node"; code: string; timeout?: number };
  const timeoutMs = clampTimeout(timeout);

  // Write the code to a temp file.
  const ext = language === "python" ? ".py" : language === "node" ? ".mjs" : ".sh";
  const tmpFile = path.join(os.tmpdir(), `myea-script-${randomUUID()}${ext}`);

  try {
    await fsp.writeFile(tmpFile, code, "utf-8");
    await fsp.chmod(tmpFile, "700");

    let interpreter: string;
    let args: string[];
    switch (language) {
      case "python":
        interpreter = "python3";
        args = [tmpFile];
        break;
      case "node":
        interpreter = "node";
        args = [tmpFile];
        break;
      default: // bash
        interpreter = "bash";
        args = [tmpFile];
    }

    const result = await runWithTimeout(interpreter, args, { cwd: os.tmpdir(), timeoutMs });
    const output = [
      result.stdout ? `STDOUT:\n${result.stdout}` : "",
      result.stderr ? `STDERR:\n${result.stderr}` : "",
      `Exit code: ${result.exitCode}`,
    ].filter(Boolean).join("\n\n");

    return {
      content: output || `(no output) Exit code: ${result.exitCode}`,
      data: { exitCode: result.exitCode, language, stdout: result.stdout, stderr: result.stderr },
      isError: result.exitCode !== 0 ? true : undefined,
    };
  } catch (err) {
    return { content: `Script execution failed: ${getErrorMessage(err)}`, isError: true };
  } finally {
    fsp.unlink(tmpFile).catch(() => { /* best effort */ });
  }
}

async function readProcessList(_params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  const disabled = execEnabled();
  if (disabled) return disabled;

  try {
    const result = await runWithTimeout("ps", ["aux", "--no-headers"], { cwd: os.tmpdir(), timeoutMs: 10_000 });
    const lines = result.stdout.trim().split("\n").slice(0, 100);
    return { content: lines.join("\n"), data: { processCount: lines.length } };
  } catch (err) {
    return { content: `Failed to list processes: ${getErrorMessage(err)}`, isError: true };
  }
}

async function checkSystemResources(_params: unknown, _ctx: ExecutionContext): Promise<ToolResult> {
  try {
    const cpuCount = os.cpus().length;
    const loadAvg = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = ((usedMem / totalMem) * 100).toFixed(1);

    const uptime = os.uptime();
    const uptimeHours = (uptime / 3600).toFixed(1);

    // Disk usage via df.
    let diskInfo = "N/A";
    try {
      const dfResult = await runWithTimeout("df", ["-h", "/"], { cwd: os.tmpdir(), timeoutMs: 5_000 });
      const dfLines = dfResult.stdout.trim().split("\n");
      if (dfLines.length >= 2) diskInfo = dfLines[1];
    } catch { /* optional */ }

    const summary = [
      `CPU: ${cpuCount} cores | Load avg (1/5/15 min): ${loadAvg.map((l) => l.toFixed(2)).join(" / ")}`,
      `Memory: ${(usedMem / 1e9).toFixed(2)} GB used / ${(totalMem / 1e9).toFixed(2)} GB total (${memPercent}%)`,
      `Uptime: ${uptimeHours} hours`,
      `Disk (/): ${diskInfo}`,
    ].join("\n");

    return {
      content: summary,
      data: {
        cpu: { cores: cpuCount, loadAvg },
        memory: { totalBytes: totalMem, freeBytes: freeMem, usedBytes: usedMem, percentUsed: parseFloat(memPercent) },
        uptimeSeconds: uptime,
        disk: diskInfo,
      },
    };
  } catch (err) {
    return { content: `Failed to check resources: ${getErrorMessage(err)}`, isError: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill definition
// ─────────────────────────────────────────────────────────────────────────────

const execSkill: Skill = {
  name: "exec",
  description:
    "Execute shell commands and inline scripts (bash, python, node) with timeout protection. Requires MYEA_EXEC_ENABLED=true.",
  version: BUILT_IN_SKILL_VERSION,

  async setup(context: SkillContext): Promise<void> {
    if (!EXEC_ENABLED) {
      context.logger.warn("Exec skill loaded but MYEA_EXEC_ENABLED is not set — all tool calls will be refused.");
    } else {
      context.logger.info("Exec skill ready. Command execution is enabled.");
    }
  },

  tools: [
    {
      name: "run_command",
      description: "Run a shell command and return stdout, stderr, and exit code.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute." },
          workingDir: { type: "string", description: "Working directory for the command. Defaults to /tmp." },
          timeout: {
            type: "integer",
            description: "Timeout in seconds (default 30, max 120).",
            minimum: 1,
            maximum: 120,
          },
        },
        required: ["command"],
      },
      execute: runCommand,
    },
    {
      name: "run_script",
      description: "Run an inline script in bash, python3, or node and return the output.",
      parameters: {
        type: "object",
        properties: {
          language: {
            type: "string",
            enum: ["bash", "python", "node"],
            description: "The scripting language to use.",
          },
          code: { type: "string", description: "The script source code to execute." },
          timeout: {
            type: "integer",
            description: "Timeout in seconds (default 30, max 120).",
            minimum: 1,
            maximum: 120,
          },
        },
        required: ["language", "code"],
      },
      execute: runScript,
    },
    {
      name: "read_process_list",
      description: "List currently running system processes (top 100 lines of ps aux).",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: readProcessList,
    },
    {
      name: "check_system_resources",
      description: "Return CPU load, memory usage, disk usage, and system uptime.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: checkSystemResources,
    },
  ],
};

export default execSkill;
