import React, { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Circle,
  ExternalLink,
  Github,
  Key,
  Link2,
  Music,
  Mail,
  Phone,
  Plus,
  QrCode,
  RefreshCw,
  Save,
  Unplug,
  Zap,
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
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
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
  getIntegrations,
  updatePlatform,
  getWhatsAppQR,
  connectIntegration,
  disconnectIntegration,
  getOAuthUrl,
  testPlatformConnection,
} from "@/lib/api";
import { useWSContext } from "@/App";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PlatformCardConfig {
  key: string;
  label: string;
  icon: React.ElementType;
  iconColor: string;
  fields: Array<{
    key: string;
    label: string;
    placeholder: string;
    type?: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORM_CARDS: PlatformCardConfig[] = [
  {
    key: "telegram",
    label: "Telegram",
    icon: Zap,
    iconColor: "text-sky-400",
    fields: [{ key: "botToken", label: "Bot Token", placeholder: "123456:ABC-DEF…", type: "password" }],
  },
  {
    key: "discord",
    label: "Discord",
    icon: Zap,
    iconColor: "text-indigo-400",
    fields: [{ key: "botToken", label: "Bot Token", placeholder: "MTI3…", type: "password" }],
  },
  {
    key: "slack",
    label: "Slack",
    icon: Zap,
    iconColor: "text-amber-400",
    fields: [
      { key: "botToken", label: "Bot Token", placeholder: "xoxb-…", type: "password" },
      { key: "signingSecret", label: "Signing Secret", placeholder: "abc123…", type: "password" },
      { key: "appToken", label: "App Token", placeholder: "xapp-…", type: "password" },
    ],
  },
  {
    key: "whatsapp",
    label: "WhatsApp",
    icon: QrCode,
    iconColor: "text-green-400",
    fields: [],
  },
  {
    key: "signal",
    label: "Signal",
    icon: Phone,
    iconColor: "text-blue-400",
    fields: [{ key: "phoneNumber", label: "Phone Number", placeholder: "+15551234567" }],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <Circle
      className={cn(
        "h-2 w-2 fill-current shrink-0",
        connected ? "text-green-400" : "text-red-500"
      )}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform connector card
// ─────────────────────────────────────────────────────────────────────────────

interface PlatformConnectorCardProps {
  config: PlatformCardConfig;
  platformCfg: { enabled: boolean; configured: boolean } | undefined;
  whatsAppQR?: string | null;
}

function PlatformConnectorCard({
  config,
  platformCfg,
  whatsAppQR,
}: PlatformConnectorCardProps) {
  const queryClient = useQueryClient();
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const isConnected = !!(platformCfg?.enabled && platformCfg?.configured);

  const saveMutation = useMutation({
    mutationFn: () =>
      updatePlatform(config.key, { ...fieldValues, enabled: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
      toast({ title: `${config.label} saved`, variant: "success" as any });
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const disableMutation = useMutation({
    mutationFn: () => updatePlatform(config.key, { enabled: false }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
      toast({ title: `${config.label} disconnected`, variant: "success" as any });
    },
    onError: () => toast({ title: "Disconnect failed", variant: "destructive" }),
  });

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testPlatformConnection(config.key);
      setTestResult(result);
    } catch {
      setTestResult({ ok: false, message: "Connection test failed." });
    } finally {
      setTesting(false);
    }
  };

  const Icon = config.icon;

  return (
    <Card className="border-slate-800 bg-slate-900">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold text-slate-200 flex items-center gap-2">
            <Icon className={cn("h-4 w-4", config.iconColor)} />
            {config.label}
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <StatusDot connected={isConnected} />
            <span className={cn("text-xs font-medium", isConnected ? "text-green-400" : "text-slate-500")}>
              {isConnected ? "Connected" : "Disconnected"}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {/* WhatsApp QR */}
        {config.key === "whatsapp" && (
          <div className="space-y-3">
            {whatsAppQR ? (
              <div className="flex flex-col items-center gap-2 py-2">
                <img
                  src={whatsAppQR}
                  alt="WhatsApp QR code"
                  className="h-40 w-40 rounded-lg border border-slate-700"
                />
                <p className="text-xs text-slate-400 text-center">
                  Scan this QR code in WhatsApp to link your account
                </p>
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                Start the WhatsApp service to generate a QR code.
              </p>
            )}
          </div>
        )}

        {/* Fields */}
        {config.fields.map((field) => (
          <div key={field.key} className="space-y-1.5">
            <Label className="text-xs text-slate-400">{field.label}</Label>
            <Input
              type={field.type ?? "text"}
              placeholder={field.placeholder}
              value={fieldValues[field.key] ?? ""}
              onChange={(e) =>
                setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))
              }
              className="bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-600 h-8 text-sm"
            />
          </div>
        ))}

        {/* Test result */}
        {testResult && (
          <div
            className={cn(
              "text-xs rounded-md px-3 py-2 border",
              testResult.ok
                ? "bg-green-950/40 border-green-900 text-green-300"
                : "bg-red-950/40 border-red-900 text-red-300"
            )}
          >
            {testResult.message}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          {config.fields.length > 0 && (
            <Button
              size="sm"
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white h-7 text-xs"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
            >
              <Save className="h-3 w-3 mr-1.5" />
              Save
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="border-slate-700 text-slate-400 hover:text-white h-7 text-xs"
            onClick={handleTest}
            disabled={testing}
          >
            <RefreshCw className={cn("h-3 w-3 mr-1.5", testing && "animate-spin")} />
            Test
          </Button>
          {isConnected && (
            <Button
              size="sm"
              variant="outline"
              className="border-slate-700 text-red-400 hover:text-red-300 hover:bg-red-950/30 h-7 text-xs"
              onClick={() => disableMutation.mutate()}
              disabled={disableMutation.isPending}
            >
              <Unplug className="h-3 w-3 mr-1.5" />
              Disconnect
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom integration dialog
// ─────────────────────────────────────────────────────────────────────────────

function CustomIntegrationDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: "",
    baseUrl: "",
    apiKey: "",
    headers: "",
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      connectIntegration("custom", {
        name: form.name,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      toast({ title: "Custom integration added", variant: "success" as any });
      onClose();
    },
    onError: () => toast({ title: "Failed to add integration", variant: "destructive" }),
  });

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="bg-slate-900 border-slate-700 text-white">
        <DialogHeader>
          <DialogTitle>Add Custom Integration</DialogTitle>
          <DialogDescription className="text-slate-400">
            Connect any REST API as a custom integration.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 pt-1">
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-400">Name</Label>
            <Input
              placeholder="My API"
              value={form.name}
              onChange={set("name")}
              className="bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-600"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-400">Base URL</Label>
            <Input
              placeholder="https://api.example.com/v1"
              value={form.baseUrl}
              onChange={set("baseUrl")}
              className="bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-600"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-400">API Key</Label>
            <Input
              type="password"
              placeholder="sk-…"
              value={form.apiKey}
              onChange={set("apiKey")}
              className="bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-600"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-400">
              Additional Headers{" "}
              <span className="text-slate-600">(JSON, optional)</span>
            </Label>
            <Input
              placeholder='{"X-Custom": "value"}'
              value={form.headers}
              onChange={set("headers")}
              className="bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-600"
            />
          </div>
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <Button
            variant="outline"
            className="border-slate-700 text-slate-300"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            className="bg-indigo-600 hover:bg-indigo-500 text-white"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !form.name || !form.baseUrl}
          >
            Add Integration
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// External integration card
// ─────────────────────────────────────────────────────────────────────────────

interface ExternalIntegrationCardProps {
  integration: any;
  onOAuth: (name: string) => void;
  onSaveToken: (name: string, token: string) => void;
  onDisconnect: (name: string) => void;
}

function ExternalIntegrationCard({
  integration,
  onOAuth,
  onSaveToken,
  onDisconnect,
}: ExternalIntegrationCardProps) {
  const [token, setToken] = useState("");
  const isConnected = integration.status === "connected";

  const icons: Record<string, React.ElementType> = {
    gmail: Mail,
    github: Github,
    spotify: Music,
  };

  const Icon = icons[integration.name?.toLowerCase()] ?? Link2;

  const isOAuth = ["gmail", "spotify"].includes(integration.name?.toLowerCase());

  return (
    <Card className="border-slate-800 bg-slate-900">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold text-slate-200 flex items-center gap-2">
            <Icon className="h-4 w-4 text-slate-400" />
            {integration.displayName}
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <StatusDot connected={isConnected} />
            <span className={cn("text-xs font-medium", isConnected ? "text-green-400" : "text-slate-500")}>
              {integration.status}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {isConnected && integration.connectedAs && (
          <p className="text-xs text-slate-400">
            Connected as{" "}
            <span className="font-medium text-slate-200">{integration.connectedAs}</span>
          </p>
        )}

        <div className="flex gap-2">
          {isOAuth ? (
            <Button
              size="sm"
              className={cn(
                "flex-1 h-7 text-xs",
                isConnected
                  ? "bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700"
                  : "bg-indigo-600 hover:bg-indigo-500 text-white"
              )}
              onClick={() => onOAuth(integration.name)}
            >
              <ExternalLink className="h-3 w-3 mr-1.5" />
              {isConnected ? "Re-authenticate" : "Connect with OAuth"}
            </Button>
          ) : (
            <>
              <Input
                type="password"
                placeholder="API token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="flex-1 bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-600 h-7 text-xs"
              />
              <Button
                size="sm"
                className="bg-indigo-600 hover:bg-indigo-500 text-white h-7 text-xs"
                onClick={() => { onSaveToken(integration.name, token); setToken(""); }}
                disabled={!token}
              >
                <Save className="h-3 w-3 mr-1" />
                Save
              </Button>
            </>
          )}

          {isConnected && (
            <Button
              size="sm"
              variant="outline"
              className="border-slate-700 text-red-400 hover:text-red-300 hover:bg-red-950/30 h-7 text-xs"
              onClick={() => onDisconnect(integration.name)}
            >
              <Unplug className="h-3 w-3" />
            </Button>
          )}
        </div>

        {integration.errorMessage && (
          <p className="text-xs text-red-400">{integration.errorMessage}</p>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Integrations page
// ─────────────────────────────────────────────────────────────────────────────

export default function Integrations() {
  const queryClient = useQueryClient();
  const { lastEvent } = useWSContext();
  const [whatsAppQR, setWhatsAppQR] = useState<string | null>(null);
  const [customDialogOpen, setCustomDialogOpen] = useState(false);

  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: getConfig,
    refetchInterval: 30_000,
  });

  const { data: integrations, isLoading: integrationsLoading } = useQuery({
    queryKey: ["integrations"],
    queryFn: getIntegrations,
    refetchInterval: 30_000,
  });

  // Listen for WhatsApp QR via WebSocket lastEvent
  useEffect(() => {
    if (!lastEvent) return;
    const event = lastEvent as any;
    if (event?.type === "whatsapp_qr" && event?.payload?.qr) {
      setWhatsAppQR(event.payload.qr as string);
    }
  }, [lastEvent]);

  // Also poll for QR on mount if WhatsApp is configured
  useQuery({
    queryKey: ["whatsapp-qr"],
    queryFn: async () => {
      const data = await getWhatsAppQR();
      if (data.qr) setWhatsAppQR(data.qr);
      return data;
    },
    refetchInterval: 20_000,
  });

  const saveTokenMutation = useMutation({
    mutationFn: ({ name, token }: { name: string; token: string }) =>
      connectIntegration(name, { apiKey: token }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      toast({ title: "Token saved", variant: "success" as any });
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const disconnectMutation = useMutation({
    mutationFn: (name: string) => disconnectIntegration(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      toast({ title: "Disconnected", variant: "success" as any });
    },
    onError: () => toast({ title: "Disconnect failed", variant: "destructive" }),
  });

  const handleOAuth = async (name: string) => {
    try {
      const { url } = await getOAuthUrl(name);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      toast({ title: "Could not get OAuth URL", variant: "destructive" });
    }
  };

  const platforms = config?.platforms ?? {};

  // Separate known external integrations from unknown
  const externalIntegrations = (integrations ?? []).filter((i: any) =>
    ["gmail", "github", "spotify"].includes(i.name?.toLowerCase())
  );
  const customIntegrations = (integrations ?? []).filter(
    (i: any) => !["gmail", "github", "spotify"].includes(i.name?.toLowerCase())
  );

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Integrations</h1>
        <p className="mt-1 text-sm text-slate-400">
          Connect messaging platforms and external services
        </p>
      </div>

      {/* Platform connectors */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-sm font-semibold text-slate-200">AI & Platform Connections</h2>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PLATFORM_CARDS.map((cfg) => (
            <PlatformConnectorCard
              key={cfg.key}
              config={cfg}
              platformCfg={platforms[cfg.key]}
              whatsAppQR={cfg.key === "whatsapp" ? whatsAppQR : undefined}
            />
          ))}
        </div>
      </section>

      <Separator className="bg-slate-800" />

      {/* External integrations */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-200">External Integrations</h2>
          <Button
            size="sm"
            variant="outline"
            className="border-slate-700 bg-slate-800/50 text-slate-300 hover:bg-slate-800 hover:text-white h-8 text-xs"
            onClick={() => setCustomDialogOpen(true)}
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Custom Integration
          </Button>
        </div>

        {integrationsLoading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {/* Known integrations: always show Gmail, GitHub, Spotify */}
            {["gmail", "github", "spotify"].map((name) => {
              const found = externalIntegrations.find(
                (i: any) => i.name?.toLowerCase() === name
              );
              const fallback = {
                name,
                displayName: name.charAt(0).toUpperCase() + name.slice(1),
                status: "disconnected",
              };
              return (
                <ExternalIntegrationCard
                  key={name}
                  integration={found ?? fallback}
                  onOAuth={handleOAuth}
                  onSaveToken={(n, t) => saveTokenMutation.mutate({ name: n, token: t })}
                  onDisconnect={(n) => disconnectMutation.mutate(n)}
                />
              );
            })}

            {/* Custom integrations */}
            {customIntegrations.map((integration: any) => (
              <ExternalIntegrationCard
                key={integration.id ?? integration.name}
                integration={integration}
                onOAuth={handleOAuth}
                onSaveToken={(n, t) => saveTokenMutation.mutate({ name: n, token: t })}
                onDisconnect={(n) => disconnectMutation.mutate(n)}
              />
            ))}
          </div>
        )}
      </section>

      <CustomIntegrationDialog
        open={customDialogOpen}
        onClose={() => setCustomDialogOpen(false)}
      />
    </div>
  );
}
