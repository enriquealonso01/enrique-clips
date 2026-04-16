import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StoryAssetUploader } from "@/components/story/StoryAssetUploader";
import { ScheduleManager } from "@/components/ScheduleManager";
import { toast } from "@/hooks/use-toast";
import { StoryStatusBadge } from "@/components/story/StoryStatusBadge";
import { ArrowLeft, Play, Save, ExternalLink } from "lucide-react";
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

  const { data: runs } = useQuery({
    queryKey: ["story-runs-for-project", projectId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("story_runs")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(20);
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
  const [storySearchPrompt, setStorySearchPrompt] = useState("");
  const [uploadpostApiKey, setUploadpostApiKey] = useState("");
  const [uploadpostApiKeyConfigured, setUploadpostApiKeyConfigured] = useState(false);
  const [uploadpostProfileUsername, setUploadpostProfileUsername] = useState("");
  const [publishDefaults, setPublishDefaults] = useState<Record<string, any>>({});

  useEffect(() => {
    if (project) {
      setTitle(project.title);
      setTimezone(project.timezone);
      setTargetDuration((project as any).target_duration_sec || 60);
      setPlatforms(project.publish_platforms as Record<string, boolean>);
      setConfigJson(project.config_json || {});
      setStorySearchPrompt((project as any).story_search_prompt || "");
      setUploadpostApiKey((project as any).uploadpost_api_key_encrypted || "");
      setUploadpostApiKeyConfigured((project as any).uploadpost_api_key_configured || false);
      setUploadpostProfileUsername((project as any).uploadpost_profile_username || "");
      setPublishDefaults((project.publish_defaults as Record<string, any>) || {});
    }
  }, [project]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("story_projects").update({
        title,
        timezone,
        target_duration_sec: targetDuration,
        publish_platforms: platforms,
        publish_defaults: publishDefaults,
        config_json: configJson,
        story_search_prompt: storySearchPrompt || null,
        uploadpost_api_key_encrypted: uploadpostApiKey || null,
        uploadpost_api_key_configured: !!uploadpostApiKey,
        uploadpost_profile_username: uploadpostProfileUsername || null,
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

  const updatePublishDefault = (platform: string, key: string, value: any) => {
    setPublishDefaults({
      ...publishDefaults,
      [platform]: { ...(publishDefaults[platform] || {}), [key]: value },
    });
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/stories")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-xl font-bold tracking-tight truncate">{project.title}</h1>
      </div>

      <Tabs defaultValue="general">
        <TabsList className="flex flex-wrap h-auto gap-1 p-1">
          <TabsTrigger value="general" className="text-xs sm:text-sm">General</TabsTrigger>
          <TabsTrigger value="media" className="text-xs sm:text-sm">Media</TabsTrigger>
          <TabsTrigger value="audio" className="text-xs sm:text-sm">Audio</TabsTrigger>
          <TabsTrigger value="publish" className="text-xs sm:text-sm">Publish</TabsTrigger>
          <TabsTrigger value="schedule" className="text-xs sm:text-sm">Schedule</TabsTrigger>
          <TabsTrigger value="runs" className="text-xs sm:text-sm">Runs</TabsTrigger>
        </TabsList>

        {/* General Tab */}
        <TabsContent value="general" className="space-y-4 mt-4">
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
              <div className="space-y-2">
                <Label>Story Search Category</Label>
                <Textarea
                  value={storySearchPrompt}
                  onChange={(e) => setStorySearchPrompt(e.target.value)}
                  placeholder="e.g. Stories with animals, Stories with kids, Heartwarming military reunions..."
                  rows={2}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty for general wholesome stories. Add a category or requirement to focus the story search.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Video Generation</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label>Vidu Off-Peak Mode</Label>
                  <p className="text-xs text-muted-foreground">
                    Submit clips at half price ($0.04/s vs $0.08/s). Clips may take up to 48h to complete.
                  </p>
                </div>
                <Switch
                  checked={configJson?.vidu_off_peak ?? false}
                  onCheckedChange={(v) => setConfigJson({ ...configJson, vidu_off_peak: v })}
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Media Tab */}
        <TabsContent value="media" className="space-y-4 mt-4">
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
        </TabsContent>

        {/* Audio Tab */}
        <TabsContent value="audio" className="space-y-4 mt-4">
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
            <CardHeader><CardTitle>Narration Pacing</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <Label>Segmented narration (tighter pacing)</Label>
                  <p className="text-xs text-muted-foreground">
                    Generates each sentence separately and stitches them together with a small gap. Removes long internal pauses while keeping voice consistency via ElevenLabs request stitching. Costs slightly more per run.
                  </p>
                </div>
                <Switch
                  checked={configJson?.narration?.segmented_enabled ?? false}
                  onCheckedChange={(v) =>
                    setConfigJson({ ...configJson, narration: { ...(configJson?.narration || {}), segmented_enabled: v } })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Inter-segment gap (ms)</Label>
                <Input
                  type="number" min={0} max={500}
                  value={configJson?.narration?.segment_gap_ms ?? 80}
                  onChange={(e) =>
                    setConfigJson({ ...configJson, narration: { ...(configJson?.narration || {}), segment_gap_ms: Number(e.target.value) } })
                  }
                />
                <p className="text-xs text-muted-foreground">Silence inserted between sentences. 80ms feels natural; 30ms is very punchy.</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Publish Tab */}
        <TabsContent value="publish" className="space-y-4 mt-4">
          <Card>
            <CardHeader><CardTitle>Upload-Post Configuration</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>API Key</Label>
                <Input type="password" placeholder="Enter Upload-Post API key" value={uploadpostApiKey}
                  onChange={(e) => { setUploadpostApiKey(e.target.value); setUploadpostApiKeyConfigured(!!e.target.value); }} />
                <p className="text-xs text-muted-foreground">
                  Status: {uploadpostApiKeyConfigured ? "✅ Configured" : "❌ Not configured"}
                </p>
              </div>
              <div className="space-y-2">
                <Label>Profile Username</Label>
                <Input value={uploadpostProfileUsername} onChange={(e) => setUploadpostProfileUsername(e.target.value)} placeholder="Upload-Post profile username" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Platform Toggles</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {["tiktok", "instagram", "youtube", "facebook"].map((p) => (
                <div key={p} className="flex items-center justify-between">
                  <Label className="capitalize">{p}</Label>
                  <Switch checked={platforms[p] ?? true} onCheckedChange={(v) => setPlatforms({ ...platforms, [p]: v })} />
                </div>
              ))}
            </CardContent>
          </Card>

          {platforms.tiktok !== false && (
            <Card>
              <CardHeader><CardTitle className="text-base">TikTok Settings</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-3">
                  <Switch checked={publishDefaults.tiktok?.is_aigc ?? true} onCheckedChange={(v) => updatePublishDefault("tiktok", "is_aigc", v)} />
                  <Label>AI-generated content disclosure</Label>
                </div>
                <div className="space-y-2">
                  <Label>Privacy Level</Label>
                  <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={publishDefaults.tiktok?.privacy_level || "PUBLIC_TO_EVERYONE"}
                    onChange={(e) => updatePublishDefault("tiktok", "privacy_level", e.target.value)}>
                    <option value="PUBLIC_TO_EVERYONE">Public</option>
                    <option value="MUTUAL_FOLLOW_FRIENDS">Friends</option>
                    <option value="SELF_ONLY">Private</option>
                  </select>
                </div>
              </CardContent>
            </Card>
          )}

          {platforms.youtube !== false && (
            <Card>
              <CardHeader><CardTitle className="text-base">YouTube Settings</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-3">
                  <Switch checked={publishDefaults.youtube?.containsSyntheticMedia ?? true} onCheckedChange={(v) => updatePublishDefault("youtube", "containsSyntheticMedia", v)} />
                  <Label>Contains synthetic media</Label>
                </div>
                <div className="space-y-2">
                  <Label>Privacy Status</Label>
                  <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={publishDefaults.youtube?.privacyStatus || "public"}
                    onChange={(e) => updatePublishDefault("youtube", "privacyStatus", e.target.value)}>
                    <option value="public">Public</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="private">Private</option>
                  </select>
                </div>
              </CardContent>
            </Card>
          )}

          {platforms.facebook !== false && (
            <Card>
              <CardHeader><CardTitle className="text-base">Facebook Settings</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2">
                  <Label>Media Type</Label>
                  <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={publishDefaults.facebook?.facebook_media_type || "VIDEO"}
                    onChange={(e) => updatePublishDefault("facebook", "facebook_media_type", e.target.value)}>
                    <option value="VIDEO">Video (Feed)</option>
                    <option value="REELS">Reels</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>Facebook Page ID</Label>
                  <Input value={publishDefaults.facebook?.facebook_page_id || ""} onChange={(e) => updatePublishDefault("facebook", "facebook_page_id", e.target.value)} placeholder="Page ID" />
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Schedule Tab */}
        <TabsContent value="schedule" className="space-y-4 mt-4">
          <Card>
            <CardHeader><CardTitle>Timezone</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Label>Project Timezone</Label>
                <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
                <p className="text-xs text-muted-foreground">Schedule times are interpreted in this timezone.</p>
              </div>
            </CardContent>
          </Card>
          {projectId && <ScheduleManager projectId={projectId} timezone={timezone} storyProject />}
        </TabsContent>

        {/* Runs Tab */}
        <TabsContent value="runs" className="space-y-4 mt-4">
          <Card>
            <CardHeader><CardTitle>Run History</CardTitle></CardHeader>
            <CardContent>
              {!runs || runs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No runs yet.</p>
              ) : (
                <div className="space-y-2">
                  {runs.map((run) => (
                    <div
                      key={run.id}
                      className="flex items-center justify-between p-3 rounded-md border cursor-pointer hover:bg-accent/50 transition-colors"
                      onClick={() => navigate(`/story-runs/${run.id}`)}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <StoryStatusBadge status={run.status} />
                        <span className="text-sm text-muted-foreground truncate">
                          {new Date(run.created_at).toLocaleString()}
                        </span>
                        {(run.generated_metadata as any)?.story_title && (
                          <span className="text-sm truncate hidden sm:inline">
                            {(run.generated_metadata as any).story_title}
                          </span>
                        )}
                      </div>
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

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
