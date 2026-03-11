import axios, { AxiosInstance, AxiosError } from "axios";

// ─────────────────────────────────────────────────────────────────────────────
// Shared domain types (inlined to avoid cross-package imports in the build)
// These must be kept in sync with backend/src/types/index.ts
// ─────────────────────────────────────────────────────────────────────────────

export interface LoginResponse {
  token: string;
  expiresIn: string;
}

export interface ConversationSummary {
  id: string;
  platform: string;
  platformUserId: string;
  platformUserName?: string | null;
  platformChannelId: string;
  platformGuildId?: string | null;
  messageCount: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  platform?: string;
  toolName?: string | null;
  toolCallId?: string | null;
  aiProvider?: string | null;
  aiModel?: string | null;
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  platformMessageId?: string | null;
  createdAt: string;
}

export interface SkillRegistryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  filePath?: string | null;
  enabled: boolean;
  builtIn: boolean;
  loadedAt?: string | null;
  loadError?: string | null;
  tools: Array<{ name: string; description: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationRecord {
  id: string;
  name: string;
  displayName: string;
  enabled: boolean;
  status: "connected" | "disconnected" | "error" | "pending_auth";
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string | null;
  errorMessage?: string | null;
}

export interface LogEntry {
  id: string;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  message: string;
  data?: Record<string, unknown>;
  source?: string;
  platform?: string;
  context?: Record<string, unknown>;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types used by the API client (frontend-local extensions)
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiConfigResponse {
  ai: {
    activeProvider: string;
    model: string;
    availableProviders?: string[];
    ollamaBaseUrl?: string;
    anthropicConfigured?: boolean;
    openaiConfigured?: boolean;
  };
  platforms: Record<
    string,
    { enabled: boolean; configured?: boolean }
  >;
  /** Called "assistant" in the backend /api/settings response */
  assistant?: {
    timezone: string;
    defaultPlatform?: string;
    maxHistory?: number;
    execTimeoutMs?: number;
  };
  /** Alias so Settings.tsx can use config.system — maps to assistant */
  system?: {
    timezone: string;
    defaultPlatform?: string;
    proactiveMessaging?: boolean;
  };
}

export interface ApiUser {
  id: string;
  username: string;
  createdAt: string;
}

export interface UpdateSettingsPayload {
  ai?: {
    activeProvider?: string;
    model?: string;
    apiKey?: string;
  };
  system?: {
    timezone?: string;
    defaultPlatform?: string;
    proactiveMessaging?: boolean;
  };
}

export interface UpdateUserPayload {
  username?: string;
  currentPassword?: string;
  newPassword?: string;
}

export interface IntegrationConnectPayload {
  apiKey?: string;
  baseUrl?: string;
  name?: string;
  token?: string;
}

export interface PlatformConnectPayload {
  botToken?: string;
  clientId?: string;
  appToken?: string;
  signingSecret?: string;
  phoneNumber?: string;
}

export interface AIProviderTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

// (Types are defined above — no re-export needed)

// ─────────────────────────────────────────────────────────────────────────────
// Axios instance with JWT interceptors
// ─────────────────────────────────────────────────────────────────────────────

// Empty baseURL — requests go to the same origin.
// Vite proxy (dev) and nginx (prod) handle routing /api and /auth to the backend.
const API_BASE = "";

export const api: AxiosInstance = axios.create({
  baseURL: API_BASE,
  timeout: 15_000,
  headers: { "Content-Type": "application/json" },
});

// Attach JWT to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("myea_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle 401 — clear token and redirect to login
api.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("myea_token");
      if (!window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }
    return Promise.reject(err);
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

export async function login(
  username: string,
  password: string
): Promise<LoginResponse> {
  const res = await api.post<LoginResponse>("/auth/login", { username, password });
  return res.data;
}

export async function register(
  username: string,
  password: string
): Promise<LoginResponse> {
  const res = await api.post<LoginResponse>("/auth/register", { username, password });
  return res.data;
}

export async function checkFirstRun(): Promise<{ firstRun: boolean }> {
  const res = await api.get<{ firstRun: boolean }>("/auth/first-run");
  return res.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config / Settings
// ─────────────────────────────────────────────────────────────────────────────

export async function getConfig(): Promise<ApiConfigResponse> {
  // /api/settings returns the full config including assistant (timezone etc.)
  // /api/config only returns ai + platforms + integrations (no system/assistant)
  const res = await api.get<ApiConfigResponse>("/api/settings");
  const data = res.data as any;
  // Normalise: backend uses "assistant", Settings.tsx uses "system" — expose both
  if (data.assistant && !data.system) {
    data.system = {
      timezone: data.assistant.timezone,
      defaultPlatform: data.assistant.defaultPlatform,
      proactiveMessaging: false,
    };
  }
  return data as ApiConfigResponse;
}

export async function updateSettings(
  payload: UpdateSettingsPayload
): Promise<ApiConfigResponse> {
  // Map frontend "system" key back to backend "assistant" key
  const backendPayload: any = { ...payload };
  if (payload.system && !backendPayload.assistant) {
    backendPayload.assistant = payload.system;
    delete backendPayload.system;
  }
  const res = await api.put<ApiConfigResponse>("/api/settings", backendPayload);
  const data = res.data as any;
  if (data.assistant && !data.system) {
    data.system = {
      timezone: data.assistant.timezone,
      defaultPlatform: data.assistant.defaultPlatform,
      proactiveMessaging: false,
    };
  }
  return data as ApiConfigResponse;
}

export async function testAIConnection(
  provider: string,
  model: string,
  apiKey?: string
): Promise<AIProviderTestResult> {
  const res = await api.post<AIProviderTestResult>("/api/settings/test-ai", {
    provider,
    model,
    apiKey,
  });
  return res.data;
}

export async function getMe(): Promise<ApiUser> {
  const res = await api.get<ApiUser>("/api/me");
  return res.data;
}

export async function updateUser(payload: UpdateUserPayload): Promise<ApiUser> {
  const res = await api.patch<ApiUser>("/api/me", payload);
  return res.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversations
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatImage {
  base64: string;
  mimeType: string;
}

export async function sendChat(
  message: string,
  conversationId?: string,
  images?: ChatImage[]
): Promise<{ conversationId: string; reply: string }> {
  const res = await api.post<{ conversationId: string; reply: string }>("/api/chat", {
    message,
    conversationId,
    ...(images && images.length > 0 ? { images } : {}),
  });
  return res.data;
}

export async function getConversations(
  platform?: string
): Promise<ConversationSummary[]> {
  const params = platform ? { platform } : {};
  const res = await api.get<{ data: ConversationSummary[] } | ConversationSummary[]>(
    "/api/conversations",
    { params }
  );
  return Array.isArray(res.data) ? res.data : (res.data as any).data ?? [];
}

export async function getConversationMessages(
  conversationId: string
): Promise<MessageRecord[]> {
  const res = await api.get<{ data: MessageRecord[] } | MessageRecord[]>(
    `/api/conversations/${conversationId}/messages`
  );
  return Array.isArray(res.data) ? res.data : (res.data as any).data ?? [];
}

export async function deleteConversation(conversationId: string): Promise<void> {
  await api.delete(`/api/conversations/${conversationId}`);
}

export async function clearAllConversations(): Promise<void> {
  await api.delete("/api/conversations");
}

// ─────────────────────────────────────────────────────────────────────────────
// Skills
// ─────────────────────────────────────────────────────────────────────────────

export async function getSkills(): Promise<SkillRegistryEntry[]> {
  const res = await api.get<{ data: SkillRegistryEntry[] } | SkillRegistryEntry[]>("/api/skills");
  return Array.isArray(res.data) ? res.data : (res.data as any).data ?? [];
}

export async function toggleSkill(
  name: string,
  enabled: boolean
): Promise<SkillRegistryEntry> {
  const res = await api.patch<SkillRegistryEntry>(`/api/skills/${name}`, { enabled });
  return res.data;
}

export async function reloadSkills(): Promise<{ reloaded: number }> {
  const res = await api.post<{ reloaded: number }>("/api/skills/reload");
  return res.data;
}

export async function uploadSkill(file: File): Promise<SkillRegistryEntry> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await api.post<SkillRegistryEntry>("/api/skills/upload", fd, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return res.data;
}

export async function deleteSkill(name: string): Promise<void> {
  await api.delete(`/api/skills/${name}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Integrations
// ─────────────────────────────────────────────────────────────────────────────

export async function getIntegrations(): Promise<IntegrationRecord[]> {
  const res = await api.get<{ data: IntegrationRecord[] } | IntegrationRecord[]>("/api/integrations");
  return Array.isArray(res.data) ? res.data : (res.data as any).data ?? [];
}

export async function connectIntegration(
  name: string,
  payload: IntegrationConnectPayload
): Promise<IntegrationRecord> {
  // Upsert via POST /api/integrations (onConflictDoUpdate on name)
  const displayName = payload.name ?? name.charAt(0).toUpperCase() + name.slice(1);
  const config: Record<string, unknown> = {};
  if (payload.apiKey) config.apiKey = payload.apiKey;
  if (payload.token) config.token = payload.token;
  if (payload.baseUrl) config.baseUrl = payload.baseUrl;
  const res = await api.post<IntegrationRecord>("/api/integrations", {
    name,
    displayName,
    config,
    enabled: true,
  });
  return res.data;
}

export async function disconnectIntegration(name: string): Promise<void> {
  // Upsert with enabled: false — backend onConflictDoUpdate keeps the name unique
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);
  await api.post("/api/integrations", {
    name,
    displayName,
    enabled: false,
    config: {},
  });
}

export async function getOAuthUrl(
  name: string
): Promise<{ url: string }> {
  const res = await api.post<{ authUrl: string }>(`/api/integrations/${name}/oauth/start`);
  return { url: res.data.authUrl };
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform connectors
// ─────────────────────────────────────────────────────────────────────────────

export async function updatePlatform(
  platform: string,
  payload: PlatformConnectPayload & { enabled?: boolean }
): Promise<void> {
  // Backend stores platform config under PUT /api/settings → platforms.<name>
  await api.put("/api/settings", {
    platforms: { [platform]: payload },
  });
}

export async function getWhatsAppQR(): Promise<{ qr: string | null; status: string }> {
  // WhatsApp QR is delivered via WebSocket (type: "whatsapp_qr") — no REST endpoint exists.
  // Return a no-op so the polling query doesn't 404.
  return { qr: null, status: "unknown" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Logs
// ─────────────────────────────────────────────────────────────────────────────

export async function getLogs(params?: {
  limit?: number;
  level?: string;
  platform?: string;
  from?: string;
  to?: string;
}): Promise<LogEntry[]> {
  const res = await api.get<{ data: LogEntry[] } | LogEntry[]>("/api/logs", { params });
  return Array.isArray(res.data) ? res.data : (res.data as any).data ?? [];
}

export async function clearOldLogs(olderThanDays?: number): Promise<{ deleted: number }> {
  const res = await api.delete<{ deleted: number }>("/api/logs", {
    data: { olderThanDays },
  });
  return res.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// System actions
// ─────────────────────────────────────────────────────────────────────────────

export async function clearMemory(): Promise<void> {
  await api.post("/api/system/clear-memory");
}

export async function testPlatformConnection(
  _platform: string
): Promise<{ ok: boolean; message: string }> {
  // No platform test endpoint exists in the backend yet.
  return { ok: false, message: "Platform connection test not available." };
}
