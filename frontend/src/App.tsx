import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  createRouter,
  createRoute,
  createRootRoute,
  RouterProvider,
  Outlet,
  Link,
  useNavigate,
  redirect,
} from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import {
  LayoutDashboard,
  MessageSquare,
  Puzzle,
  Plug2,
  FileText,
  Settings,
  LogOut,
  Menu,
  X,
  Wifi,
  WifiOff,
  Bot,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// API client
// ─────────────────────────────────────────────────────────────────────────────

const API_URL = (import.meta as any).env?.VITE_API_URL ?? "";

const api = axios.create({ baseURL: API_URL });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("myea_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("myea_token");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Auth context
// ─────────────────────────────────────────────────────────────────────────────

interface AuthContextValue {
  token: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  token: null,
  login: async () => {},
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem("myea_token")
  );

  const login = async (username: string, password: string) => {
    const res = await api.post<{ token: string }>("/auth/login", { username, password });
    const t = res.data.token;
    localStorage.setItem("myea_token", t);
    setToken(t);
  };

  const logout = () => {
    localStorage.removeItem("myea_token");
    setToken(null);
  };

  return (
    <AuthContext.Provider value={{ token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket context
// ─────────────────────────────────────────────────────────────────────────────

const WS_URL = (import.meta as any).env?.VITE_WS_URL ?? "ws://localhost:3001";

interface WSContextValue {
  connected: boolean;
  lastEvent: unknown;
}

const WSContext = createContext<WSContextValue>({ connected: false, lastEvent: null });

export function useWS() {
  return useContext(WSContext);
}
export const useWSContext = useWS;

function WSProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<unknown>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const { token } = useAuth();

  useEffect(() => {
    if (!token) return;

    const connect = () => {
      const wsToken = localStorage.getItem("myea_token");
      const wsUrl = wsToken ? `${WS_URL}/ws?token=${encodeURIComponent(wsToken)}` : `${WS_URL}/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        // Reconnect after 3 s
        setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        try {
          setLastEvent(JSON.parse(ev.data));
        } catch {}
      };
    };

    connect();

    return () => {
      wsRef.current?.close();
    };
  }, [token]);

  return (
    <WSContext.Provider value={{ connected, lastEvent }}>
      {children}
    </WSContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Nav item definition
// ─────────────────────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/conversations", label: "Conversations", icon: MessageSquare },
  { path: "/skills", label: "Skills", icon: Puzzle },
  { path: "/integrations", label: "Integrations", icon: Plug2 },
  { path: "/logs", label: "Logs", icon: FileText },
  { path: "/settings", label: "Settings", icon: Settings },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar
// ─────────────────────────────────────────────────────────────────────────────

function Sidebar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { logout } = useAuth();
  const { connected } = useWS();

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 z-20 bg-black/50 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`
          fixed inset-y-0 left-0 z-30 flex w-64 flex-col bg-slate-900 text-slate-100
          transition-transform duration-200
          ${open ? "translate-x-0" : "-translate-x-full"}
          lg:static lg:translate-x-0
        `}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-6 py-5 border-b border-slate-700">
          <Bot className="h-7 w-7 text-indigo-400" />
          <span className="text-xl font-bold tracking-tight">myEA</span>
          <button
            className="ml-auto lg:hidden text-slate-400 hover:text-white"
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-4 px-3">
          {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
            <Link
              key={path}
              to={path}
              className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-slate-300
                         hover:bg-slate-800 hover:text-white transition-colors
                         [&.active]:bg-indigo-600 [&.active]:text-white"
              onClick={onClose}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-slate-700 p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs text-slate-400 px-2">
            {connected ? (
              <Wifi className="h-3.5 w-3.5 text-green-400" />
            ) : (
              <WifiOff className="h-3.5 w-3.5 text-red-400" />
            )}
            <span>{connected ? "Connected" : "Reconnecting..."}</span>
          </div>
          <button
            onClick={logout}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium
                       text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell layout (wraps all protected pages)
// ─────────────────────────────────────────────────────────────────────────────

function ShellLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { token } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!token) {
      navigate({ to: "/login" });
    }
  }, [token, navigate]);

  if (!token) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-slate-950">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex items-center gap-4 bg-slate-900 border-b border-slate-700 px-4 py-3 lg:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-slate-400 hover:text-white"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2 text-slate-100">
            <Bot className="h-5 w-5 text-indigo-400" />
            <span className="font-semibold">myEA</span>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto bg-slate-950 text-slate-100">
          <div className="container mx-auto px-6 py-8 max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pages
// ─────────────────────────────────────────────────────────────────────────────

function PageHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-8">
      <h1 className="text-2xl font-bold text-white">{title}</h1>
      {description && <p className="mt-1 text-sm text-slate-400">{description}</p>}
    </div>
  );
}

function StatCard({
  title,
  value,
  description,
  icon: Icon,
}: {
  title: string;
  value: string | number;
  description?: string;
  icon: React.ElementType;
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-slate-400">{title}</span>
        <Icon className="h-4 w-4 text-slate-400" />
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
      {description && <p className="mt-1 text-xs text-slate-500">{description}</p>}
    </div>
  );
}

// Dashboard page
function DashboardPage() {
  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: () => api.get("/api/config").then((r) => r.data),
  });

  const { data: conversations } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => api.get("/api/conversations").then((r) => r.data),
  });

  const { data: skills } = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.get("/api/skills").then((r) => r.data),
  });

  const { connected, lastEvent } = useWS();

  return (
    <div>
      <PageHeading
        title="Dashboard"
        description="Overview of your personal AI assistant"
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
        <StatCard
          title="AI Provider"
          value={config?.ai?.activeProvider ?? "—"}
          description={config?.ai?.model}
          icon={Bot}
        />
        <StatCard
          title="Conversations"
          value={Array.isArray(conversations) ? conversations.length : "—"}
          description="Total stored conversations"
          icon={MessageSquare}
        />
        <StatCard
          title="Skills loaded"
          value={Array.isArray(skills) ? skills.filter((s: any) => s.enabled).length : "—"}
          description="Active skills"
          icon={Puzzle}
        />
        <StatCard
          title="Live connection"
          value={connected ? "Online" : "Offline"}
          description="WebSocket to backend"
          icon={connected ? Wifi : WifiOff}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Enabled platforms */}
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
          <h2 className="text-sm font-semibold text-slate-300 mb-4">Active Platforms</h2>
          <ul className="space-y-2 text-sm">
            {config?.platforms &&
              Object.entries(config.platforms).map(([name, cfg]: [string, any]) => (
                <li key={name} className="flex items-center justify-between">
                  <span className="capitalize text-slate-300">{name}</span>
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      cfg.enabled
                        ? "bg-green-900 text-green-300"
                        : "bg-slate-800 text-slate-500"
                    }`}
                  >
                    {cfg.enabled ? "Enabled" : "Disabled"}
                  </span>
                </li>
              ))}
          </ul>
        </div>

        {/* Recent events */}
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
          <h2 className="text-sm font-semibold text-slate-300 mb-4">Last WebSocket Event</h2>
          {lastEvent ? (
            <pre className="text-xs text-slate-400 overflow-x-auto bg-slate-800 rounded p-3">
              {JSON.stringify(lastEvent, null, 2)}
            </pre>
          ) : (
            <p className="text-sm text-slate-500">Waiting for events…</p>
          )}
        </div>
      </div>
    </div>
  );
}

// Conversations page
function ConversationsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => api.get("/api/conversations").then((r) => r.data),
    refetchInterval: 15_000,
  });

  return (
    <div>
      <PageHeading
        title="Conversations"
        description="All cross-platform conversation history"
      />
      {isLoading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : !data?.length ? (
        <p className="text-slate-400 text-sm">No conversations yet. Send a message from any connected platform.</p>
      ) : (
        <div className="space-y-2">
          {data.map((conv: any) => (
            <div
              key={conv.id}
              className="rounded-lg border border-slate-700 bg-slate-900 p-4 flex items-center justify-between"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium bg-indigo-900 text-indigo-300 px-2 py-0.5 rounded-full capitalize">
                    {conv.platform}
                  </span>
                  <span className="text-sm text-slate-200 font-medium">
                    {conv.platformUserName ?? conv.platformUserId}
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  {conv.messageCount} messages · Last updated{" "}
                  {new Date(conv.updatedAt).toLocaleString()}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Skills page
function SkillsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.get("/api/skills").then((r) => r.data),
  });

  const toggleSkill = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      api.patch(`/api/skills/${name}`, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });

  return (
    <div>
      <PageHeading
        title="Skills"
        description="Built-in and custom hot-loaded skills. Drop a .js or .ts file into volumes/skills/ to add one."
      />
      {isLoading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : !data?.length ? (
        <p className="text-slate-400 text-sm">No skills registered yet.</p>
      ) : (
        <div className="space-y-3">
          {data.map((skill: any) => (
            <div
              key={skill.id}
              className="rounded-lg border border-slate-700 bg-slate-900 p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-white">{skill.name}</span>
                    <span className="text-xs text-slate-500">v{skill.version}</span>
                    {skill.builtIn && (
                      <span className="text-xs bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded">
                        built-in
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mt-1">{skill.description}</p>
                  {Array.isArray(skill.tools) && skill.tools.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {skill.tools.map((tool: any) => (
                        <span
                          key={tool.name}
                          className="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded font-mono"
                        >
                          {tool.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => toggleSkill.mutate({ name: skill.name, enabled: !skill.enabled })}
                  disabled={toggleSkill.isPending}
                  className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors
                    ${skill.enabled ? "bg-indigo-600" : "bg-slate-700"}`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform
                      ${skill.enabled ? "translate-x-4" : "translate-x-1"}`}
                  />
                </button>
              </div>
              {skill.loadError && (
                <p className="text-xs text-red-400 mt-2 bg-red-950 rounded p-2 font-mono">
                  {skill.loadError}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Integrations page
function IntegrationsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["integrations"],
    queryFn: () => api.get("/api/integrations").then((r) => r.data),
    refetchInterval: 30_000,
  });

  const statusColor: Record<string, string> = {
    connected: "bg-green-900 text-green-300",
    disconnected: "bg-slate-800 text-slate-500",
    error: "bg-red-900 text-red-300",
    pending_auth: "bg-yellow-900 text-yellow-300",
  };

  return (
    <div>
      <PageHeading
        title="Integrations"
        description="Third-party service connections. Configure API keys in .env to enable."
      />
      {isLoading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : !data?.length ? (
        <p className="text-slate-400 text-sm">No integrations configured yet.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {data.map((integration: any) => (
            <div
              key={integration.id}
              className="rounded-lg border border-slate-700 bg-slate-900 p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-white">
                  {integration.displayName}
                </span>
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    statusColor[integration.status] ?? statusColor.disconnected
                  }`}
                >
                  {integration.status}
                </span>
              </div>
              {integration.errorMessage && (
                <p className="text-xs text-red-400 mt-1">{integration.errorMessage}</p>
              )}
              {integration.lastCheckedAt && (
                <p className="text-xs text-slate-600 mt-1">
                  Last checked: {new Date(integration.lastCheckedAt).toLocaleString()}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Logs page
function LogsPage() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const { data, isLoading } = useQuery({
    queryKey: ["logs"],
    queryFn: () => api.get("/api/logs?limit=200").then((r) => r.data),
    refetchInterval: autoRefresh ? 5_000 : false,
  });

  const levelColor: Record<string, string> = {
    trace: "text-slate-500",
    debug: "text-slate-400",
    info: "text-blue-400",
    warn: "text-yellow-400",
    error: "text-red-400",
    fatal: "text-red-300 font-bold",
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Logs</h1>
          <p className="mt-1 text-sm text-slate-400">Structured application log archive</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="rounded"
          />
          Auto-refresh
        </label>
      </div>

      {isLoading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : (
        <div className="rounded-lg border border-slate-700 bg-slate-900 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-700 text-slate-400">
                <th className="text-left px-4 py-2 w-40">Time</th>
                <th className="text-left px-4 py-2 w-16">Level</th>
                <th className="text-left px-4 py-2 w-32">Source</th>
                <th className="text-left px-4 py-2">Message</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {Array.isArray(data) &&
                data.map((log: any) => (
                  <tr
                    key={log.id}
                    className="border-b border-slate-800 hover:bg-slate-800/50"
                  >
                    <td className="px-4 py-1.5 text-slate-500 whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleTimeString()}
                    </td>
                    <td className={`px-4 py-1.5 uppercase font-semibold ${levelColor[log.level]}`}>
                      {log.level}
                    </td>
                    <td className="px-4 py-1.5 text-slate-400 truncate max-w-[8rem]">
                      {log.source ?? "—"}
                    </td>
                    <td className="px-4 py-1.5 text-slate-300">{log.message}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {!data?.length && (
            <p className="text-center text-slate-500 text-sm py-8">No logs yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

// Settings page
function SettingsPage() {
  const { data: config, isLoading } = useQuery({
    queryKey: ["config"],
    queryFn: () => api.get("/api/config").then((r) => r.data),
  });

  return (
    <div>
      <PageHeading
        title="Settings"
        description="Runtime configuration. Most settings require restarting the backend container after updating .env."
      />

      {isLoading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : (
        <div className="space-y-6">
          {/* AI Provider */}
          <section className="rounded-xl border border-slate-700 bg-slate-900 p-6">
            <h2 className="text-base font-semibold text-white mb-4">AI Provider</h2>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-400">Active provider</dt>
                <dd className="text-white font-medium capitalize">
                  {config?.ai?.activeProvider ?? "—"}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Model</dt>
                <dd className="text-white font-mono">{config?.ai?.model ?? "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Available providers</dt>
                <dd className="text-white">
                  {config?.ai?.availableProviders?.join(", ") ?? "—"}
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-xs text-slate-500">
              Change <code className="bg-slate-800 px-1 rounded">ACTIVE_AI_PROVIDER</code> and{" "}
              <code className="bg-slate-800 px-1 rounded">AI_MODEL</code> in your .env file, then restart the backend.
            </p>
          </section>

          {/* Platforms */}
          <section className="rounded-xl border border-slate-700 bg-slate-900 p-6">
            <h2 className="text-base font-semibold text-white mb-4">Messaging Platforms</h2>
            <ul className="space-y-2 text-sm">
              {config?.platforms &&
                Object.entries(config.platforms).map(([name, cfg]: [string, any]) => (
                  <li key={name} className="flex items-center justify-between">
                    <span className="capitalize text-slate-300">{name}</span>
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        cfg.enabled
                          ? "bg-green-900 text-green-300"
                          : "bg-slate-800 text-slate-500"
                      }`}
                    >
                      {cfg.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

// Login page
function LoginPage() {
  const { login, token } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (token) navigate({ to: "/" });
  }, [token, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(username, password);
      navigate({ to: "/" });
    } catch {
      setError("Invalid username or password.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-3 mb-8">
          <Bot className="h-10 w-10 text-indigo-400" />
          <span className="text-3xl font-bold text-white">myEA</span>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-slate-700 bg-slate-900 p-8 space-y-5"
        >
          <h1 className="text-lg font-semibold text-white text-center">Sign in</h1>

          {error && (
            <div className="rounded-md bg-red-950 border border-red-800 text-red-300 text-sm px-4 py-2">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="username" className="text-sm font-medium text-slate-300">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
              className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white
                         placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="text-sm font-medium text-slate-300">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white
                         placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50
                       px-4 py-2.5 text-sm font-semibold text-white transition-colors"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Router definition
// ─────────────────────────────────────────────────────────────────────────────

const rootRoute = createRootRoute({
  component: () => (
    <AuthProvider>
      <WSProvider>
        <Outlet />
      </WSProvider>
    </AuthProvider>
  ),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: ShellLayout,
});

const dashboardRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  component: DashboardPage,
});

const conversationsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/conversations",
  component: ConversationsPage,
});

const skillsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/skills",
  component: SkillsPage,
});

const integrationsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/integrations",
  component: IntegrationsPage,
});

const logsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/logs",
  component: LogsPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  shellRoute.addChildren([
    dashboardRoute,
    conversationsRoute,
    skillsRoute,
    integrationsRoute,
    logsRoute,
    settingsRoute,
  ]),
]);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Root export
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  return <RouterProvider router={router} />;
}
