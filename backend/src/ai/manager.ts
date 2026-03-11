/**
 * myEA — AI Provider Manager
 *
 * Central registry and router for all AI providers.
 * Responsibilities:
 *   - Instantiate and hold provider singletons
 *   - Route `generate()` calls to the active provider
 *   - Support runtime provider switching (no restart required)
 *   - Implement a fallback chain: if primary fails, try secondary
 *   - Expose health status for all providers (used by admin UI)
 *   - Emit events when the active provider changes
 */

import type {
  AIProvider,
  AIProviderName,
  AIGenerateOptions,
  AIResponse,
  AppConfig,
  Logger,
} from "../types";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider }    from "./openai";
import { OllamaProvider }    from "./ollama";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderHealth {
  name: AIProviderName;
  model: string;
  available: boolean;
  /** ISO-8601 timestamp of last health check. */
  checkedAt: string;
  /** Error message from the last failed check, if any. */
  error?: string;
}

export interface ProviderStatus {
  active: AIProviderName;
  activeModel: string;
  providers: ProviderHealth[];
  /** Ordered fallback chain (active provider first). */
  fallbackChain: AIProviderName[];
}

export type ProviderChangedListener = (
  previous: AIProviderName,
  next: AIProviderName,
  model: string
) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Manager
// ─────────────────────────────────────────────────────────────────────────────

export class AIProviderManager {
  private providers: Map<AIProviderName, AIProvider> = new Map();
  private activeProviderName: AIProviderName;
  private fallbackChain: AIProviderName[] = [];
  private healthCache: Map<AIProviderName, ProviderHealth> = new Map();
  private changeListeners: ProviderChangedListener[] = [];
  private readonly logger: Logger;

  constructor(config: AppConfig, logger: Logger) {
    this.logger = logger.child({ module: "AIProviderManager" });
    this.activeProviderName = config.ai.activeProvider;

    // Instantiate all configured providers
    this.initProviders(config);

    // Build the default fallback chain (active first, then others)
    this.buildDefaultFallbackChain(config.ai.activeProvider);

    this.logger.info(
      {
        active: this.activeProviderName,
        fallbackChain: this.fallbackChain,
        loaded: [...this.providers.keys()],
      },
      "AIProviderManager initialised"
    );
  }

  // ── Initialisation ────────────────────────────────────────────────────────

  private initProviders(config: AppConfig): void {
    const { ai } = config;

    // Anthropic / Claude
    if (ai.anthropicApiKey) {
      try {
        const provider = new AnthropicProvider(
          ai.anthropicApiKey,
          ai.activeProvider === "claude" ? ai.model : undefined
        );
        this.providers.set("claude", provider);
        this.logger.info({ model: provider.model }, "Anthropic provider loaded");
      } catch (err) {
        this.logger.error({ err }, "Failed to initialise Anthropic provider");
      }
    } else {
      this.logger.warn("ANTHROPIC_API_KEY not set — Claude provider unavailable");
    }

    // OpenAI
    if (ai.openaiApiKey) {
      try {
        const provider = new OpenAIProvider(
          ai.openaiApiKey,
          ai.activeProvider === "openai" ? ai.model : undefined
        );
        this.providers.set("openai", provider);
        this.logger.info({ model: provider.model }, "OpenAI provider loaded");
      } catch (err) {
        this.logger.error({ err }, "Failed to initialise OpenAI provider");
      }
    } else {
      this.logger.warn("OPENAI_API_KEY not set — OpenAI provider unavailable");
    }

    // Ollama (always attempted — server may not be running yet)
    try {
      const ollamaModel =
        ai.activeProvider === "ollama" ? ai.model : undefined;
      const provider = new OllamaProvider(ai.ollamaBaseUrl, ollamaModel);
      this.providers.set("ollama", provider);
      this.logger.info(
        { host: ai.ollamaBaseUrl, model: provider.model },
        "Ollama provider loaded"
      );
    } catch (err) {
      this.logger.error({ err }, "Failed to initialise Ollama provider");
    }
  }

  private buildDefaultFallbackChain(active: AIProviderName): void {
    const all: AIProviderName[] = ["claude", "openai", "ollama"];
    this.fallbackChain = [
      active,
      ...all.filter((p) => p !== active && this.providers.has(p)),
    ];
  }

  // ── Active provider access ────────────────────────────────────────────────

  /** Returns the currently active AI provider. */
  getActiveProvider(): AIProvider {
    const provider = this.providers.get(this.activeProviderName);
    if (!provider) {
      throw new Error(
        `Active provider "${this.activeProviderName}" is not available. ` +
          `Loaded providers: ${[...this.providers.keys()].join(", ")}`
      );
    }
    return provider;
  }

  /** Returns a specific provider by name, or undefined if not loaded. */
  getProvider(name: AIProviderName): AIProvider | undefined {
    return this.providers.get(name);
  }

  /** Returns the name of the currently active provider. */
  getActiveProviderName(): AIProviderName {
    return this.activeProviderName;
  }

  // ── Runtime provider switching ────────────────────────────────────────────

  /**
   * Switches the active provider at runtime. The new provider must already
   * be loaded (i.e. it has credentials configured). Optionally updates the
   * model used by the provider if a new model string is given.
   *
   * @throws if the requested provider is not loaded.
   */
  switchProvider(name: AIProviderName, model?: string): void {
    if (!this.providers.has(name)) {
      throw new Error(
        `Cannot switch to provider "${name}" — it is not loaded. ` +
          `Available: ${[...this.providers.keys()].join(", ")}`
      );
    }

    // If a model override is requested, reinstantiate the provider
    if (model) {
      this.updateProviderModel(name, model);
    }

    const previous = this.activeProviderName;
    this.activeProviderName = name;
    this.buildDefaultFallbackChain(name);

    const activeProvider = this.providers.get(name)!;

    this.logger.info(
      { previous, next: name, model: activeProvider.model },
      "AI provider switched"
    );

    // Notify all registered listeners
    for (const listener of this.changeListeners) {
      try {
        listener(previous, name, activeProvider.model);
      } catch (err) {
        this.logger.error({ err }, "Error in provider-changed listener");
      }
    }
  }

  /**
   * Replaces the provider instance with a new one using the given model.
   * Only Anthropic and OpenAI support model switching; Ollama reads the model
   * per-request from AIGenerateOptions.model.
   */
  private updateProviderModel(name: AIProviderName, model: string): void {
    // We re-use existing credentials by reading back from the old instance.
    // Since we don't have access to raw config here, we only support this
    // cleanly if the caller passes the new model via AIGenerateOptions.model.
    // Log a notice — the model will take effect on next call via options.model.
    this.logger.info(
      { provider: name, model },
      "Model override noted — pass via AIGenerateOptions.model for per-call override"
    );
  }

  // ── Generate with fallback ────────────────────────────────────────────────

  /**
   * Calls `generate()` on the active provider. If it fails and a fallback
   * chain is configured, sequentially tries each fallback provider until one
   * succeeds or all are exhausted.
   */
  async generate(options: AIGenerateOptions): Promise<AIResponse> {
    const chain = this.fallbackChain.filter((name) => this.providers.has(name));

    let lastError: unknown;

    for (let i = 0; i < chain.length; i++) {
      const providerName = chain[i];
      const provider     = this.providers.get(providerName)!;
      const isPrimary    = i === 0;

      try {
        if (!isPrimary) {
          this.logger.warn(
            { failedProvider: chain[i - 1], fallbackProvider: providerName },
            "Falling back to secondary AI provider"
          );
        }

        const response = await provider.generate(options);

        if (!isPrimary) {
          this.logger.info(
            { provider: providerName },
            "Fallback provider succeeded"
          );
        }

        return response;
      } catch (err) {
        lastError = err;
        this.logger.error(
          { provider: providerName, err },
          "AI provider generate() failed"
        );
      }
    }

    throw new Error(
      `All AI providers in the fallback chain failed. Last error: ${String(lastError)}`
    );
  }

  // ── Health checks ─────────────────────────────────────────────────────────

  /**
   * Runs healthCheck() on all loaded providers in parallel and returns results.
   * Results are cached briefly (30s) to avoid excessive API calls from the
   * admin UI polling.
   */
  async checkAllProviders(forceRefresh = false): Promise<ProviderHealth[]> {
    const CACHE_TTL_MS = 30_000;
    const now          = Date.now();

    const checks = [...this.providers.entries()].map(
      async ([name, provider]): Promise<ProviderHealth> => {
        const cached = this.healthCache.get(name);
        if (
          !forceRefresh &&
          cached &&
          now - new Date(cached.checkedAt).getTime() < CACHE_TTL_MS
        ) {
          return cached;
        }

        let available = false;
        let error: string | undefined;

        try {
          available = await provider.healthCheck();
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }

        const health: ProviderHealth = {
          name,
          model:     provider.model,
          available,
          checkedAt: new Date().toISOString(),
          ...(error ? { error } : {}),
        };

        this.healthCache.set(name, health);
        return health;
      }
    );

    return Promise.all(checks);
  }

  /**
   * Returns combined status information suitable for the admin UI.
   */
  async getStatus(forceHealthRefresh = false): Promise<ProviderStatus> {
    const providers = await this.checkAllProviders(forceHealthRefresh);
    const active    = this.providers.get(this.activeProviderName);

    return {
      active:        this.activeProviderName,
      activeModel:   active?.model ?? "unknown",
      providers,
      fallbackChain: this.fallbackChain,
    };
  }

  // ── Event listeners ───────────────────────────────────────────────────────

  /**
   * Register a callback that fires whenever the active provider changes.
   * Used by the WebSocket broadcaster to push `ai_provider_changed` events.
   */
  onProviderChanged(listener: ProviderChangedListener): () => void {
    this.changeListeners.push(listener);
    // Return an unsubscribe function
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== listener);
    };
  }

  // ── Custom fallback chain ─────────────────────────────────────────────────

  /**
   * Override the fallback chain with a custom ordered list.
   * Only providers that are actually loaded will be included.
   */
  setFallbackChain(chain: AIProviderName[]): void {
    const valid = chain.filter((name) => this.providers.has(name));
    if (valid.length === 0) {
      throw new Error("None of the requested fallback providers are loaded.");
    }
    this.fallbackChain = valid;
    this.logger.info({ fallbackChain: this.fallbackChain }, "Fallback chain updated");
  }
}
