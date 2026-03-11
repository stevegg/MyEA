import React, { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  MessageSquare,
  Search,
  Send,
  Clock,
  ChevronLeft,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getConversations, getConversationMessages } from "@/lib/api";
import type { ConversationSummary, MessageRecord } from "@/lib/api";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORMS = ["All", "Telegram", "Discord", "Slack", "WhatsApp", "Signal"] as const;
type Platform = (typeof PLATFORMS)[number];

const PLATFORM_COLORS: Record<string, string> = {
  telegram: "bg-sky-900 text-sky-300 border-sky-800",
  discord: "bg-indigo-900 text-indigo-300 border-indigo-800",
  slack: "bg-amber-900 text-amber-300 border-amber-800",
  whatsapp: "bg-green-900 text-green-300 border-green-800",
  signal: "bg-blue-900 text-blue-300 border-blue-800",
};

const PLATFORM_DOT_COLORS: Record<string, string> = {
  telegram: "bg-sky-400",
  discord: "bg-indigo-400",
  slack: "bg-amber-400",
  whatsapp: "bg-green-400",
  signal: "bg-blue-400",
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function PlatformBadge({ platform }: { platform: string }) {
  const key = platform.toLowerCase();
  const colorClass = PLATFORM_COLORS[key] ?? "bg-slate-800 text-slate-300 border-slate-700";
  const dotClass = PLATFORM_DOT_COLORS[key] ?? "bg-slate-400";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border capitalize",
        colorClass
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", dotClass)} />
      {platform}
    </span>
  );
}

interface ConversationRowProps {
  conv: ConversationSummary;
  selected: boolean;
  onClick: () => void;
}

function ConversationRow({ conv, selected, onClick }: ConversationRowProps) {
  const preview = (conv as any).lastMessage ?? "";
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-4 py-3 border-b border-slate-800 hover:bg-slate-800/60 transition-colors",
        selected && "bg-slate-800"
      )}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <PlatformBadge platform={conv.platform} />
        <span className="text-xs text-slate-500 shrink-0">
          {relativeTime(conv.updatedAt)}
        </span>
      </div>
      <p className="text-sm font-medium text-slate-200 truncate">
        {conv.platformUserName ?? conv.platformUserId}
      </p>
      {preview && (
        <p className="text-xs text-slate-500 truncate mt-0.5">{preview}</p>
      )}
      <p className="text-xs text-slate-600 mt-0.5">{conv.messageCount} messages</p>
    </button>
  );
}

interface MessageBubbleProps {
  msg: MessageRecord;
}

function MessageBubble({ msg }: MessageBubbleProps) {
  const isUser = msg.role === "user";
  const [showTime, setShowTime] = useState(false);

  return (
    <div
      className={cn(
        "flex flex-col gap-1 mb-3",
        isUser ? "items-end" : "items-start"
      )}
    >
      <div
        onMouseEnter={() => setShowTime(true)}
        onMouseLeave={() => setShowTime(false)}
        className={cn(
          "max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
          isUser
            ? "bg-indigo-600 text-white rounded-br-sm"
            : "bg-slate-800 text-slate-200 rounded-bl-sm border border-slate-700"
        )}
      >
        {msg.content}
      </div>
      <span
        className={cn(
          "text-xs text-slate-600 flex items-center gap-1 transition-opacity duration-150",
          showTime ? "opacity-100" : "opacity-0"
        )}
      >
        <Clock className="h-3 w-3" />
        {new Date(msg.createdAt).toLocaleString()}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversations page
// ─────────────────────────────────────────────────────────────────────────────

export default function Conversations() {
  const [activePlatform, setActivePlatform] = useState<Platform>("All");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: conversations, isLoading } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => getConversations(),
    refetchInterval: 15_000,
  });

  const { data: messages, isLoading: messagesLoading } = useQuery({
    queryKey: ["conversation-messages", selectedId],
    queryFn: () => getConversationMessages(selectedId!),
    enabled: !!selectedId,
  });

  // Auto-scroll to bottom when messages load or update
  useEffect(() => {
    if (messages && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  const filtered = (conversations ?? []).filter((c) => {
    const matchesPlatform =
      activePlatform === "All" ||
      c.platform.toLowerCase() === activePlatform.toLowerCase();
    const matchesSearch =
      search.trim() === "" ||
      (c.platformUserName ?? c.platformUserId ?? "")
        .toLowerCase()
        .includes(search.toLowerCase());
    return matchesPlatform && matchesSearch;
  });

  const selectedConv = conversations?.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Conversations</h1>
        <p className="mt-1 text-sm text-slate-400">
          All cross-platform conversation history
        </p>
      </div>

      <div className="flex gap-6 h-[calc(100vh-220px)]">
        {/* Left panel — list */}
        <div
          className={cn(
            "flex flex-col rounded-xl border border-slate-800 bg-slate-900 overflow-hidden",
            selectedId ? "hidden lg:flex lg:w-80 shrink-0" : "flex-1"
          )}
        >
          {/* Search */}
          <div className="p-3 border-b border-slate-800">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search conversations…"
                className="pl-8 bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-500 h-8 text-sm"
              />
            </div>
          </div>

          {/* Platform filter tabs */}
          <div className="flex overflow-x-auto gap-1 px-3 py-2 border-b border-slate-800 shrink-0">
            {PLATFORMS.map((p) => (
              <button
                key={p}
                onClick={() => setActivePlatform(p)}
                className={cn(
                  "shrink-0 text-xs px-2.5 py-1 rounded-md font-medium transition-colors",
                  activePlatform === p
                    ? "bg-indigo-600 text-white"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                )}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Conversation list */}
          <ScrollArea className="flex-1">
            {isLoading ? (
              <div className="flex items-center justify-center h-32 text-slate-500 text-sm">
                Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-slate-600 px-6 text-center">
                <MessageSquare className="h-10 w-10 mb-3 opacity-20" />
                <p className="text-sm font-medium text-slate-500">No conversations</p>
                <p className="text-xs text-slate-600 mt-1">
                  {search
                    ? "No results for your search."
                    : "Send a message from any connected platform to start."}
                </p>
              </div>
            ) : (
              filtered.map((conv) => (
                <ConversationRow
                  key={conv.id}
                  conv={conv}
                  selected={selectedId === conv.id}
                  onClick={() => setSelectedId(conv.id)}
                />
              ))
            )}
          </ScrollArea>
        </div>

        {/* Right panel — message detail */}
        {selectedId ? (
          <div className="flex flex-1 flex-col rounded-xl border border-slate-800 bg-slate-900 overflow-hidden min-w-0">
            {/* Detail header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="lg:hidden text-slate-400 hover:text-white p-1 h-auto"
                onClick={() => setSelectedId(null)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              {selectedConv && (
                <>
                  <PlatformBadge platform={selectedConv.platform} />
                  <span className="text-sm font-semibold text-slate-200">
                    {selectedConv.platformUserName ?? selectedConv.platformUserId}
                  </span>
                  <span className="ml-auto text-xs text-slate-500">
                    {selectedConv.messageCount} messages
                  </span>
                </>
              )}
            </div>

            {/* Messages */}
            <ScrollArea className="flex-1 px-4 py-4">
              {messagesLoading ? (
                <div className="flex items-center justify-center h-32 text-slate-500 text-sm">
                  Loading messages…
                </div>
              ) : !messages?.length ? (
                <div className="flex flex-col items-center justify-center h-32 text-slate-600">
                  <p className="text-sm">No messages yet.</p>
                </div>
              ) : (
                <>
                  {messages.map((msg) => (
                    <MessageBubble key={msg.id} msg={msg} />
                  ))}
                  <div ref={messagesEndRef} />
                </>
              )}
            </ScrollArea>
          </div>
        ) : (
          <div className="hidden lg:flex flex-1 items-center justify-center rounded-xl border border-slate-800 bg-slate-900/50">
            <div className="text-center text-slate-600">
              <MessageSquare className="h-12 w-12 mx-auto mb-3 opacity-20" />
              <p className="text-sm">Select a conversation to view messages</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
