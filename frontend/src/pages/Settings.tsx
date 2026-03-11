import React, { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  CheckCircle2,
  Globe,
  KeyRound,
  Loader2,
  MessageSquare,
  Save,
  ShieldAlert,
  Trash2,
  User,
  XCircle,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import {
  getConfig,
  getMe,
  updateSettings,
  updateUser,
  testAIConnection,
  clearMemory,
  clearAllConversations,
} from "@/lib/api";
import type { ApiConfigResponse } from "@/lib/api";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDERS = [
  { value: "anthropic", label: "Claude (Anthropic)" },
  { value: "openai", label: "OpenAI" },
  { value: "ollama", label: "Ollama (local)" },
] as const;

const MODELS_BY_PROVIDER: Record<string, string[]> = {
  anthropic: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-3-5"],
  openai: ["gpt-4o", "gpt-4o-mini", "o1-preview", "o1-mini"],
  ollama: ["llama3.2", "mistral", "gemma2", "codellama", "phi3"],
};

const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Australia/Sydney",
];

const PLATFORM_OPTIONS = ["telegram", "discord", "slack", "whatsapp", "signal"];

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function SectionCard({
  title,
  description,
  icon: Icon,
  children,
  danger,
}: {
  title: string;
  description?: string;
  icon: React.ElementType;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <Card
      className={cn(
        "bg-slate-900",
        danger ? "border-red-900" : "border-slate-800"
      )}
    >
      <CardHeader className="pb-4">
        <CardTitle
          className={cn(
            "text-base font-semibold flex items-center gap-2",
            danger ? "text-red-300" : "text-slate-200"
          )}
        >
          <Icon className={cn("h-4 w-4", danger ? "text-red-400" : "text-slate-400")} />
          {title}
        </CardTitle>
        {description && (
          <CardDescription className="text-xs text-slate-500">{description}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="pt-0 space-y-4">{children}</CardContent>
    </Card>
  );
}

function FormRow({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1.5">{children}</div>;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <Label className="text-xs font-medium text-slate-400">{children}</Label>;
}

function FieldInput({
  ...props
}: React.ComponentProps<typeof Input>) {
  return (
    <Input
      {...props}
      className={cn(
        "bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-600 h-9 text-sm",
        props.className
      )}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Provider section
// ─────────────────────────────────────────────────────────────────────────────

function AIProviderSection({ config }: { config: ApiConfigResponse }) {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState(config.ai.activeProvider ?? "anthropic");
  const [model, setModel] = useState(config.ai.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
    latencyMs?: number;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const models = MODELS_BY_PROVIDER[provider] ?? [];

  const saveMutation = useMutation({
    mutationFn: () =>
      updateSettings({
        ai: {
          activeProvider: provider,
          model,
          apiKey: apiKey || undefined,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
      toast({ title: "AI provider saved", variant: "success" as any });
      setApiKey("");
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testAIConnection(provider, model, apiKey || undefined);
      setTestResult(result);
    } catch {
      setTestResult({ ok: false, message: "Connection test failed." });
    } finally {
      setTesting(false);
    }
  };

  return (
    <SectionCard title="AI Provider" icon={Bot} description="Configure the LLM used for all responses.">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormRow>
          <FieldLabel>Provider</FieldLabel>
          <Select
            value={provider}
            onValueChange={(v) => {
              setProvider(v);
              setModel(MODELS_BY_PROVIDER[v]?.[0] ?? "");
            }}
          >
            <SelectTrigger className="bg-slate-800 border-slate-700 text-slate-200 h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700 text-slate-200">
              {PROVIDERS.map((p) => (
                <SelectItem key={p.value} value={p.value} className="text-sm hover:bg-slate-700">
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRow>

        <FormRow>
          <FieldLabel>Model</FieldLabel>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="bg-slate-800 border-slate-700 text-slate-200 h-9 text-sm">
              <SelectValue placeholder="Select model" />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700 text-slate-200">
              {models.map((m) => (
                <SelectItem key={m} value={m} className="text-sm font-mono hover:bg-slate-700">
                  {m}
                </SelectItem>
              ))}
              {/* Also allow typing custom model name for Ollama */}
              {provider === "ollama" && model && !models.includes(model) && (
                <SelectItem value={model} className="text-sm font-mono hover:bg-slate-700">
                  {model} (custom)
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </FormRow>
      </div>

      <FormRow>
        <FieldLabel>API Key {provider === "ollama" && <span className="text-slate-600">(not required for local)</span>}</FieldLabel>
        <FieldInput
          type="password"
          placeholder="sk-… (leave blank to keep existing)"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          disabled={provider === "ollama"}
        />
      </FormRow>

      {testResult && (
        <div
          className={cn(
            "flex items-center gap-2 text-sm rounded-lg px-3 py-2.5 border",
            testResult.ok
              ? "bg-green-950/40 border-green-900 text-green-300"
              : "bg-red-950/40 border-red-900 text-red-300"
          )}
        >
          {testResult.ok ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <XCircle className="h-4 w-4 shrink-0" />
          )}
          <span>{testResult.message}</span>
          {testResult.latencyMs != null && (
            <span className="ml-auto text-xs opacity-70">{testResult.latencyMs}ms</span>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Button
          size="sm"
          className="bg-indigo-600 hover:bg-indigo-500 text-white"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || !provider || !model}
        >
          {saveMutation.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Save className="h-4 w-4 mr-2" />
          )}
          Save
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-slate-700 text-slate-300 hover:bg-slate-800"
          onClick={handleTest}
          disabled={testing || !provider || !model}
        >
          {testing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          Test Connection
        </Button>
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// System section
// ─────────────────────────────────────────────────────────────────────────────

function SystemSection({ config }: { config: ApiConfigResponse }) {
  const queryClient = useQueryClient();
  const [timezone, setTimezone] = useState(config.system.timezone ?? "UTC");
  const [defaultPlatform, setDefaultPlatform] = useState(
    config.system.defaultPlatform ?? "telegram"
  );
  const [maxHistory, setMaxHistory] = useState("50");
  const [execTimeout, setExecTimeout] = useState("30");

  const saveMutation = useMutation({
    mutationFn: () =>
      updateSettings({
        system: {
          timezone,
          defaultPlatform,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
      toast({ title: "System settings saved", variant: "success" as any });
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  return (
    <SectionCard title="System" icon={Globe} description="Runtime behaviour configuration.">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormRow>
          <FieldLabel>Timezone</FieldLabel>
          <Select value={timezone} onValueChange={setTimezone}>
            <SelectTrigger className="bg-slate-800 border-slate-700 text-slate-200 h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700 text-slate-200">
              {TIMEZONES.map((tz) => (
                <SelectItem key={tz} value={tz} className="text-sm hover:bg-slate-700">
                  {tz}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRow>

        <FormRow>
          <FieldLabel>Default Platform for Proactive Messages</FieldLabel>
          <Select value={defaultPlatform} onValueChange={setDefaultPlatform}>
            <SelectTrigger className="bg-slate-800 border-slate-700 text-slate-200 h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700 text-slate-200">
              {PLATFORM_OPTIONS.map((p) => (
                <SelectItem key={p} value={p} className="text-sm capitalize hover:bg-slate-700">
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRow>

        <FormRow>
          <FieldLabel>Max Conversation History Length</FieldLabel>
          <FieldInput
            type="number"
            min={1}
            max={500}
            value={maxHistory}
            onChange={(e) => setMaxHistory(e.target.value)}
            placeholder="50"
          />
        </FormRow>

        <FormRow>
          <FieldLabel>Code Execution Timeout (seconds)</FieldLabel>
          <FieldInput
            type="number"
            min={1}
            max={300}
            value={execTimeout}
            onChange={(e) => setExecTimeout(e.target.value)}
            placeholder="30"
          />
        </FormRow>
      </div>

      <Button
        size="sm"
        className="bg-indigo-600 hover:bg-indigo-500 text-white"
        onClick={() => saveMutation.mutate()}
        disabled={saveMutation.isPending}
      >
        {saveMutation.isPending ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Save className="h-4 w-4 mr-2" />
        )}
        Save System Settings
      </Button>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Account section
// ─────────────────────────────────────────────────────────────────────────────

function AccountSection() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: getMe });

  const [username, setUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    if (me) setUsername(me.username);
  }, [me]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (newPassword && newPassword !== confirmPassword) {
        throw new Error("Passwords do not match.");
      }
      return updateUser({
        username: username || undefined,
        currentPassword: currentPassword || undefined,
        newPassword: newPassword || undefined,
      });
    },
    onSuccess: () => {
      toast({ title: "Account updated", variant: "success" as any });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
    onError: (err: any) =>
      toast({
        title: "Update failed",
        description: err.message ?? "Unknown error.",
        variant: "destructive",
      }),
  });

  const passwordMismatch = !!newPassword && newPassword !== confirmPassword;

  return (
    <SectionCard title="Account" icon={User} description="Update your login credentials.">
      <FormRow>
        <FieldLabel>Username</FieldLabel>
        <FieldInput
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username"
          autoComplete="username"
        />
      </FormRow>

      <Separator className="bg-slate-800" />
      <p className="text-xs text-slate-500">Leave password fields blank to keep your current password.</p>

      <FormRow>
        <FieldLabel>Current Password</FieldLabel>
        <FieldInput
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          placeholder="••••••••"
          autoComplete="current-password"
        />
      </FormRow>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormRow>
          <FieldLabel>New Password</FieldLabel>
          <FieldInput
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="new-password"
          />
        </FormRow>
        <FormRow>
          <FieldLabel>Confirm New Password</FieldLabel>
          <FieldInput
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="new-password"
            className={cn(
              passwordMismatch && "border-red-700 focus-visible:ring-red-500"
            )}
          />
          {passwordMismatch && (
            <p className="text-xs text-red-400 mt-1">Passwords do not match.</p>
          )}
        </FormRow>
      </div>

      <Button
        size="sm"
        className="bg-indigo-600 hover:bg-indigo-500 text-white"
        onClick={() => saveMutation.mutate()}
        disabled={saveMutation.isPending || passwordMismatch}
      >
        {saveMutation.isPending ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Save className="h-4 w-4 mr-2" />
        )}
        Update Account
      </Button>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Danger Zone section
// ─────────────────────────────────────────────────────────────────────────────

function DangerZoneSection() {
  const queryClient = useQueryClient();
  const [confirmAction, setConfirmAction] = useState<
    "memory" | "conversations" | null
  >(null);

  const clearMemoryMutation = useMutation({
    mutationFn: clearMemory,
    onSuccess: () => {
      queryClient.invalidateQueries();
      toast({ title: "All memory cleared", variant: "success" as any });
      setConfirmAction(null);
    },
    onError: () => toast({ title: "Failed to clear memory", variant: "destructive" }),
  });

  const clearConvsMutation = useMutation({
    mutationFn: clearAllConversations,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      toast({ title: "All conversations reset", variant: "success" as any });
      setConfirmAction(null);
    },
    onError: () =>
      toast({ title: "Failed to reset conversations", variant: "destructive" }),
  });

  const ACTIONS = {
    memory: {
      title: "Clear All Memory",
      description:
        "This will permanently delete all stored memory entries. The assistant will lose context about past interactions.",
      confirm: "Clear Memory",
      mutation: clearMemoryMutation,
    },
    conversations: {
      title: "Reset All Conversations",
      description:
        "This will permanently delete all conversation history across all platforms. This cannot be undone.",
      confirm: "Reset Conversations",
      mutation: clearConvsMutation,
    },
  } as const;

  const action = confirmAction ? ACTIONS[confirmAction] : null;

  return (
    <>
      <SectionCard
        title="Danger Zone"
        icon={ShieldAlert}
        description="Irreversible destructive actions. Use with care."
        danger
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-4 flex flex-col gap-3">
            <div>
              <p className="text-sm font-medium text-slate-200">Clear All Memory</p>
              <p className="text-xs text-slate-500 mt-1">
                Removes all stored memory entries from the assistant's context.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="border-red-900 text-red-400 hover:bg-red-950/40 hover:text-red-300 self-start"
              onClick={() => setConfirmAction("memory")}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              Clear Memory
            </Button>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-4 flex flex-col gap-3">
            <div>
              <p className="text-sm font-medium text-slate-200">Reset All Conversations</p>
              <p className="text-xs text-slate-500 mt-1">
                Permanently deletes all conversation history on every platform.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="border-red-900 text-red-400 hover:bg-red-950/40 hover:text-red-300 self-start"
              onClick={() => setConfirmAction("conversations")}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              Reset Conversations
            </Button>
          </div>
        </div>
      </SectionCard>

      {/* Confirm dialog */}
      <Dialog open={!!confirmAction} onOpenChange={(o) => !o && setConfirmAction(null)}>
        <DialogContent className="bg-slate-900 border-slate-700 text-white">
          <DialogHeader>
            <DialogTitle className="text-red-300">{action?.title}</DialogTitle>
            <DialogDescription className="text-slate-400">
              {action?.description}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-3 pt-2">
            <Button
              variant="outline"
              className="border-slate-700 text-slate-300"
              onClick={() => setConfirmAction(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => action?.mutation.mutate()}
              disabled={action?.mutation.isPending}
            >
              {action?.mutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-2" />
              )}
              {action?.confirm}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings page
// ─────────────────────────────────────────────────────────────────────────────

export default function Settings() {
  const { data: config, isLoading } = useQuery({
    queryKey: ["config"],
    queryFn: getConfig,
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="mt-1 text-sm text-slate-400">
          Runtime configuration for your personal AI assistant
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : config ? (
        <>
          <AIProviderSection config={config} />
          <SystemSection config={config} />
          <AccountSection />
          <DangerZoneSection />
        </>
      ) : (
        <p className="text-slate-400 text-sm">Failed to load configuration.</p>
      )}
    </div>
  );
}
