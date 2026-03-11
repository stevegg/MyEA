import React, { useEffect, useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  MessageSquare,
  Puzzle,
  Plug2,
  Wifi,
  WifiOff,
  RefreshCw,
  Trash2,
  Zap,
  Activity,
  Circle,
  ArrowUpRight,
  User,
  Cpu,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/use-toast";
import { getConfig, getConversations, getSkills, reloadSkills, clearMemory } from "@/lib/api";
import { useWSContext } from "@/App";
import type { WSEvent } from "@/hooks/useWebSocket";

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

interface StatCardProps {
  title: string;
  value: string | number;
  description?: string;
  icon: React.ElementType;
  trend?: "up" | "down" | "neutral";
  colorClass?: string;
}

function StatCard({ title, value, description, icon: Icon, colorClass = "text-slate-400" }: StatCardProps) {
  return (
    <Card className="border-slate-800 bg-slate-900">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">{title}</span>
          <div className={`rounded-md bg-slate-800 p-1.5 ${colorClass}`}>
            <Icon className="h-3.5 w-3.5" />
          </div>
        </div>
        <p className="text-2xl font-bold text-white tabular-nums">{value}</p>
        {description && (
          <p className="mt-1 text-xs text-slate-500 truncate">{description}</p>
        )}
      </CardContent>
    </Card>
  );
}

interface PlatformDotProps {
  name: string;
  enabled: boolean;
  configured: boolean;
}

function PlatformDot({ name, enabled, configured }: PlatformDotProps) {
  const isActive = enabled && configured;
  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-slate-800/50 transition-colors">
      <div className="flex items-center gap-2.5">
        <Circle
          className={`h-2 w-2 fill-current ${
            isActive
              ? "text-green-400"
              : enabled && !configured
              ? "text-amber-400"
              : "text-slate-700"
          }`}
        />
        <span className="text-sm text-slate-300 capitalize font-medium">{name}</span>
      </div>
      <span
        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
          isActive
            ? "bg-green-950 text-green-400"
            : enabled && !configured
            ? "bg-amber-950 text-amber-400"
            : "bg-slate-800 text-slate-600"
        }`}
      >
        {isActive ? "Active" : enabled && !configured ? "Unconfigured" : "Disabled"}
      </span>
    </div>
  );
}

interface LiveMessage {
  id: string;
  type: "received" | "sent";
  platform: string;
  text: string;
  timestamp: Date;
  user?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard page
// ─────────────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const queryClient = useQueryClient();
  const { lastEvent, connected } = useWSContext();
  const [liveMessages, setLiveMessages] = useState<LiveMessage[]>([]);

  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: getConfig,
    refetchInterval: 30_000,
  });

  const { data: conversations } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => getConversations(),
    refetchInterval: 30_000,
  });

  const { data: skills } = useQuery({
    queryKey: ["skills"],
    queryFn: getSkills,
    refetchInterval: 60_000,
  });

  const reloadMutation = useMutation({
    mutationFn: reloadSkills,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast({ title: "Skills reloaded", description: `${data.reloaded} skills loaded.`, variant: "success" });
    },
    onError: () => toast({ title: "Reload failed", variant: "destructive" }),
  });

  const clearMemoryMutation = useMutation({
    mutationFn: clearMemory,
    onSuccess: () => toast({ title: "Memory cleared", description: "All memory entries removed.", variant: "success" }),
    onError: () => toast({ title: "Failed to clear memory", variant: "destructive" }),
  });

  // React to live message events via lastEvent
  useEffect(() => {
    if (!lastEvent) return;
    const event = lastEvent as any;
    if (event?.type === "message_received" && event?.payload) {
      const payload = event.payload;
      setLiveMessages((prev) =>
        [
          {
            id: `${Date.now()}-rx`,
            type: "received" as const,
            platform: payload?.platform ?? "unknown",
            text: payload?.text ?? "",
            timestamp: new Date(),
            user: payload?.userName ?? payload?.userId,
          },
          ...prev,
        ].slice(0, 50)
      );
    } else if (event?.type === "message_sent" && event?.payload) {
      const payload = event.payload;
      setLiveMessages((prev) =>
        [
          {
            id: `${Date.now()}-tx`,
            type: "sent" as const,
            platform: payload?.platform ?? "unknown",
            text: payload?.text ?? "",
            timestamp: new Date(),
          },
          ...prev,
        ].slice(0, 50)
      );
    }
  }, [lastEvent]);

  const totalConversations = Array.isArray(conversations) ? conversations.length : 0;
  const activeSkills = Array.isArray(skills) ? skills.filter((s) => s.enabled).length : 0;
  const totalSkills = Array.isArray(skills) ? skills.length : 0;
  const platforms = config?.platforms ?? {};
  const activePlatformCount = Object.values(platforms).filter(
    (p: any) => p.enabled && p.configured
  ).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="mt-1 text-sm text-slate-400">
            Overview of your personal AI assistant
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border ${
            connected
              ? "border-green-800 bg-green-950 text-green-400"
              : "border-red-900 bg-red-950 text-red-400"
          }`}>
            {connected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
            {connected ? "Live" : "Reconnecting"}
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          title="Conversations"
          value={totalConversations}
          description="All-time stored"
          icon={MessageSquare}
          colorClass="text-indigo-400"
        />
        <StatCard
          title="Active Skills"
          value={`${activeSkills} / ${totalSkills}`}
          description="Enabled / total"
          icon={Puzzle}
          colorClass="text-purple-400"
        />
        <StatCard
          title="Active Platforms"
          value={activePlatformCount}
          description="Connected messaging"
          icon={Plug2}
          colorClass="text-cyan-400"
        />
        <StatCard
          title="AI Provider"
          value={config?.ai?.activeProvider ?? "—"}
          description={config?.ai?.model}
          icon={Cpu}
          colorClass="text-amber-400"
        />
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Platform status */}
        <Card className="border-slate-800 bg-slate-900 lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <Activity className="h-4 w-4 text-slate-400" />
              Platform Status
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 px-3 pb-3">
            {Object.keys(platforms).length === 0 ? (
              <p className="text-sm text-slate-500 px-3 py-4">No platforms configured.</p>
            ) : (
              <div className="space-y-0.5">
                {Object.entries(platforms).map(([name, cfg]: [string, any]) => (
                  <PlatformDot
                    key={name}
                    name={name}
                    enabled={cfg.enabled}
                    configured={cfg.configured ?? false}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Live message feed */}
        <Card className="border-slate-800 bg-slate-900 lg:col-span-2">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-slate-400" />
                Live Message Feed
              </CardTitle>
              {connected && (
                <span className="flex items-center gap-1 text-xs text-green-400">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                  </span>
                  Streaming
                </span>
              )}
            </div>
            <CardDescription className="text-xs text-slate-500">
              Real-time messages via WebSocket
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0 px-4 pb-4">
            <ScrollArea className="h-56">
              {liveMessages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 text-slate-600">
                  <MessageSquare className="h-8 w-8 mb-2 opacity-30" />
                  <p className="text-sm">Waiting for messages…</p>
                </div>
              ) : (
                <div className="space-y-2 pr-2">
                  {liveMessages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`rounded-lg px-3 py-2 text-xs border ${
                        msg.type === "received"
                          ? "bg-slate-800 border-slate-700"
                          : "bg-indigo-950/50 border-indigo-900/50"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`font-medium capitalize ${
                            msg.type === "received" ? "text-slate-300" : "text-indigo-300"
                          }`}
                        >
                          {msg.type === "received" ? (
                            <span className="flex items-center gap-1">
                              <User className="h-3 w-3" />
                              {msg.user ?? "User"} via {msg.platform}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1">
                              <Bot className="h-3 w-3" />
                              Assistant → {msg.platform}
                            </span>
                          )}
                        </span>
                        <span className="ml-auto text-slate-600">
                          {msg.timestamp.toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="text-slate-400 line-clamp-2">{msg.text}</p>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {/* Bottom row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* AI Provider info */}
        <Card className="border-slate-800 bg-slate-900">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <Bot className="h-4 w-4 text-slate-400" />
              AI Provider
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-slate-500">Provider</dt>
                <dd className="font-medium text-white capitalize">
                  {config?.ai?.activeProvider ?? "—"}
                </dd>
              </div>
              <Separator className="bg-slate-800" />
              <div className="flex items-center justify-between">
                <dt className="text-slate-500">Model</dt>
                <dd className="font-mono text-xs text-slate-300 bg-slate-800 px-2 py-0.5 rounded">
                  {config?.ai?.model ?? "—"}
                </dd>
              </div>
              <Separator className="bg-slate-800" />
              <div className="flex items-center justify-between">
                <dt className="text-slate-500">Available</dt>
                <dd className="text-slate-300 text-xs">
                  {config?.ai?.availableProviders?.join(", ") ?? "—"}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        {/* Quick actions */}
        <Card className="border-slate-800 bg-slate-900">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <Zap className="h-4 w-4 text-slate-400" />
              Quick Actions
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-1 gap-2">
              <Button
                variant="outline"
                size="sm"
                className="justify-start border-slate-700 bg-slate-800/50 text-slate-300 hover:bg-slate-800 hover:text-white"
                onClick={() => reloadMutation.mutate()}
                disabled={reloadMutation.isPending}
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${reloadMutation.isPending ? "animate-spin" : ""}`} />
                Reload Skills
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="justify-start border-slate-700 bg-slate-800/50 text-slate-300 hover:bg-slate-800 hover:text-white"
                onClick={() => clearMemoryMutation.mutate()}
                disabled={clearMemoryMutation.isPending}
              >
                <Trash2 className="h-4 w-4 mr-2 text-amber-400" />
                Clear Memory
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="justify-start border-slate-700 bg-slate-800/50 text-slate-300 hover:bg-slate-800 hover:text-white"
                onClick={() => queryClient.invalidateQueries()}
              >
                <Activity className="h-4 w-4 mr-2 text-cyan-400" />
                Refresh All Data
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
