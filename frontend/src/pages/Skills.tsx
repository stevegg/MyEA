import React, { useCallback, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Lock,
  Trash2,
  RefreshCw,
  UploadCloud,
  Puzzle,
  AlertCircle,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import { getSkills, toggleSkill, reloadSkills, uploadSkill, deleteSkill } from "@/lib/api";
import type { SkillRegistryEntry } from "@/lib/api";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

interface SkillCardProps {
  skill: SkillRegistryEntry;
  onToggle: (name: string, enabled: boolean) => void;
  onDelete: (name: string) => void;
  isToggling: boolean;
  isDeleting: boolean;
}

function SkillCard({ skill, onToggle, onDelete, isToggling, isDeleting }: SkillCardProps) {
  const hasError = !!(skill as any).loadError;

  return (
    <div
      className={cn(
        "rounded-xl border bg-slate-900 p-5 flex flex-col gap-3 transition-colors",
        hasError ? "border-red-800" : "border-slate-800"
      )}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-sm font-semibold text-white">{skill.name}</span>
            <span className="text-xs text-slate-500 font-mono">v{skill.version}</span>
            {skill.builtIn && (
              <Badge
                variant="secondary"
                className="text-[10px] px-1.5 py-0 bg-slate-700 text-slate-300 border-slate-600 flex items-center gap-1"
              >
                <Lock className="h-2.5 w-2.5" />
                Built-in
              </Badge>
            )}
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">{skill.description}</p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Switch
            checked={skill.enabled}
            onCheckedChange={(val) => onToggle(skill.name, val)}
            disabled={isToggling}
            className="data-[state=checked]:bg-indigo-600"
            aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
          />
          {!skill.builtIn && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-slate-500 hover:text-red-400 hover:bg-red-950/40"
              onClick={() => onDelete(skill.name)}
              disabled={isDeleting}
              aria-label={`Delete ${skill.name}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Tool chips */}
      {Array.isArray((skill as any).tools) && (skill as any).tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {(skill as any).tools.map((tool: any) => (
            <span
              key={tool.name ?? tool}
              className="text-xs font-mono bg-slate-800 border border-slate-700 text-slate-400 px-2 py-0.5 rounded-md"
            >
              {tool.name ?? tool}
            </span>
          ))}
        </div>
      )}

      {/* Error state */}
      {hasError && (
        <div className="flex items-start gap-2 rounded-lg bg-red-950/60 border border-red-900 px-3 py-2">
          <AlertCircle className="h-3.5 w-3.5 text-red-400 shrink-0 mt-0.5" />
          <p className="text-xs text-red-300 font-mono leading-relaxed">
            {(skill as any).loadError}
          </p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload drop zone
// ─────────────────────────────────────────────────────────────────────────────

interface DropZoneProps {
  onFile: (file: File) => void;
  isUploading: boolean;
  progress: number | null;
}

function DropZone({ onFile, isUploading, progress }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) onFile(file);
    },
    [onFile]
  );

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={cn(
        "rounded-xl border-2 border-dashed p-8 text-center transition-colors cursor-pointer",
        dragging
          ? "border-indigo-500 bg-indigo-950/30"
          : "border-slate-700 hover:border-slate-600 bg-slate-900/40"
      )}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".ts,.js"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
      <UploadCloud className="h-8 w-8 mx-auto mb-3 text-slate-500" />
      <p className="text-sm font-medium text-slate-300">
        Drop a <code className="bg-slate-800 px-1 rounded text-xs">.ts</code> or{" "}
        <code className="bg-slate-800 px-1 rounded text-xs">.js</code> skill file here
      </p>
      <p className="text-xs text-slate-500 mt-1">or click to browse</p>

      {isUploading && (
        <div className="mt-4">
          <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-indigo-500 transition-all duration-300 rounded-full"
              style={{ width: progress != null ? `${progress}%` : "40%" }}
            />
          </div>
          <p className="text-xs text-slate-500 mt-1.5">Uploading…</p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Skills page
// ─────────────────────────────────────────────────────────────────────────────

export default function Skills() {
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  const { data: skills, isLoading } = useQuery({
    queryKey: ["skills"],
    queryFn: getSkills,
    refetchInterval: 30_000,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      toggleSkill(name, enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills"] }),
    onError: () => toast({ title: "Failed to toggle skill", variant: "destructive" }),
  });

  const reloadMutation = useMutation({
    mutationFn: reloadSkills,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast({
        title: "Skills reloaded",
        description: `${data.reloaded} skill${data.reloaded !== 1 ? "s" : ""} loaded.`,
        variant: "success" as any,
      });
    },
    onError: () => toast({ title: "Reload failed", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => deleteSkill(name),
    onSuccess: (_, name) => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast({ title: `Skill "${name}" deleted`, variant: "success" as any });
      setDeleteTarget(null);
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => {
      setUploadProgress(10);
      return uploadSkill(file);
    },
    onSuccess: (data) => {
      setUploadProgress(100);
      setTimeout(() => setUploadProgress(null), 600);
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast({
        title: `Skill "${data.name}" uploaded`,
        description: "Skill is now available.",
        variant: "success" as any,
      });
    },
    onError: () => {
      setUploadProgress(null);
      toast({ title: "Upload failed", variant: "destructive" });
    },
  });

  const builtInSkills = (skills ?? []).filter((s) => s.builtIn);
  const customSkills = (skills ?? []).filter((s) => !s.builtIn);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Skills</h1>
          <p className="mt-1 text-sm text-slate-400">
            Manage built-in and custom hot-loaded skills
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="border-slate-700 bg-slate-800/50 text-slate-300 hover:bg-slate-800 hover:text-white"
          onClick={() => reloadMutation.mutate()}
          disabled={reloadMutation.isPending}
        >
          <RefreshCw
            className={cn("h-4 w-4 mr-2", reloadMutation.isPending && "animate-spin")}
          />
          Reload All Skills
        </Button>
      </div>

      {isLoading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : (
        <>
          {/* Built-in skills */}
          {builtInSkills.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
                Built-in Skills
              </h2>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {builtInSkills.map((skill) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    onToggle={(name, enabled) => toggleMutation.mutate({ name, enabled })}
                    onDelete={(name) => setDeleteTarget(name)}
                    isToggling={toggleMutation.isPending}
                    isDeleting={deleteMutation.isPending}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Custom skills */}
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
              Custom Skills
            </h2>
            {customSkills.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 px-6 py-10 text-center">
                <Puzzle className="h-10 w-10 mx-auto mb-3 text-slate-600 opacity-50" />
                <p className="text-sm font-medium text-slate-400">No custom skills yet</p>
                <p className="text-xs text-slate-600 mt-1 max-w-xs mx-auto">
                  Upload a <code className="bg-slate-800 px-1 rounded">.ts</code> or{" "}
                  <code className="bg-slate-800 px-1 rounded">.js</code> skill file below,
                  or drop one into <code className="bg-slate-800 px-1 rounded">volumes/skills/</code>.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {customSkills.map((skill) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    onToggle={(name, enabled) => toggleMutation.mutate({ name, enabled })}
                    onDelete={(name) => setDeleteTarget(name)}
                    isToggling={toggleMutation.isPending}
                    isDeleting={deleteMutation.isPending}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Upload zone */}
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
              Upload New Skill
            </h2>
            <DropZone
              onFile={(file) => uploadMutation.mutate(file)}
              isUploading={uploadMutation.isPending}
              progress={uploadProgress}
            />
          </section>
        </>
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="bg-slate-900 border-slate-700 text-white">
          <DialogHeader>
            <DialogTitle>Delete skill</DialogTitle>
            <DialogDescription className="text-slate-400">
              Are you sure you want to delete{" "}
              <span className="font-semibold text-white">{deleteTarget}</span>? This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-3 pt-2">
            <Button
              variant="outline"
              className="border-slate-700 text-slate-300"
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
              disabled={deleteMutation.isPending}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
