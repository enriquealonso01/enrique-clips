import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { StatusBadge } from "@/components/StatusBadge";
import { LifecycleBadge, ReviewDueIcon, reviewDueInfo } from "@/components/LifecycleStatus";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Plus, Play, Pause, Square, ChevronDown, Upload, UploadCloud, Archive, ArchiveRestore, MoreVertical, Copy, Folder } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useNavigate } from "react-router-dom";
import { toast } from "@/hooks/use-toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

// Longest common prefix of the project titles in a folder, trimmed of trailing
// separators/numbers-spacing — gives "Secret Backyard Builds" from "... 1/2/3".
function commonTitlePrefix(titles: string[]): string {
  if (titles.length === 0) return "";
  let prefix = titles[0];
  for (let i = 1; i < titles.length; i++) {
    const t = titles[i];
    let j = 0;
    while (j < prefix.length && j < t.length && prefix[j] === t[j]) j++;
    prefix = prefix.slice(0, j);
    if (!prefix) break;
  }
  return prefix.replace(/[\s\-–—#:.]+$/, "").trim();
}

function folderLabel(profileUsername: string, projects: { title: string }[]): string {
  const prefix = commonTitlePrefix(projects.map((p) => p.title));
  return prefix.length >= 3 ? prefix : profileUsername;
}

export default function ProjectsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [view, setView] = useState<"active" | "archived">("active");
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});

  const { data: projects, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("projects")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: latestRuns } = useQuery({
    queryKey: ["latest-runs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("runs")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const createProject = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase
        .from("projects")
        .insert({})
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate(`/projects/${data.id}`);
    },
    onError: () => toast({ title: "Error", description: "Failed to create project", variant: "destructive" }),
  });

  const runNow = useMutation({
    mutationFn: async ({ projectId, skipPublish }: { projectId: string; skipPublish?: boolean }) => {
      const { data, error } = await supabase
        .from("runs")
        .insert({ project_id: projectId, status: "queued" as const })
        .select()
        .single();
      if (error) throw error;
      return { run: data, skipPublish: !!skipPublish };
    },
    onSuccess: ({ run, skipPublish }) => {
      queryClient.invalidateQueries({ queryKey: ["latest-runs"] });
      toast({
        title: "Run created",
        description: skipPublish ? "Pipeline starting (no publish)..." : "Pipeline starting...",
      });
      // Fire and forget - invoke pipeline
      supabase.functions.invoke('run-pipeline', {
        body: { run_id: run.id, ...(skipPublish ? { skip_publish: true } : {}) },
      })
        .then((res) => {
          if (res.error) console.error('Pipeline invoke error:', res.error);
        })
        .catch(err => console.error('Pipeline invoke failed:', err));
      navigate(`/runs/${run.id}`);
    },
    onError: () => toast({ title: "Error", description: "Failed to create run", variant: "destructive" }),
  });

  const updateRunStatus = useMutation({
    mutationFn: async ({ runId, status }: { runId: string; status: string }) => {
      const updates: Record<string, unknown> = { status };
      if (status === "stopped") updates.finished_at = new Date().toISOString();
      const { error } = await supabase.from("runs").update(updates).eq("id", runId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["latest-runs"] });
      toast({ title: "Updated", description: "Run status updated" });
    },
    onError: () => toast({ title: "Error", description: "Failed to update run", variant: "destructive" }),
  });

  const toggleEnabled = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const { error } = await supabase.from("projects").update({ is_enabled: enabled }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });

  const duplicateProject = useMutation({
    mutationFn: async (projectId: string) => {
      const { data: src, error: srcErr } = await supabase
        .from("projects")
        .select("*")
        .eq("id", projectId)
        .single();
      if (srcErr) throw srcErr;

      const { id, created_at, updated_at, last_run_at, lifecycle_status, testing_due_date, ...rest } = src;
      const { data: newProject, error: insertErr } = await supabase
        .from("projects")
        .insert({ ...rest, title: `${src.title} (Copy)`, is_enabled: false })
        .select()
        .single();
      if (insertErr) throw insertErr;

      const { data: overlays } = await supabase
        .from("overlays")
        .select("*")
        .eq("project_id", projectId);
      if (overlays && overlays.length > 0) {
        const newOverlays = overlays.map(({ id: _id, created_at: _ca, project_id: _pid, ...o }) => ({
          ...o,
          project_id: newProject.id,
        }));
        await supabase.from("overlays").insert(newOverlays);
      }

      const { data: tracks } = await supabase
        .from("project_tracks")
        .select("*")
        .eq("project_id", projectId);
      if (tracks && tracks.length > 0) {
        const newTracks = tracks.map(({ id: _id, created_at: _ca, project_id: _pid, ...t }) => ({
          ...t,
          project_id: newProject.id,
        }));
        await supabase.from("project_tracks").insert(newTracks);
      }

      return newProject;
    },
    onSuccess: (newProject) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast({ title: "Project duplicated", description: `"${newProject.title}" created` });
      navigate(`/projects/${newProject.id}`);
    },
    onError: () => toast({ title: "Error", description: "Failed to duplicate project", variant: "destructive" }),
  });

  const toggleArchived = useMutation({
    mutationFn: async ({ id, archived }: { id: string; archived: boolean }) => {
      const { error } = await supabase
        .from("projects")
        .update({ is_archived: archived, ...(archived ? { is_enabled: false } : {}) })
        .eq("id", id);
      if (error) throw error;
      return archived;
    },
    onSuccess: (archived) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast({ title: archived ? "Project archived" : "Project unarchived" });
    },
    onError: () => toast({ title: "Error", description: "Failed to update project", variant: "destructive" }),
  });

  const getLatestRun = (projectId: string) =>
    latestRuns?.find((r) => r.project_id === projectId);

  const filteredProjects = projects?.filter((p) =>
    view === "archived" ? p.is_archived : !p.is_archived
  );

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading projects...</div>;
  }

  // Auto-group projects that share an Upload-Post profile (a channel). A channel
  // with 2+ project rows folds into a collapsible folder; single-project channels
  // (and projects with no profile) stay as flat top-level cards.
  const visibleProjects = filteredProjects ?? [];
  const profileGroups = new Map<string, typeof visibleProjects>();
  for (const p of visibleProjects) {
    if (!p.uploadpost_profile_username) continue;
    const arr = profileGroups.get(p.uploadpost_profile_username);
    if (arr) arr.push(p);
    else profileGroups.set(p.uploadpost_profile_username, [p]);
  }
  const folders = Array.from(profileGroups.entries())
    .filter(([, list]) => list.length >= 2)
    .map(([key, list]) => ({ key, label: folderLabel(key, list), projects: list }));
  const folderedIds = new Set(folders.flatMap((f) => f.projects.map((p) => p.id)));
  const ungroupedProjects = visibleProjects.filter((p) => !folderedIds.has(p.id));
  const toggleFolder = (key: string) =>
    setOpenFolders((s) => ({ ...s, [key]: !s[key] }));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">Manage your AI creator automation projects</p>
        </div>
        <Button onClick={() => createProject.mutate()} disabled={createProject.isPending} className="w-full sm:w-auto">
          <Plus className="mr-2 h-4 w-4" />
          New Project
        </Button>
      </div>

      <Tabs value={view} onValueChange={(v) => setView(v as "active" | "archived")}>
        <TabsList>
          <TabsTrigger value="active">
            Active ({projects?.filter((p) => !p.is_archived).length ?? 0})
          </TabsTrigger>
          <TabsTrigger value="archived">
            Archived ({projects?.filter((p) => p.is_archived).length ?? 0})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {filteredProjects?.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground mb-4">
              {view === "archived" ? "No archived projects." : "No projects yet. Create your first one!"}
            </p>
            {view === "active" && (
              <Button onClick={() => createProject.mutate()}>
                <Plus className="mr-2 h-4 w-4" />
                Create Project
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {(() => {
            const renderProjectCard = (project: NonNullable<typeof projects>[number]) => {
            const latestRun = getLatestRun(project.id);
            const canPause = latestRun?.status === "running";
            const canResume = latestRun?.status === "paused";
            const canStop = latestRun && ["running", "paused", "queued"].includes(latestRun.status);

            return (
              <Card
                key={project.id}
                className="cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => navigate(`/projects/${project.id}`)}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <CardTitle className="text-lg truncate">{project.title}</CardTitle>
                      {project.lifecycle_status === "testing" && (
                        <ReviewDueIcon dueDate={project.testing_due_date} />
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                      {!project.is_archived && (
                        <Switch
                          checked={project.is_enabled}
                          onCheckedChange={(checked) => {
                            toggleEnabled.mutate({ id: project.id, enabled: checked });
                          }}
                        />
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              duplicateProject.mutate(project.id);
                            }}
                            disabled={duplicateProject.isPending}
                          >
                            <Copy className="mr-2 h-4 w-4" />
                            Duplicate
                          </DropdownMenuItem>
                          {project.is_archived ? (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleArchived.mutate({ id: project.id, archived: false });
                              }}
                            >
                              <ArchiveRestore className="mr-2 h-4 w-4" />
                              Unarchive
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleArchived.mutate({ id: project.id, archived: true });
                              }}
                            >
                              <Archive className="mr-2 h-4 w-4" />
                              Archive
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Status</span>
                    <LifecycleBadge status={project.lifecycle_status} />
                  </div>
                  {project.lifecycle_status === "testing" && (() => {
                    const info = reviewDueInfo(project.testing_due_date);
                    const alert = info.state === "overdue" || info.state === "today";
                    return (
                      <div className="flex items-start justify-between gap-2 text-sm">
                        <span className="text-muted-foreground shrink-0">Review</span>
                        <span className={alert ? "text-destructive font-medium text-right" : "text-muted-foreground text-right"}>
                          {info.message}
                        </span>
                      </div>
                    );
                  })()}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Last Run</span>
                    {latestRun ? <StatusBadge status={latestRun.status} /> : <span className="text-muted-foreground">—</span>}
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Schedule</span>
                    <span className="capitalize">{project.posting_frequency_type}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Scenes</span>
                    <span>{project.scene_count} × {project.clip_duration_sec}s</span>
                  </div>
                  <div className="flex gap-2 pt-2">
                    <div className="flex" onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="sm"
                        variant="outline"
                        className="rounded-r-none border-r-0"
                        disabled={runNow.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          runNow.mutate({ projectId: project.id });
                        }}
                      >
                        <Play className="h-3 w-3" />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-l-none px-1.5"
                            disabled={runNow.isPending}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ChevronDown className="h-3 w-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              runNow.mutate({ projectId: project.id });
                            }}
                          >
                            <UploadCloud className="mr-2 h-4 w-4" />
                            Run &amp; publish
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              runNow.mutate({ projectId: project.id, skipPublish: true });
                            }}
                          >
                            <Upload className="mr-2 h-4 w-4 opacity-50" />
                            Run without publishing
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canPause && !canResume}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (latestRun) {
                          updateRunStatus.mutate({
                            runId: latestRun.id,
                            status: canPause ? "paused" : "running",
                          });
                        }
                      }}
                    >
                      <Pause className="h-3 w-3" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canStop}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Square className="h-3 w-3" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Stop this run?</AlertDialogTitle>
                          <AlertDialogDescription>This will stop the current run. This action cannot be undone.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => {
                            if (latestRun) updateRunStatus.mutate({ runId: latestRun.id, status: "stopped" });
                          }}>
                            Stop Run
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </CardContent>
              </Card>
            );
            };
            return (
              <>
                {ungroupedProjects.length > 0 && (
                  <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                    {ungroupedProjects.map(renderProjectCard)}
                  </div>
                )}
                {folders.map((folder) => (
                  <Collapsible
                    key={folder.key}
                    open={!!openFolders[folder.key]}
                    onOpenChange={() => toggleFolder(folder.key)}
                  >
                    <Card>
                      <CollapsibleTrigger asChild>
                        <button className="w-full flex items-center justify-between gap-2 p-4 text-left hover:bg-muted/50 transition-colors">
                          <div className="flex items-center gap-2 min-w-0">
                            <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
                            <span className="font-semibold truncate">{folder.label}</span>
                            <span className="text-sm text-muted-foreground shrink-0">{folder.projects.length}</span>
                          </div>
                          <ChevronDown
                            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${openFolders[folder.key] ? "rotate-180" : ""}`}
                          />
                        </button>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 p-4 pt-0">
                          {folder.projects.map(renderProjectCard)}
                        </div>
                      </CollapsibleContent>
                    </Card>
                  </Collapsible>
                ))}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
