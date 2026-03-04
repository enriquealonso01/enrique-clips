import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { StatusBadge } from "@/components/StatusBadge";
import { Plus, Play, Pause, Square } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "@/hooks/use-toast";

export default function ProjectsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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

  const toggleEnabled = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const { error } = await supabase.from("projects").update({ is_enabled: enabled }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });

  const getLatestRun = (projectId: string) =>
    latestRuns?.find((r) => r.project_id === projectId);

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading projects...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
          <p className="text-muted-foreground">Manage your AI creator automation projects</p>
        </div>
        <Button onClick={() => createProject.mutate()} disabled={createProject.isPending}>
          <Plus className="mr-2 h-4 w-4" />
          New Project
        </Button>
      </div>

      {projects?.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground mb-4">No projects yet. Create your first one!</p>
            <Button onClick={() => createProject.mutate()}>
              <Plus className="mr-2 h-4 w-4" />
              Create Project
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects?.map((project) => {
            const latestRun = getLatestRun(project.id);
            return (
              <Card
                key={project.id}
                className="cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => navigate(`/projects/${project.id}`)}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg truncate">{project.title}</CardTitle>
                    <Switch
                      checked={project.is_enabled}
                      onCheckedChange={(checked) => {
                        toggleEnabled.mutate({ id: project.id, enabled: checked });
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
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
                    <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); }}>
                      <Play className="h-3 w-3" />
                    </Button>
                    <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); }}>
                      <Pause className="h-3 w-3" />
                    </Button>
                    <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); }}>
                      <Square className="h-3 w-3" />
                    </Button>
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
