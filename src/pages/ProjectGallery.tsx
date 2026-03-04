import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/StatusBadge";
import { ArrowLeft, Image, Film, Sparkles } from "lucide-react";
import { useState } from "react";

const ASSET_TYPE_LABELS: Record<string, { label: string; icon: typeof Image }> = {
  initial_image: { label: "Initial Image", icon: Sparkles },
  keyframe: { label: "Keyframe", icon: Image },
  clip: { label: "Clip", icon: Film },
  final_video: { label: "Final Video", icon: Film },
  thumbnail: { label: "Thumbnail", icon: Image },
};

export default function ProjectGallery() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [runFilter, setRunFilter] = useState<string>("all");

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => {
      const { data, error } = await supabase.from("projects").select("*").eq("id", projectId!).single();
      if (error) throw error;
      return data;
    },
    enabled: !!projectId,
  });

  const { data: runs } = useQuery({
    queryKey: ["project-runs", projectId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("runs")
        .select("id, created_at, status")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!projectId,
  });

  const { data: assets, isLoading } = useQuery({
    queryKey: ["project-assets", projectId, typeFilter, runFilter],
    queryFn: async () => {
      let q = supabase
        .from("assets")
        .select("*, scenes(scene_index, scene_title)")
        .order("created_at", { ascending: false });

      if (runFilter !== "all") {
        q = q.eq("run_id", runFilter);
      } else {
        // Get all run IDs for this project
        const { data: projectRuns } = await supabase
          .from("runs")
          .select("id")
          .eq("project_id", projectId!);
        if (projectRuns && projectRuns.length > 0) {
          q = q.in("run_id", projectRuns.map((r) => r.id));
        } else {
          return [];
        }
      }

      if (typeFilter !== "all") {
        q = q.eq("type", typeFilter as any);
      }

      const { data, error } = await q.limit(100);
      if (error) throw error;
      return data;
    },
    enabled: !!projectId,
  });

  const getPublicUrl = (path: string) => {
    const { data } = supabase.storage.from("project-assets").getPublicUrl(path);
    return data.publicUrl;
  };

  const isVideo = (path: string) =>
    path.endsWith(".mp4") || path.endsWith(".webm") || path.endsWith(".mov");

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/projects/${projectId}`)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight">Gallery</h1>
          <p className="text-sm text-muted-foreground">{project?.title || "Project"}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Asset type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="initial_image">Initial Images</SelectItem>
            <SelectItem value="keyframe">Keyframes</SelectItem>
            <SelectItem value="clip">Clips</SelectItem>
            <SelectItem value="final_video">Final Videos</SelectItem>
            <SelectItem value="thumbnail">Thumbnails</SelectItem>
          </SelectContent>
        </Select>

        <Select value={runFilter} onValueChange={setRunFilter}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Run" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Runs</SelectItem>
            {runs?.map((run) => (
              <SelectItem key={run.id} value={run.id}>
                {new Date(run.created_at).toLocaleDateString()} — {run.status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="text-center text-muted-foreground py-12">Loading assets...</div>
      ) : !assets?.length ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Image className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p>No assets found. Run the pipeline to generate images and videos.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {assets.map((asset) => {
            const url = getPublicUrl(asset.supabase_path);
            const typeInfo = ASSET_TYPE_LABELS[asset.type] || { label: asset.type, icon: Image };
            const Icon = typeInfo.icon;
            const scene = (asset as any).scenes;

            return (
              <Card key={asset.id} className="overflow-hidden group">
                <div className="aspect-[9/16] bg-muted relative">
                  {isVideo(asset.supabase_path) ? (
                    <video
                      src={url}
                      controls
                      className="w-full h-full object-cover"
                      preload="metadata"
                    />
                  ) : (
                    <img
                      src={url}
                      alt={typeInfo.label}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  )}
                  <div className="absolute top-2 left-2">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-background/80 backdrop-blur-sm text-foreground">
                      <Icon className="h-3 w-3" />
                      {typeInfo.label}
                    </span>
                  </div>
                </div>
                <CardContent className="p-3 space-y-1">
                  {scene?.scene_title && (
                    <p className="text-xs font-medium truncate">{scene.scene_title}</p>
                  )}
                  {scene?.scene_index != null && (
                    <p className="text-[10px] text-muted-foreground">Scene {scene.scene_index}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    {new Date(asset.created_at).toLocaleString()}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
