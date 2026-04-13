import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { StoryStatusBadge } from "@/components/story/StoryStatusBadge";
import { Plus, Play, Pause, Square } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "@/hooks/use-toast";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export default function StoriesIndex() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: projects, isLoading } = useQuery({
    queryKey: ["story-projects"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("story_projects")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: latestRuns } = useQuery({
    queryKey: ["story-latest-runs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("story_runs")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const createProject = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.from("story_projects").insert({}).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["story-projects"] });
      navigate(`/stories/${data.id}`);
    },
    onError: () => toast({ title: "Error", description: "Failed to create story project", variant: "destructive" }),
  });

  const startRun = useMutation({
    mutationFn: async (projectId: string) => {
      const { data, error } = await supabase
        .from("story_runs")
        .insert({ project_id: projectId, status: "queued" as any })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["story-latest-runs"] });
      toast({ title: "Story run created", description: "Pipeline starting..." });
      supabase.functions.invoke("story-pipeline", { body: { run_id: data.id } }).catch(console.error);
      navigate(`/story-runs/${data.id}`);
    },
    onError: () => toast({ title: "Error", description: "Failed to start story run", variant: "destructive" }),
  });

  const updateStatus = useMutation({
    mutationFn: async ({ runId, status }: { runId: string; status: string }) => {
      const updates: Record<string, unknown> = { status };
      if (status === "cancelled") updates.finished_at = new Date().toISOString();
      const { error } = await supabase.from("story_runs").update(updates).eq("id", runId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["story-latest-runs"] });
      toast({ title: "Updated" });
    },
  });

  const toggleEnabled = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const { error } = await supabase.from("story_projects").update({ is_enabled: enabled }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["story-projects"] }),
  });

  const getLatestRun = (pid: string) => latestRuns?.find((r) => r.project_id === pid);

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading story projects...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Stories</h1>
          <p className="text-sm text-muted-foreground">Wholesome story video automation pipeline</p>
        </div>
        <Button onClick={() => createProject.mutate()} disabled={createProject.isPending} className="w-full sm:w-auto">
          <Plus className="mr-2 h-4 w-4" /> New Story Project
        </Button>
      </div>

      {projects?.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground mb-4">No story projects yet. Create your first one!</p>
            <Button onClick={() => createProject.mutate()}>
              <Plus className="mr-2 h-4 w-4" /> Create Story Project
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {projects?.map((project) => {
            const run = getLatestRun(project.id);
            const canPause = run?.status === "researching_story" || run?.status === "story_selected" || run?.status === "cast_generated";
            const canStop = run && !["published", "failed", "cancelled"].includes(run.status);

            return (
              <Card
                key={project.id}
                className="cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => navigate(`/stories/${project.id}`)}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg truncate">{project.title}</CardTitle>
                    <Switch
                      checked={project.is_enabled}
                      onCheckedChange={(checked) => toggleEnabled.mutate({ id: project.id, enabled: checked })}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Last Run</span>
                    {run ? <StoryStatusBadge status={run.status} /> : <span className="text-muted-foreground">—</span>}
                  </div>
                  <div className="flex gap-2 pt-2">
                    <Button size="sm" variant="outline" disabled={startRun.isPending} onClick={(e) => { e.stopPropagation(); startRun.mutate(project.id); }}>
                      <Play className="h-3 w-3" />
                    </Button>
                    <Button size="sm" variant="outline" disabled={!canPause} onClick={(e) => { e.stopPropagation(); if (run) updateStatus.mutate({ runId: run.id, status: "paused" }); }}>
                      <Pause className="h-3 w-3" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="sm" variant="outline" disabled={!canStop} onClick={(e) => e.stopPropagation()}>
                          <Square className="h-3 w-3" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Cancel this run?</AlertDialogTitle>
                          <AlertDialogDescription>This will cancel the current story run.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>No</AlertDialogCancel>
                          <AlertDialogAction onClick={() => { if (run) updateStatus.mutate({ runId: run.id, status: "cancelled" }); }}>Cancel Run</AlertDialogAction>
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
