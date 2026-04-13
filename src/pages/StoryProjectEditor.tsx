import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { StoryAssetUploader } from "@/components/story/StoryAssetUploader";
import { toast } from "@/hooks/use-toast";
import { ArrowLeft, Play, Save } from "lucide-react";
import { useState, useEffect } from "react";

export default function StoryProjectEditor() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: project, isLoading } = useQuery({
    queryKey: ["story-project", projectId],
    queryFn: async () => {
      const { data, error } = await supabase.from("story_projects").select("*").eq("id", projectId!).single();
      if (error) throw error;
      return data;
    },
    enabled: !!projectId,
  });

  const [title, setTitle] = useState("");
  const [timezone, setTimezone] = useState("America/New_York");
  const [targetDuration, setTargetDuration] = useState(60);
  const [platforms, setPlatforms] = useState<Record<string, boolean>>({ tiktok: true, youtube: true, facebook: true, instagram: true });
  const [configJson, setConfigJson] = useState<any>({});

  useEffect(() => {
    if (project) {
      setTitle(project.title);
      setTimezone(project.timezone);
      setTargetDuration((project as any).target_duration_sec || 60);
      setPlatforms(project.publish_platforms as Record<string, boolean>);
      setConfigJson(project.config_json || {});
    }
  }, [project]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("story_projects").update({
        title,
        timezone,
        target_duration_sec: targetDuration,
        publish_platforms: platforms,
        config_json: configJson,
      } as any).eq("id", projectId!);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["story-project", projectId] });
      toast({ title: "Saved" });
    },
    onError: () => toast({ title: "Error", description: "Failed to save", variant: "destructive" }),
  });

  const updateAssetPath = useMutation({
    mutationFn: async ({ field, value }: { field: string; value: string | null }) => {
      const { error } = await supabase.from("story_projects").update({ [field]: value }).eq("id", projectId!);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["story-project", projectId] }),
  });

  const startRun = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase
        .from("story_runs")
        .insert({ project_id: projectId!, status: "queued" as any })
        .select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast({ title: "Story run started" });
      supabase.functions.invoke("story-pipeline", { body: { run_id: data.id } }).catch(console.error);
      navigate(`/story-runs/${data.id}`);
    },
  });

  if (isLoading || !project) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading...</div>;
  }

  const audioMix = configJson?.audio_mix || {};

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/stories")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-xl font-bold tracking-tight truncate">{project.title}</h1>
      </div>

      <Card>
        <CardHeader><CardTitle>General</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Timezone</Label>
            <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          </div>
          <div className="space-y-3">
            <Label>Target Video Duration: {targetDuration}s</Label>
            <Slider
              value={[targetDuration]}
              onValueChange={([v]) => setTargetDuration(v)}
              min={30}
              max={180}
              step={5}
              className="w-full"
            />
            <p className="text-xs text-muted-foreground">
              {targetDuration <= 60 ? "Short & punchy" : targetDuration <= 120 ? "Standard length" : "Extended story"} — the pipeline will adapt beat count and pacing automatically.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Media Uploads</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <StoryAssetUploader
            projectId={projectId!}
            label="Background Music"
            accept="audio/mpeg,audio/wav,audio/mp4"
            currentPath={project.background_music_path}
            icon="music"
            onUploaded={(path) => updateAssetPath.mutate({ field: "background_music_path", value: path })}
          />
          <StoryAssetUploader
            projectId={projectId!}
            label="Ending Audio"
            accept="audio/mpeg,audio/wav,audio/mp4"
            currentPath={project.ending_audio_path}
            icon="music"
            onUploaded={(path) => updateAssetPath.mutate({ field: "ending_audio_path", value: path })}
          />
          <StoryAssetUploader
            projectId={projectId!}
            label="Emoji"
            accept="image/png,image/webp,image/gif"
            currentPath={project.emoji_path}
            icon="image"
            onUploaded={(path) => updateAssetPath.mutate({ field: "emoji_path", value: path })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Audio Mix</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Narrator Gain (dB)</Label>
              <Input type="number" value={audioMix.narrator_gain_db ?? 0}
                onChange={(e) => setConfigJson({ ...configJson, audio_mix: { ...audioMix, narrator_gain_db: Number(e.target.value) } })} />
            </div>
            <div className="space-y-2">
              <Label>BGM Gain (dB)</Label>
              <Input type="number" value={audioMix.background_music_gain_db ?? -22}
                onChange={(e) => setConfigJson({ ...configJson, audio_mix: { ...audioMix, background_music_gain_db: Number(e.target.value) } })} />
            </div>
            <div className="space-y-2">
              <Label>BGM Duck Gain (dB)</Label>
              <Input type="number" value={audioMix.background_music_duck_gain_db ?? -26}
                onChange={(e) => setConfigJson({ ...configJson, audio_mix: { ...audioMix, background_music_duck_gain_db: Number(e.target.value) } })} />
            </div>
            <div className="flex items-center gap-2 pt-6">
              <Switch checked={audioMix.background_music_ducking_enabled ?? true}
                onCheckedChange={(v) => setConfigJson({ ...configJson, audio_mix: { ...audioMix, background_music_ducking_enabled: v } })} />
              <Label>Ducking Enabled</Label>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Publish Platforms</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {["tiktok", "youtube", "facebook", "instagram"].map((p) => (
            <div key={p} className="flex items-center justify-between">
              <Label className="capitalize">{p}</Label>
              <Switch checked={platforms[p] ?? true} onCheckedChange={(v) => setPlatforms({ ...platforms, [p]: v })} />
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex gap-3">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          <Save className="mr-2 h-4 w-4" /> Save
        </Button>
        <Button variant="outline" onClick={() => startRun.mutate()} disabled={startRun.isPending}>
          <Play className="mr-2 h-4 w-4" /> Run Now
        </Button>
      </div>
    </div>
  );
}
