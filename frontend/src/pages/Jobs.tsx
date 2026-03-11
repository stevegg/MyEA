import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Clock,
  Plus,
  Trash2,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
  ChevronDown,
  ChevronRight,
  CalendarClock,
  Timer,
  AlertCircle,
  CheckCircle2,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/use-toast";
import {
  getJobs,
  createJob,
  updateJob,
  deleteJob,
  type ScheduledJobRecord,
  type CreateJobPayload,
} from "@/lib/api";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORMS = ["telegram", "discord", "slack", "whatsapp", "signal", "web", "internal"] as const;

const CRON_PRESETS = [
  { label: "Every minute",       value: "* * * * *" },
  { label: "Every 5 minutes",    value: "*/5 * * * *" },
  { label: "Every hour",         value: "0 * * * *" },
  { label: "Daily at 9am",       value: "0 9 * * *" },
  { label: "Daily at midnight",  value: "0 0 * * *" },
  { label: "Every Monday 9am",   value: "0 9 * * MON" },
  { label: "Weekly (Sun midnight)", value: "0 0 * * SUN" },
  { label: "Custom…",            value: "" },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const past = diff < 0;
  if (abs < 60_000) return past ? "just now" : "in <1m";
  if (abs < 3_600_000) return `${past ? "" : "in "}${Math.round(abs / 60_000)}m${past ? " ago" : ""}`;
  if (abs < 86_400_000) return `${past ? "" : "in "}${Math.round(abs / 3_600_000)}h${past ? " ago" : ""}`;
  return `${past ? "" : "in "}${Math.round(abs / 86_400_000)}d${past ? " ago" : ""}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Create / Edit dialog
// ─────────────────────────────────────────────────────────────────────────────

interface JobDialogProps {
  open: boolean;
  onClose: () => void;
  editing?: ScheduledJobRecord | null;
}

function JobDialog({ open, onClose, editing }: JobDialogProps) {
  const queryClient = useQueryClient();
  const isEdit = Boolean(editing);

  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [recurring, setRecurring] = useState(editing?.recurring ?? true);
  const [cronPreset, setCronPreset] = useState("");
  const [schedule, setSchedule] = useState(editing?.schedule ?? "");
  const [targetPlatform, setTargetPlatform] = useState(editing?.targetPlatform ?? "");
  const [targetChannelId, setTargetChannelId] = useState(editing?.targetChannelId ?? "");
  const [payloadText, setPayloadText] = useState(
    editing?.payload && Object.keys(editing.payload).length > 0
      ? JSON.stringify(editing.payload, null, 2)
      : ""
  );

  // Reset when dialog opens with new editing target
  React.useEffect(() => {
    if (open) {
      setName(editing?.name ?? "");
      setDescription(editing?.description ?? "");
      setRecurring(editing?.recurring ?? true);
      setSchedule(editing?.schedule ?? "");
      setCronPreset("");
      setTargetPlatform(editing?.targetPlatform ?? "");
      setTargetChannelId(editing?.targetChannelId ?? "");
      setPayloadText(
        editing?.payload && Object.keys(editing.payload).length > 0
          ? JSON.stringify(editing.payload, null, 2)
          : ""
      );
    }
  }, [open, editing]);

  const createMutation = useMutation({
    mutationFn: (payload: CreateJobPayload) => createJob(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast({ title: "Job created", variant: "success" as any });
      onClose();
    },
    onError: (err: any) => {
      toast({
        title: "Failed to create job",
        description: err?.response?.data?.error ?? err.message,
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (payload: Parameters<typeof updateJob>[1]) =>
      updateJob(editing!.id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast({ title: "Job updated", variant: "success" as any });
      onClose();
    },
    onError: (err: any) => {
      toast({
        title: "Failed to update job",
        description: err?.response?.data?.error ?? err.message,
        variant: "destructive",
      });
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const handleSubmit = () => {
    let payload: Record<string, unknown> = {};
    if (payloadText.trim()) {
      try {
        payload = JSON.parse(payloadText);
      } catch {
        toast({ title: "Invalid JSON in payload", variant: "destructive" });
        return;
      }
    }

    const base = {
      description,
      schedule,
      payload,
      targetPlatform: targetPlatform || undefined,
      targetChannelId: targetChannelId || undefined,
    };

    if (isEdit) {
      updateMutation.mutate(base);
    } else {
      createMutation.mutate({ ...base, name, recurring });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="bg-slate-900 border-slate-700 text-white max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Job" : "Create Scheduled Job"}</DialogTitle>
          <DialogDescription className="text-slate-400">
            {isEdit
              ? "Update the job configuration."
              : "Schedule a recurring cron job or a one-shot task."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {/* Name — only for create */}
          {!isEdit && (
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-400">Name <span className="text-red-400">*</span></Label>
              <Input
                placeholder="daily_summary"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-600"
              />
            </div>
          )}

          {/* Description */}
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-400">Description</Label>
            <Input
              placeholder="Send a daily digest to Slack"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-600"
            />
          </div>

          {/* Recurring toggle — only for create */}
          {!isEdit && (
            <div className="flex items-center gap-3">
              <Label className="text-xs text-slate-400">Type</Label>
              <div className="flex rounded-md border border-slate-700 overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => setRecurring(true)}
                  className={cn(
                    "px-3 py-1.5 transition-colors",
                    recurring ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-400 hover:text-white"
                  )}
                >
                  Recurring (cron)
                </button>
                <button
                  type="button"
                  onClick={() => setRecurring(false)}
                  className={cn(
                    "px-3 py-1.5 transition-colors",
                    !recurring ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-400 hover:text-white"
                  )}
                >
                  One-shot (datetime)
                </button>
              </div>
            </div>
          )}

          {/* Schedule */}
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-400">
              Schedule <span className="text-red-400">*</span>
              <span className="ml-2 text-slate-600">
                {recurring ? "(cron expression)" : "(ISO-8601 datetime)"}
              </span>
            </Label>
            {recurring && (
              <Select
                value={cronPreset}
                onValueChange={(v) => {
                  setCronPreset(v);
                  if (v) setSchedule(v);
                }}
              >
                <SelectTrigger className="bg-slate-800 border-slate-700 text-slate-300 h-8 text-xs mb-1.5">
                  <SelectValue placeholder="Pick a preset…" />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700 text-slate-200">
                  {CRON_PRESETS.map((p) => (
                    <SelectItem key={p.label} value={p.value || "custom"} className="text-xs">
                      {p.label}{p.value ? ` — ${p.value}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Input
              placeholder={recurring ? "0 9 * * MON" : "2026-03-15T09:00:00Z"}
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              className="bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-600 font-mono text-sm"
            />
          </div>

          {/* Target platform */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-400">Target platform</Label>
              <Select value={targetPlatform || "none"} onValueChange={(v) => setTargetPlatform(v === "none" ? "" : v)}>
                <SelectTrigger className="bg-slate-800 border-slate-700 text-slate-300 h-8 text-xs">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700 text-slate-200">
                  <SelectItem value="none" className="text-xs">None</SelectItem>
                  {PLATFORMS.map((p) => (
                    <SelectItem key={p} value={p} className="text-xs capitalize">{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-400">Channel / chat ID</Label>
              <Input
                placeholder="123456789"
                value={targetChannelId}
                onChange={(e) => setTargetChannelId(e.target.value)}
                className="bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-600 h-8 text-xs"
              />
            </div>
          </div>

          {/* Payload */}
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-400">Payload <span className="text-slate-600">(JSON, optional)</span></Label>
            <textarea
              rows={3}
              placeholder='{"message": "Good morning!"}'
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-mono
                         text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" className="border-slate-700 text-slate-300" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="bg-indigo-600 hover:bg-indigo-500 text-white"
            onClick={handleSubmit}
            disabled={isPending || !schedule.trim() || (!isEdit && !name.trim())}
          >
            {isPending ? "Saving…" : isEdit ? "Save changes" : "Create job"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Job row
// ─────────────────────────────────────────────────────────────────────────────

interface JobRowProps {
  job: ScheduledJobRecord;
  onEdit: (job: ScheduledJobRecord) => void;
}

function JobRow({ job, onEdit }: JobRowProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const toggleMutation = useMutation({
    mutationFn: () => updateJob(job.id, { enabled: !job.enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    onError: () => toast({ title: "Failed to update job", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteJob(job.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast({ title: "Job deleted", variant: "success" as any });
    },
    onError: () => toast({ title: "Failed to delete job", variant: "destructive" }),
  });

  const hasPayload = job.payload && Object.keys(job.payload).length > 0;

  return (
    <div className={cn(
      "rounded-lg border bg-slate-900 transition-colors",
      job.enabled ? "border-slate-700" : "border-slate-800 opacity-60"
    )}>
      {/* Main row */}
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Expand toggle */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-slate-500 hover:text-slate-300 shrink-0"
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        {/* Status icon */}
        {job.lastError ? (
          <AlertCircle className="h-4 w-4 text-red-400 shrink-0" />
        ) : job.enabled ? (
          <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />
        ) : (
          <Clock className="h-4 w-4 text-slate-600 shrink-0" />
        )}

        {/* Name + description */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-slate-200 font-mono">{job.name}</span>
            <Badge
              variant="outline"
              className={cn(
                "text-xs border-0 px-1.5 py-0",
                job.recurring
                  ? "bg-indigo-900/50 text-indigo-300"
                  : "bg-amber-900/50 text-amber-300"
              )}
            >
              {job.recurring ? "cron" : "one-shot"}
            </Badge>
            {job.targetPlatform && (
              <Badge variant="outline" className="text-xs border-slate-700 text-slate-400 px-1.5 py-0 capitalize">
                {job.targetPlatform}
              </Badge>
            )}
          </div>
          {job.description && (
            <p className="text-xs text-slate-500 mt-0.5 truncate">{job.description}</p>
          )}
        </div>

        {/* Schedule */}
        <div className="hidden sm:flex flex-col items-end text-xs text-slate-500 shrink-0 min-w-[6rem]">
          <span className="font-mono text-slate-400">{job.schedule}</span>
          {job.nextRunAt && (
            <span className="text-slate-600">next: {relativeTime(job.nextRunAt)}</span>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0 ml-2">
          <button
            onClick={() => toggleMutation.mutate()}
            disabled={toggleMutation.isPending}
            title={job.enabled ? "Disable" : "Enable"}
            className="text-slate-500 hover:text-slate-200 transition-colors p-1"
          >
            {job.enabled
              ? <ToggleRight className="h-5 w-5 text-indigo-400" />
              : <ToggleLeft className="h-5 w-5" />
            }
          </button>
          <button
            onClick={() => onEdit(job)}
            title="Edit"
            className="text-slate-500 hover:text-slate-200 transition-colors p-1"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => {
              if (confirm(`Delete job "${job.name}"?`)) deleteMutation.mutate();
            }}
            disabled={deleteMutation.isPending}
            title="Delete"
            className="text-slate-500 hover:text-red-400 transition-colors p-1"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-slate-800 px-4 py-3 text-xs space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <p className="text-slate-600 mb-0.5">Created</p>
              <p className="text-slate-400">{formatDate(job.createdAt)}</p>
            </div>
            <div>
              <p className="text-slate-600 mb-0.5">Last run</p>
              <p className="text-slate-400">{formatDate(job.lastRunAt)}</p>
            </div>
            <div>
              <p className="text-slate-600 mb-0.5">Next run</p>
              <p className="text-slate-400">{formatDate(job.nextRunAt)}</p>
            </div>
            {job.targetChannelId && (
              <div>
                <p className="text-slate-600 mb-0.5">Channel ID</p>
                <p className="text-slate-400 font-mono">{job.targetChannelId}</p>
              </div>
            )}
          </div>

          {job.lastError && (
            <div className="rounded-md bg-red-950/40 border border-red-900 px-3 py-2 text-red-300 font-mono">
              {job.lastError}
            </div>
          )}

          {hasPayload && (
            <div>
              <p className="text-slate-600 mb-1">Payload</p>
              <pre className="rounded-md bg-slate-800 px-3 py-2 text-slate-400 overflow-x-auto">
                {JSON.stringify(job.payload, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Jobs page
// ─────────────────────────────────────────────────────────────────────────────

export default function Jobs() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<ScheduledJobRecord | null>(null);
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled">("all");

  const { data: jobs = [], isLoading, error } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => getJobs(),
    refetchInterval: 30_000,
  });

  const handleEdit = (job: ScheduledJobRecord) => {
    setEditingJob(job);
    setDialogOpen(true);
  };

  const handleCloseDialog = () => {
    setDialogOpen(false);
    setEditingJob(null);
  };

  const filtered = jobs.filter((j) => {
    if (filter === "enabled") return j.enabled;
    if (filter === "disabled") return !j.enabled;
    return true;
  });

  const cronJobs = filtered.filter((j) => j.recurring);
  const oneshotJobs = filtered.filter((j) => !j.recurring);

  const enabledCount = jobs.filter((j) => j.enabled).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Scheduled Jobs</h1>
          <p className="mt-1 text-sm text-slate-400">
            Manage recurring and one-shot tasks
          </p>
        </div>
        <Button
          className="bg-indigo-600 hover:bg-indigo-500 text-white h-9"
          onClick={() => { setEditingJob(null); setDialogOpen(true); }}
        >
          <Plus className="h-4 w-4 mr-1.5" />
          New job
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Total jobs", value: jobs.length, icon: CalendarClock, color: "text-slate-400" },
          { label: "Active", value: enabledCount, icon: CheckCircle2, color: "text-green-400" },
          { label: "Disabled", value: jobs.length - enabledCount, icon: Clock, color: "text-slate-500" },
        ].map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="border-slate-800 bg-slate-900">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-500">{label}</p>
                  <p className="text-2xl font-bold text-white mt-0.5">{value}</p>
                </div>
                <Icon className={cn("h-6 w-6", color)} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 border-b border-slate-800 pb-0">
        {(["all", "enabled", "disabled"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "px-4 py-2 text-sm capitalize transition-colors border-b-2 -mb-px",
              filter === f
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-500 hover:text-slate-300"
            )}
          >
            {f}
          </button>
        ))}
        <button
          onClick={() => queryClient.invalidateQueries({ queryKey: ["jobs"] })}
          className="ml-auto p-2 text-slate-600 hover:text-slate-300 transition-colors"
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="text-center py-16 text-slate-500 text-sm">Loading jobs…</div>
      ) : error ? (
        <div className="text-center py-16 text-red-400 text-sm">Failed to load jobs.</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <Timer className="h-10 w-10 text-slate-700 mx-auto mb-3" />
          <p className="text-slate-500 text-sm">
            {filter === "all" ? "No scheduled jobs yet. Create one to get started." : `No ${filter} jobs.`}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {cronJobs.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                Recurring — {cronJobs.length}
              </h2>
              <div className="space-y-2">
                {cronJobs.map((job) => (
                  <JobRow key={job.id} job={job} onEdit={handleEdit} />
                ))}
              </div>
            </section>
          )}

          {cronJobs.length > 0 && oneshotJobs.length > 0 && (
            <Separator className="bg-slate-800" />
          )}

          {oneshotJobs.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                One-shot — {oneshotJobs.length}
              </h2>
              <div className="space-y-2">
                {oneshotJobs.map((job) => (
                  <JobRow key={job.id} job={job} onEdit={handleEdit} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <JobDialog
        open={dialogOpen}
        onClose={handleCloseDialog}
        editing={editingJob}
      />
    </div>
  );
}
