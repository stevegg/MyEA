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
  CalendarClock,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// API client
// ─────────────────────────────────────────────────────────────────────────────

// Empty baseURL so all requests go to the same origin.
// In dev, Vite's proxy routes /api and /auth to the backend.
// In prod, nginx serves the SPA and reverse-proxies /api and /auth.
const api = axios.create({ baseURL: "" });

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

// Derive WS URL from current page origin so it works behind any proxy.
// In dev, Vite's proxy forwards /ws to the backend WS server.
// In prod, nginx reverse-proxies /ws.
const WS_URL = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;

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
  { path: "/jobs", label: "Jobs", icon: CalendarClock },
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
// Page imports
// ─────────────────────────────────────────────────────────────────────────────

import ConversationsPage from "./pages/Conversations";
import IntegrationsFullPage from "./pages/Integrations";
import LogsFullPage from "./pages/Logs";
import SkillsFullPage from "./pages/Skills";
import DashboardFullPage from "./pages/Dashboard";
import SettingsFullPage from "./pages/Settings";
import JobsFullPage from "./pages/Jobs";

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
  component: DashboardFullPage,
});

const conversationsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/conversations",
  component: ConversationsPage,
});

const skillsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/skills",
  component: SkillsFullPage,
});

const integrationsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/integrations",
  component: IntegrationsFullPage,
});

const logsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/logs",
  component: LogsFullPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings",
  component: SettingsFullPage,
});

const jobsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/jobs",
  component: JobsFullPage,
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
    jobsRoute,
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
