/**
 * myEA — Skills Engine
 *
 * Hot-loadable skill registry. Loads built-in skills at startup and watches
 * /app/data/skills/ (config.volumes.skillsDir) for custom skills added at
 * runtime. A broken custom skill is isolated — it cannot crash the engine.
 *
 * Events emitted (via EventEmitter):
 *   "skill:loaded"   — { entry: SkillRegistryEntry }
 *   "skill:unloaded" — { name: string }
 *   "skill:error"    — { name: string; error: string }
 */

import path from "path";
import fs from "fs";
import { EventEmitter } from "events";
import chokidar, { FSWatcher } from "chokidar";
import { randomUUID } from "crypto";

import type {
  Skill,
  SkillContext,
  SkillRegistryEntry,
  ExecutionContext,
  ToolResult,
  Logger,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

interface LoadedSkill {
  entry: SkillRegistryEntry;
  skill: Skill;
}

// ─────────────────────────────────────────────────────────────────────────────
// SkillEngine
// ─────────────────────────────────────────────────────────────────────────────

export class SkillEngine extends EventEmitter {
  private readonly registry = new Map<string, LoadedSkill>();
  private watcher: FSWatcher | null = null;
  private context: SkillContext | null = null;
  private readonly logger: Logger;

  /** Cached result of getAllTools(). Invalidated on any skill load/unload. */
  private _allToolsCache: ReturnType<SkillEngine["getAllTools"]> | null = null;

  /** Absolute path to the built-in skills directory. */
  private readonly builtInDir: string;

  /** Absolute path to the user-supplied custom skills directory. */
  private readonly customDir: string;

  constructor(logger: Logger, customSkillsDir: string) {
    super();
    this.logger = logger.child({ component: "SkillEngine" });
    // Built-ins live next to this file at runtime (compiled to dist/skills/built-in/).
    // During development (tsx / ts-node) __dirname points to src/skills/.
    this.builtInDir = path.resolve(__dirname, "built-in");
    this.customDir = customSkillsDir;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Initialise the engine. Must be called once at application startup,
   * after the SkillContext (db, memory, scheduler, etc.) is available.
   */
  async start(context: SkillContext): Promise<void> {
    this.context = context;

    // 1. Load all built-in skills.
    await this.loadDirectory(this.builtInDir, true);

    // 2. Load any custom skills already on disk.
    if (fs.existsSync(this.customDir)) {
      await this.loadDirectory(this.customDir, false);
    } else {
      this.logger.info({ customDir: this.customDir }, "Custom skills dir does not exist yet — watching parent for creation.");
    }

    // 3. Watch the custom skills directory for changes.
    this.startWatcher();
  }

  /** Gracefully tear down all skills and stop the watcher. */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    // Teardown in reverse registration order (newest first).
    const entries = [...this.registry.values()].reverse();
    for (const loaded of entries) {
      await this.teardownSkill(loaded);
    }
    this.registry.clear();
    this.logger.info("SkillEngine stopped.");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────────────────────────────────────

  /** Returns a flat list of every tool across all enabled, loaded skills.
   *  Result is cached and invalidated whenever a skill is loaded or unloaded.
   */
  getAllTools(): Array<{ skillName: string; toolName: string; description: string; parameters: object }> {
    if (this._allToolsCache !== null) return this._allToolsCache;

    const tools: Array<{ skillName: string; toolName: string; description: string; parameters: object }> = [];
    for (const { entry, skill } of this.registry.values()) {
      if (!entry.enabled) continue;
      for (const tool of skill.tools) {
        tools.push({
          skillName: entry.name,
          toolName: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        });
      }
    }
    this._allToolsCache = tools;
    return tools;
  }

  /**
   * Find a tool by name across all loaded skills and execute it.
   * Returns an error ToolResult instead of throwing if the tool is not found
   * or if execution itself throws.
   */
  async executeTool(
    toolName: string,
    params: unknown,
    context: ExecutionContext
  ): Promise<ToolResult> {
    for (const { entry, skill } of this.registry.values()) {
      if (!entry.enabled) continue;
      const tool = skill.tools.find((t) => t.name === toolName);
      if (!tool) continue;

      try {
        const result = await tool.execute(params, context);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error({ toolName, err }, `Tool execution error: ${message}`);
        return { content: `Tool "${toolName}" threw an error: ${message}`, isError: true };
      }
    }

    return {
      content: `No tool named "${toolName}" found in any loaded skill.`,
      isError: true,
    };
  }

  /** Return all current registry entries (for the admin UI). */
  getRegistry(): SkillRegistryEntry[] {
    return [...this.registry.values()].map((l) => l.entry);
  }

  /** Enable or disable a skill by name (in-memory; does not persist). */
  setEnabled(skillName: string, enabled: boolean): void {
    const loaded = this.registry.get(skillName);
    if (loaded) {
      loaded.entry.enabled = enabled;
      // Invalidate tool cache since enabled set changed
      this._allToolsCache = null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Directory loading
  // ───────────────────────────────────────────────────────────────────────────

  private async loadDirectory(dir: string, builtIn: boolean): Promise<void> {
    if (!fs.existsSync(dir)) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      this.logger.error({ dir, err }, "Failed to read skills directory.");
      return;
    }

    const skillFiles = entries
      .filter((e) => e.isFile() && /\.(js|ts)$/.test(e.name) && !e.name.startsWith("_"))
      .map((e) => path.join(dir, e.name));

    for (const filePath of skillFiles) {
      await this.loadSkillFile(filePath, builtIn);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Single-file load / unload / reload
  // ───────────────────────────────────────────────────────────────────────────

  private async loadSkillFile(filePath: string, builtIn: boolean): Promise<void> {
    this.logger.debug({ filePath }, "Loading skill file.");

    let rawModule: unknown;
    try {
      // Clear require cache so hot-reload picks up fresh code.
      this.clearRequireCache(filePath);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      rawModule = require(filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ filePath, err }, `Failed to require skill file: ${message}`);
      this.emitSkillError(path.basename(filePath, path.extname(filePath)), message);
      return;
    }

    // Support both `export default skill` (ESM-style via tsx) and `module.exports = skill`.
    const skill = this.extractDefault(rawModule);

    const validation = this.validateSkill(skill);
    if (!validation.valid) {
      const message = `Skill validation failed: ${validation.reason}`;
      this.logger.error({ filePath, reason: validation.reason }, message);
      this.emitSkillError(path.basename(filePath, path.extname(filePath)), message);
      return;
    }

    const typedSkill = skill as Skill;

    // If an old version of this skill is loaded, tear it down first.
    if (this.registry.has(typedSkill.name)) {
      await this.unloadSkill(typedSkill.name);
    }

    // Build the registry entry.
    const entry: SkillRegistryEntry = {
      id: randomUUID(),
      name: typedSkill.name,
      description: typedSkill.description,
      version: typedSkill.version,
      filePath,
      enabled: true,
      builtIn,
      loadedAt: new Date().toISOString(),
      tools: typedSkill.tools.map((t) => ({ name: t.name, description: t.description })),
    };

    // Run the skill's setup hook (isolated — errors don't crash the engine).
    if (typedSkill.setup && this.context) {
      try {
        await typedSkill.setup(this.context);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        entry.loadError = message;
        entry.enabled = false;
        this.logger.error({ skillName: typedSkill.name, err }, `Skill setup failed: ${message}`);
        this.emitSkillError(typedSkill.name, message);
        // Still register the entry so the admin UI can see the error.
        this.registry.set(typedSkill.name, { entry, skill: typedSkill });
        return;
      }
    }

    this.registry.set(typedSkill.name, { entry, skill: typedSkill });
    // Invalidate the getAllTools() cache after any registry change
    this._allToolsCache = null;
    this.logger.info({ skillName: typedSkill.name, version: typedSkill.version, toolCount: typedSkill.tools.length }, "Skill loaded.");
    this.emit("skill:loaded", { entry });
  }

  private async unloadSkill(skillName: string): Promise<void> {
    const loaded = this.registry.get(skillName);
    if (!loaded) return;

    await this.teardownSkill(loaded);
    this.registry.delete(skillName);
    // Invalidate the getAllTools() cache after any registry change
    this._allToolsCache = null;
    this.logger.info({ skillName }, "Skill unloaded.");
    this.emit("skill:unloaded", { name: skillName });
  }

  private async teardownSkill(loaded: LoadedSkill): Promise<void> {
    if (loaded.skill.teardown) {
      try {
        await loaded.skill.teardown();
      } catch (err) {
        this.logger.error({ skillName: loaded.entry.name, err }, "Skill teardown threw — ignoring.");
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // File watcher (hot-reload)
  // ───────────────────────────────────────────────────────────────────────────

  private startWatcher(): void {
    // Watch the custom dir; use polling inside Docker volumes for reliability.
    this.watcher = chokidar.watch(this.customDir, {
      persistent: true,
      ignoreInitial: true,       // already loaded above
      awaitWriteFinish: {
        stabilityThreshold: 500, // wait 500 ms after last write before triggering
        pollInterval: 100,
      },
      // Ignore hidden files and TypeScript build artefacts.
      ignored: /(^|[/\\])(\.|_|node_modules)/,
    });

    this.watcher
      .on("add", (filePath) => {
        if (this.isSkillFile(filePath)) {
          this.logger.info({ filePath }, "New custom skill detected.");
          this.loadSkillFile(filePath, false).catch(() => {});
        }
      })
      .on("change", (filePath) => {
        if (this.isSkillFile(filePath)) {
          this.logger.info({ filePath }, "Custom skill file changed — hot-reloading.");
          this.loadSkillFile(filePath, false).catch(() => {});
        }
      })
      .on("unlink", (filePath) => {
        if (this.isSkillFile(filePath)) {
          this.logger.info({ filePath }, "Custom skill file removed — unloading.");
          // Find the skill whose filePath matches.
          for (const [name, loaded] of this.registry.entries()) {
            if (loaded.entry.filePath === filePath) {
              this.unloadSkill(name).catch(() => {});
              break;
            }
          }
        }
      })
      .on("error", (err) => {
        this.logger.error({ err }, "Chokidar watcher error.");
      });

    this.logger.info({ dir: this.customDir }, "Watching custom skills directory.");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────────

  private isSkillFile(filePath: string): boolean {
    const ext = path.extname(filePath);
    const base = path.basename(filePath);
    return (ext === ".js" || ext === ".ts") && !base.startsWith("_");
  }

  /**
   * Clear node's require cache for a file and all relative modules it may
   * have pulled in (same directory). This ensures hot-reload sees fresh code.
   */
  private clearRequireCache(filePath: string): void {
    const resolved = require.resolve(filePath);
    const dir = path.dirname(resolved);

    for (const key of Object.keys(require.cache)) {
      if (key === resolved || key.startsWith(dir + path.sep)) {
        delete require.cache[key];
      }
    }
  }

  private extractDefault(mod: unknown): unknown {
    if (mod && typeof mod === "object" && "default" in mod) {
      return (mod as Record<string, unknown>).default;
    }
    return mod;
  }

  private validateSkill(skill: unknown): { valid: boolean; reason?: string } {
    if (!skill || typeof skill !== "object") {
      return { valid: false, reason: "Module default export is not an object." };
    }
    const s = skill as Record<string, unknown>;
    if (typeof s.name !== "string" || !s.name.trim()) {
      return { valid: false, reason: "Skill must have a non-empty string 'name'." };
    }
    if (typeof s.description !== "string") {
      return { valid: false, reason: "Skill must have a string 'description'." };
    }
    if (typeof s.version !== "string") {
      return { valid: false, reason: "Skill must have a string 'version'." };
    }
    if (!Array.isArray(s.tools)) {
      return { valid: false, reason: "Skill must have a 'tools' array." };
    }
    for (const tool of s.tools as unknown[]) {
      if (!tool || typeof tool !== "object") {
        return { valid: false, reason: "Each tool must be an object." };
      }
      const t = tool as Record<string, unknown>;
      if (typeof t.name !== "string" || !t.name.trim()) {
        return { valid: false, reason: "Each tool must have a non-empty string 'name'." };
      }
      if (typeof t.description !== "string") {
        return { valid: false, reason: `Tool "${t.name}" must have a string 'description'.` };
      }
      if (typeof t.execute !== "function") {
        return { valid: false, reason: `Tool "${t.name}" must have an 'execute' function.` };
      }
      if (!t.parameters || typeof t.parameters !== "object") {
        return { valid: false, reason: `Tool "${t.name}" must have a 'parameters' JSON Schema object.` };
      }
    }
    return { valid: true };
  }

  private emitSkillError(name: string, error: string): void {
    this.emit("skill:error", { name, error });
  }
}
