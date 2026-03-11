import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  Filter,
  Radio,
  RadioTower,
  Trash2,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/use-toast";
import { getLogs, clearOldLogs } from "@/lib/api";
import { useWS } from "@/App";
import type { LogEntry } from "@/lib/api";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

type LogLevel = "ALL" | "DEBUG" | "INFO" | "WARN" | "ERROR";

const LOG_LEVELS: LogLevel[] = ["ALL", "DEBUG", "INFO", "WARN", "ERROR"];

const LEVEL_BADGE: Record<string, string> = {
  debug: "bg-slate-800 text-slate-400 border-slate-700",
  info: "bg-blue-950 text-blue-300 border-blue-900",
  warn: "bg-amber-950 text-amber-300 border-amber-900",
  error: "bg-red-950 text-red-300 border-red-900",
  fatal: "bg-red-900 text-red-200 border-red-800",
  trace: "bg-slate-900 text-slate-500 border-slate-800",
};

const LEVEL_DOT: Record<string, string> = {
  debug: "bg-slate-500",
  info: "bg-blue-400",
  warn: "bg-amber-400",
  error: "bg-red-400",
  fatal: "bg-red-300",
  trace: "bg-slate-600",
};

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function LevelBadge({ level }: { level: string }) {
  const lc = level.toLowerCase();
  const cls = LEVEL_BADGE[lc] ?? LEVEL_BADGE.debug;
  const dot = LEVEL_DOT[lc] ?? "bg-slate-500";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border tracking-wide",
        cls
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      {level}
    </span>
  );
}

interface LogRowProps {
  log: LogEntry;
}

function LogRow({ log }: LogRowProps) {
  const [expanded, setExpanded] = useState(false);
  const hasContext =
    log.context && typeof log.context === "object" && Object.keys(log.context).length > 0;

  return (
    <>
      <tr
        className={cn(
          "border-b border-slate-800 hover:bg-slate-800/40 transition-colors",
          hasContext && "cursor-pointer"
        )}
        onClick={() => hasContext && setExpanded((v) => !v)}
      >
        <td className="px-3 py-2 text-slate-500 whitespace-nowrap text-xs font-mono">
          {new Date(log.createdAt).toLocaleString()}
        </td>
        <td className="px-3 py-2 whitespace-nowrap">
          <LevelBadge level={log.level} />
        </td>
        <td className="px-3 py-2 text-slate-400 text-xs max-w-[8rem] truncate">
          {log.platform ?? log.source ?? "—"}
        </td>
        <td className="px-3 py-2 text-slate-300 text-xs">
          <div className="flex items-center gap-2">
            {hasContext &&
              (expanded ? (
                <ChevronDown className="h-3 w-3 text-slate-500 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 text-slate-500 shrink-0" />
              ))}
            <span className="line-clamp-2">{log.message}</span>
          </div>
        </td>
      </tr>
      {expanded && hasContext && (
        <tr className="border-b border-slate-800 bg-slate-900">
          <td colSpan={4} className="px-3 py-2">
            <pre className="text-xs text-slate-400 bg-slate-800/70 rounded-md p-3 overflow-x-auto">
              {JSON.stringify(log.context, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Virtualized row list (simple windowed approach)
// ─────────────────────────────────────────────────────────────────────────────

const ROW_HEIGHT = 40; // px estimate per row
const OVERSCAN = 10;

interface VirtualTableBodyProps {
  logs: LogEntry[];
  containerHeight: number;
  scrollTop: number;
}

function VirtualTableBody({ logs, containerHeight, scrollTop }: VirtualTableBodyProps) {
  const totalHeight = logs.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    logs.length - 1,
    Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN
  );

  const visibleLogs = logs.slice(startIndex, endIndex + 1);
  const paddingTop = startIndex * ROW_HEIGHT;
  const paddingBottom = Math.max(0, (logs.length - endIndex - 1) * ROW_HEIGHT);

  return (
    <tbody className="font-mono">
      {paddingTop > 0 && (
        <tr style={{ height: paddingTop }}>
          <td colSpan={4} />
        </tr>
      )}
      {visibleLogs.map((log) => (
        <LogRow key={log.id} log={log} />
      ))}
      {paddingBottom > 0 && (
        <tr style={{ height: paddingBottom }}>
          <td colSpan={4} />
        </tr>
      )}
    </tbody>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Logs page
// ─────────────────────────────────────────────────────────────────────────────

export default function Logs() {
  const queryClient = useQueryClient();
  const { lastEvent } = useWS();

  const [liveMode, setLiveMode] = useState(false);
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<LogLevel>("ALL");
  const [platformFilter, setPlatformFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [clearDialogOpen, setClearDialogOpen] = useState(false);

  // Scroll tracking for virtual list
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(500);

  const { data: fetchedLogs, isLoading } = useQuery({
    queryKey: ["logs", levelFilter, platformFilter, fromDate, toDate],
    queryFn: () =>
      getLogs({
        limit: 500,
        level: levelFilter === "ALL" ? undefined : levelFilter.toLowerCase(),
        platform: platformFilter === "all" ? undefined : platformFilter,
        from: fromDate || undefined,
        to: toDate || undefined,
      }),
    refetchInterval: liveMode ? false : 3_000,
  });

  const clearMutation = useMutation({
    mutationFn: () => clearOldLogs(30),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["logs"] });
      setLiveLogs([]);
      toast({
        title: "Logs cleared",
        description: `${data.deleted} entries removed.`,
        variant: "success" as any,
      });
      setClearDialogOpen(false);
    },
    onError: () => toast({ title: "Clear failed", variant: "destructive" }),
  });

  // WebSocket live mode — react to lastEvent from context
  useEffect(() => {
    if (!liveMode || !lastEvent) return;
    const event = lastEvent as any;
    if (event?.type === "log_entry" && event?.payload) {
      setLiveLogs((prev) => [event.payload as LogEntry, ...prev].slice(0, 1000));
    }
  }, [liveMode, lastEvent]);

  // Track scroll + container height
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerHeight(el.clientHeight));
    ro.observe(el);
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    setContainerHeight(el.clientHeight);
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  const displayLogs = useMemo(() => {
    if (liveMode && liveLogs.length > 0) return liveLogs;
    return fetchedLogs ?? [];
  }, [liveMode, liveLogs, fetchedLogs]);

  // Unique platforms for filter
  const platforms = useMemo(() => {
    const all = new Set<string>();
    (fetchedLogs ?? []).forEach((l) => {
      if (l.platform) all.add(l.platform);
    });
    return Array.from(all).sort();
  }, [fetchedLogs]);

  const handleExport = useCallback(() => {
    const blob = new Blob([JSON.stringify(displayLogs, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `myea-logs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [displayLogs]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Logs</h1>
          <p className="mt-1 text-sm text-slate-400">Structured application log archive</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Live mode toggle */}
          <button
            onClick={() => {
              setLiveMode((v) => !v);
              if (!liveMode) setLiveLogs([]);
            }}
            className={cn(
              "flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border font-medium transition-colors",
              liveMode
                ? "border-green-700 bg-green-950 text-green-300"
                : "border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-200"
            )}
          >
            {liveMode ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
                Live
              </>
            ) : (
              <>
                <RadioTower className="h-3.5 w-3.5" />
                Live
              </>
            )}
          </button>

          <Button
            variant="outline"
            size="sm"
            className="border-slate-700 bg-slate-800/50 text-slate-300 hover:bg-slate-800 hover:text-white h-8"
            onClick={handleExport}
            disabled={displayLogs.length === 0}
          >
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export JSON
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="border-slate-700 bg-slate-800/50 text-red-400 hover:bg-red-950/30 hover:text-red-300 h-8"
            onClick={() => setClearDialogOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            Clear Old Logs
          </Button>
        </div>
      </div>

      {/* Filter bar */}
      <Card className="border-slate-800 bg-slate-900">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-500 flex items-center gap-1">
                <Filter className="h-3 w-3" /> Level
              </Label>
              <Select
                value={levelFilter}
                onValueChange={(v) => setLevelFilter(v as LogLevel)}
              >
                <SelectTrigger className="w-28 bg-slate-800 border-slate-700 text-slate-200 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700 text-slate-200">
                  {LOG_LEVELS.map((l) => (
                    <SelectItem key={l} value={l} className="text-xs hover:bg-slate-700">
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-slate-500">Platform</Label>
              <Select
                value={platformFilter}
                onValueChange={setPlatformFilter}
              >
                <SelectTrigger className="w-32 bg-slate-800 border-slate-700 text-slate-200 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700 text-slate-200">
                  <SelectItem value="all" className="text-xs hover:bg-slate-700">
                    All platforms
                  </SelectItem>
                  {platforms.map((p) => (
                    <SelectItem key={p} value={p} className="text-xs hover:bg-slate-700 capitalize">
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-slate-500">From</Label>
              <Input
                type="datetime-local"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="bg-slate-800 border-slate-700 text-slate-200 h-8 text-xs w-48"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-slate-500">To</Label>
              <Input
                type="datetime-local"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="bg-slate-800 border-slate-700 text-slate-200 h-8 text-xs w-48"
              />
            </div>

            {(levelFilter !== "ALL" || platformFilter !== "all" || fromDate || toDate) && (
              <Button
                variant="ghost"
                size="sm"
                className="text-slate-400 hover:text-white h-8 text-xs self-end"
                onClick={() => {
                  setLevelFilter("ALL");
                  setPlatformFilter("all");
                  setFromDate("");
                  setToDate("");
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Count */}
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          {isLoading ? "Loading…" : `${displayLogs.length.toLocaleString()} entries`}
          {liveMode && (
            <span className="ml-2 text-green-400 font-medium">— Live</span>
          )}
        </span>
      </div>

      {/* Virtualized log table */}
      <div
        ref={scrollRef}
        className="rounded-xl border border-slate-800 bg-slate-900 overflow-auto"
        style={{ height: "calc(100vh - 430px)", minHeight: 300 }}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        {isLoading ? (
          <div className="flex items-center justify-center h-32 text-slate-500 text-sm">
            Loading…
          </div>
        ) : displayLogs.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-slate-500 text-sm">
            No log entries.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-slate-900 border-b border-slate-800">
              <tr>
                <th className="text-left px-3 py-2 text-slate-500 font-medium w-44">
                  Timestamp
                </th>
                <th className="text-left px-3 py-2 text-slate-500 font-medium w-24">
                  Level
                </th>
                <th className="text-left px-3 py-2 text-slate-500 font-medium w-28">
                  Platform
                </th>
                <th className="text-left px-3 py-2 text-slate-500 font-medium">
                  Message
                </th>
              </tr>
            </thead>
            <VirtualTableBody
              logs={displayLogs}
              containerHeight={containerHeight}
              scrollTop={scrollTop}
            />
          </table>
        )}
      </div>

      {/* Clear logs confirmation */}
      <Dialog open={clearDialogOpen} onOpenChange={(o) => !o && setClearDialogOpen(false)}>
        <DialogContent className="bg-slate-900 border-slate-700 text-white">
          <DialogHeader>
            <DialogTitle>Clear old logs</DialogTitle>
            <DialogDescription className="text-slate-400">
              This will permanently delete all log entries older than 30 days. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-3 pt-2">
            <Button
              variant="outline"
              className="border-slate-700 text-slate-300"
              onClick={() => setClearDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => clearMutation.mutate()}
              disabled={clearMutation.isPending}
            >
              {clearMutation.isPending ? "Clearing…" : "Clear Logs"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
