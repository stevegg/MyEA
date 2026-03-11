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
    availableProviders: string[];
  };
  platforms: Record<
    string,
    { enabled: boolean; configured: boolean }
  >;
  system: {
    timezone: string;
    defaultPlatform?: string;
    proactiveMessaging: boolean;
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

const API_BASE = (import.meta as any).env?.VITE_API_URL ?? "";

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
  const res = await api.get<ApiConfigResponse>("/api/config");
  return res.data;
}

export async function updateSettings(
  payload: UpdateSettingsPayload
): Promise<ApiConfigResponse> {
  const res = await api.patch<ApiConfigResponse>("/api/config", payload);
  return res.data;
}

export async function testAIConnection(
  provider: string,
  model: string,
  apiKey?: string
): Promise<AIProviderTestResult> {
  const res = await api.post<AIProviderTestResult>("/api/config/test-ai", {
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

export async function getConversations(
  platform?: string
): Promise<ConversationSummary[]> {
  const params = platform ? { platform } : {};
  const res = await api.get<ConversationSummary[]>("/api/conversations", { params });
  return res.data;
}

export async function getConversationMessages(
  conversationId: string
): Promise<MessageRecord[]> {
  const res = await api.get<MessageRecord[]>(
    `/api/conversations/${conversationId}/messages`
  );
  return res.data;
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
  const res = await api.get<SkillRegistryEntry[]>("/api/skills");
  return res.data;
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
  const res = await api.get<IntegrationRecord[]>("/api/integrations");
  return res.data;
}

export async function connectIntegration(
  name: string,
  payload: IntegrationConnectPayload
): Promise<IntegrationRecord> {
  const res = await api.post<IntegrationRecord>(
    `/api/integrations/${name}/connect`,
    payload
  );
  return res.data;
}

export async function disconnectIntegration(name: string): Promise<void> {
  await api.post(`/api/integrations/${name}/disconnect`);
}

export async function getOAuthUrl(
  name: string
): Promise<{ url: string }> {
  const res = await api.get<{ url: string }>(`/api/integrations/${name}/oauth-url`);
  return res.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform connectors
// ─────────────────────────────────────────────────────────────────────────────

export async function updatePlatform(
  platform: string,
  payload: PlatformConnectPayload & { enabled?: boolean }
): Promise<void> {
  await api.patch(`/api/platforms/${platform}`, payload);
}

export async function getWhatsAppQR(): Promise<{ qr: string | null; status: string }> {
  const res = await api.get<{ qr: string | null; status: string }>(
    "/api/platforms/whatsapp/qr"
  );
  return res.data;
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
  const res = await api.get<LogEntry[]>("/api/logs", { params });
  return res.data;
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
  platform: string
): Promise<{ ok: boolean; message: string }> {
  const res = await api.post<{ ok: boolean; message: string }>(
    `/api/platforms/${platform}/test`
  );
  return res.data;
}
