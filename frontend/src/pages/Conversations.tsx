import React, { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare,
  Search,
  Send,
  Clock,
  ChevronLeft,
  Plus,
  Loader2,
  ImagePlus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  getConversations,
  getConversationMessages,
  sendChat,
} from "@/lib/api";
import type { ConversationSummary, MessageRecord } from "@/lib/api";
import { useWS } from "@/App";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Image attachment helpers
// ─────────────────────────────────────────────────────────────────────────────

interface ImageAttachment {
  /** data: URL for preview */
  dataUrl: string;
  /** base64-encoded content (no prefix) */
  base64: string;
  mimeType: string;
  name: string;
}

function fileToAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // dataUrl = "data:<mime>;base64,<data>"
      const [prefix, base64] = dataUrl.split(",");
      const mimeType = prefix.replace("data:", "").replace(";base64", "");
      resolve({ dataUrl, base64, mimeType, name: file.name });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORMS = ["All", "Web", "Telegram", "Discord", "Slack", "WhatsApp", "Signal"] as const;
type Platform = (typeof PLATFORMS)[number];

const PLATFORM_COLORS: Record<string, string> = {
  web: "bg-violet-900 text-violet-300 border-violet-800",
  telegram: "bg-sky-900 text-sky-300 border-sky-800",
  discord: "bg-indigo-900 text-indigo-300 border-indigo-800",
  slack: "bg-amber-900 text-amber-300 border-amber-800",
  whatsapp: "bg-green-900 text-green-300 border-green-800",
  signal: "bg-blue-900 text-blue-300 border-blue-800",
};

const PLATFORM_DOT_COLORS: Record<string, string> = {
  web: "bg-violet-400",
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
      <p className="text-xs text-slate-600 mt-0.5">{conv.messageCount} messages</p>
    </button>
  );
}

function MessageBubble({ msg }: { msg: MessageRecord }) {
  const isUser = msg.role === "user";
  const isTool = msg.role === "tool";
  const [showTime, setShowTime] = useState(false);

  if (isTool) {
    return (
      <div className="flex justify-center mb-2">
        <span className="text-xs text-slate-600 bg-slate-800/60 border border-slate-700 rounded px-2 py-1 font-mono">
          Tool: {msg.toolName} → {msg.content.slice(0, 120)}{msg.content.length > 120 ? "…" : ""}
        </span>
      </div>
    );
  }

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
          "max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
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
  const qc = useQueryClient();
  const [activePlatform, setActivePlatform] = useState<Platform>("All");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { lastEvent } = useWS();

  const { data: conversations, isLoading } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => getConversations(),
    refetchInterval: 15_000,
  });

  const { data: messages, isLoading: messagesLoading } = useQuery({
    queryKey: ["conversation-messages", selectedId],
    queryFn: () => getConversationMessages(selectedId!),
    enabled: !!selectedId,
    refetchInterval: false,
  });

  // Refetch messages when the server broadcasts a conversation_updated event
  useEffect(() => {
    if (!lastEvent) return;
    const ev = lastEvent as { type?: string; payload?: { conversationId?: string } };
    if (
      ev.type === "conversation_updated" &&
      (ev.payload?.conversationId === selectedId || !selectedId)
    ) {
      qc.invalidateQueries({ queryKey: ["conversation-messages", selectedId] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    }
  }, [lastEvent, selectedId, qc]);

  // Auto-scroll when messages update
  useEffect(() => {
    if (messages) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Send message mutation (web chat)
  const sendMutation = useMutation({
    mutationFn: ({ text, imgs }: { text: string; imgs: ImageAttachment[] }) =>
      sendChat(text, selectedId ?? undefined, imgs.map((i) => ({ base64: i.base64, mimeType: i.mimeType }))),
    onSuccess: (data) => {
      if (data.conversationId && !selectedId) {
        setSelectedId(data.conversationId);
      }
      qc.invalidateQueries({ queryKey: ["conversation-messages", data.conversationId] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      setInput("");
      setImages([]);
      textareaRef.current?.focus();
    },
  });

  const handleSend = () => {
    const text = input.trim();
    if ((!text && images.length === 0) || sendMutation.isPending) return;
    sendMutation.mutate({ text, imgs: images });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-grow textarea height
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  // Handle image files from file input or paste
  const addImageFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;
    const attachments = await Promise.all(imageFiles.map(fileToAttachment));
    setImages((prev) => [...prev, ...attachments].slice(0, 5)); // max 5 images
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(e.clipboardData.items);
      const imageItems = items.filter((it) => it.type.startsWith("image/"));
      if (!imageItems.length) return;
      e.preventDefault();
      const files = imageItems.map((it) => it.getAsFile()).filter(Boolean) as File[];
      addImageFiles(files);
    },
    [addImageFiles]
  );

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    addImageFiles(files);
    e.target.value = "";
  };

  const removeImage = (idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  };

  // Start a new web chat (deselect + clear input)
  const handleNewChat = () => {
    setSelectedId(null);
    setInput("");
    setImages([]);
    setActivePlatform("All");
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

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
  const isWebConv = !selectedId || selectedConv?.platform === "web";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Conversations</h1>
          <p className="mt-1 text-sm text-slate-400">
            Chat with myEA or view conversations from connected platforms
          </p>
        </div>
        <Button
          onClick={handleNewChat}
          size="sm"
          className="bg-indigo-600 hover:bg-indigo-500 text-white gap-2"
        >
          <Plus className="h-4 w-4" />
          New Chat
        </Button>
      </div>

      <div className="flex gap-4 h-[calc(100vh-220px)]">
        {/* Left panel — conversation list */}
        <div
          className={cn(
            "flex flex-col rounded-xl border border-slate-800 bg-slate-900 overflow-hidden",
            selectedId ? "hidden lg:flex lg:w-72 shrink-0" : "flex-1 lg:flex-none lg:w-72"
          )}
        >
          {/* Search */}
          <div className="p-3 border-b border-slate-800">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
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

          {/* List */}
          <ScrollArea className="flex-1">
            {isLoading ? (
              <div className="flex items-center justify-center h-32 text-slate-500 text-sm">
                Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-slate-600 px-6 text-center">
                <MessageSquare className="h-10 w-10 mb-3 opacity-20" />
                <p className="text-sm font-medium text-slate-500">No conversations yet</p>
                <p className="text-xs text-slate-600 mt-1">
                  Click "New Chat" to start a conversation with myEA.
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

        {/* Right panel — chat / message view */}
        <div className={cn(
          "flex flex-1 flex-col rounded-xl border border-slate-800 bg-slate-900 overflow-hidden min-w-0",
          !selectedId && "hidden lg:flex"
        )}>
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 shrink-0">
            {selectedId && (
              <Button
                variant="ghost"
                size="sm"
                className="lg:hidden text-slate-400 hover:text-white p-1 h-auto"
                onClick={() => setSelectedId(null)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            )}
            {selectedConv ? (
              <>
                <PlatformBadge platform={selectedConv.platform} />
                <span className="text-sm font-semibold text-slate-200">
                  {selectedConv.platformUserName ?? selectedConv.platformUserId}
                </span>
                <span className="ml-auto text-xs text-slate-500">
                  {selectedConv.messageCount} messages
                </span>
              </>
            ) : (
              <span className="text-sm font-semibold text-slate-300">New Chat</span>
            )}
          </div>

          {/* Messages */}
          <ScrollArea className="flex-1 px-4 py-4">
            {!selectedId ? (
              <div className="flex flex-col items-center justify-center h-full text-slate-600 py-16">
                <MessageSquare className="h-12 w-12 mb-3 opacity-20" />
                <p className="text-sm font-medium text-slate-500">Start a conversation</p>
                <p className="text-xs text-slate-600 mt-1">Type a message below to chat with myEA.</p>
              </div>
            ) : messagesLoading ? (
              <div className="flex items-center justify-center h-32 text-slate-500 text-sm gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
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

          {/* Input — only shown for web conversations or new chat */}
          {isWebConv && (
            <div className="px-4 py-3 border-t border-slate-800 shrink-0">
              {sendMutation.isError && (
                <p className="text-xs text-red-400 mb-2">
                  Send failed — check logs.
                </p>
              )}

              {/* Image previews */}
              {images.length > 0 && (
                <div className="flex gap-2 mb-2 flex-wrap">
                  {images.map((img, idx) => (
                    <div key={idx} className="relative group">
                      <img
                        src={img.dataUrl}
                        alt={img.name}
                        className="h-16 w-16 object-cover rounded-lg border border-slate-700"
                      />
                      <button
                        onClick={() => removeImage(idx)}
                        className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-slate-600 hover:bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-end gap-2">
                {/* Hidden file input */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={handleFileInputChange}
                />

                {/* Image attach button */}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={sendMutation.isPending || images.length >= 5}
                  className="shrink-0 text-slate-400 hover:text-slate-200 hover:bg-slate-800 h-9 w-9"
                  title="Attach image"
                >
                  <ImagePlus className="h-4 w-4" />
                </Button>

                {/* Auto-growing textarea */}
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={handleTextareaChange}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder="Message myEA… (Enter to send, Shift+Enter for new line)"
                  disabled={sendMutation.isPending}
                  rows={1}
                  className={cn(
                    "flex-1 resize-none bg-slate-800 border border-slate-700 rounded-md",
                    "px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500",
                    "focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500",
                    "min-h-[36px] max-h-[200px] overflow-y-auto leading-relaxed"
                  )}
                />

                <Button
                  onClick={handleSend}
                  disabled={(!input.trim() && images.length === 0) || sendMutation.isPending}
                  size="icon"
                  className="bg-indigo-600 hover:bg-indigo-500 shrink-0 h-9 w-9"
                >
                  {sendMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
