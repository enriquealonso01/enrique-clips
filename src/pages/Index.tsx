import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { StatusBadge } from "@/components/StatusBadge";
import { Plus, Play, Pause, Square, ChevronDown, Upload, UploadCloud, Archive, ArchiveRestore, MoreVertical } from "lucide-react";
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

export default function ProjectsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [view, setView] = useState<"active" | "archived">("active");

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
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {filteredProjects?.map((project) => {
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
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg truncate">{project.title}</CardTitle>
                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
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
          })}
        </div>
      )}
    </div>
  );
}
