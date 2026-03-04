import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Save, Copy, RefreshCw, AlertTriangle } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";
import type { Tables } from "@/integrations/supabase/types";

type Project = Tables<"projects">;

export default function ProjectEditor() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Partial<Project>>({});

  const { data: project, isLoading } = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => {
      const { data, error } = await supabase.from("projects").select("*").eq("id", projectId!).single();
      if (error) throw error;
      return data;
    },
    enabled: !!projectId,
  });

  useEffect(() => {
    if (project) setForm(project);
  }, [project]);

  const updateProject = useMutation({
    mutationFn: async (updates: Partial<Project>) => {
      const { error } = await supabase.from("projects").update(updates).eq("id", projectId!);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast({ title: "Saved", description: "Project updated successfully" });
    },
    onError: () => toast({ title: "Error", description: "Failed to save", variant: "destructive" }),
  });

  const handleSave = () => {
    const { id, created_at, updated_at, ...updates } = form as Project;
    updateProject.mutate(updates);
  };

  const update = (field: keyof Project, value: any) => setForm((prev) => ({ ...prev, [field]: value }));

  const totalDuration = (form.scene_count || 0) * (form.clip_duration_sec || 0);
  const durationWarning = totalDuration > 180;

  const platforms = (form.publish_platforms as Record<string, boolean>) || {};
  const publishDefaults = (form.publish_defaults as Record<string, any>) || {};

  const togglePlatform = (platform: string) => {
    update("publish_platforms", { ...platforms, [platform]: !platforms[platform] });
  };

  const updatePublishDefault = (platform: string, key: string, value: any) => {
    update("publish_defaults", {
      ...publishDefaults,
      [platform]: { ...(publishDefaults[platform] || {}), [key]: value },
    });
  };

  if (isLoading) return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading...</div>;
  if (!project) return <div className="text-center text-muted-foreground py-12">Project not found</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <Input
            value={form.title || ""}
            onChange={(e) => update("title", e.target.value)}
            className="text-xl font-bold border-none bg-transparent px-0 h-auto text-foreground"
          />
        </div>
        <Button onClick={handleSave} disabled={updateProject.isPending}>
          <Save className="mr-2 h-4 w-4" />
          Save
        </Button>
      </div>

      <Tabs defaultValue="series">
        <TabsList className="grid w-full grid-cols-6">
          <TabsTrigger value="series">Series</TabsTrigger>
          <TabsTrigger value="image">Image</TabsTrigger>
          <TabsTrigger value="kling">Kling</TabsTrigger>
          <TabsTrigger value="publish">Publish</TabsTrigger>
          <TabsTrigger value="schedule">Schedule</TabsTrigger>
          <TabsTrigger value="api">API</TabsTrigger>
        </TabsList>

        <TabsContent value="series" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Series Configuration</CardTitle>
              <CardDescription>Define prompts and scene parameters</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Series Prompt</Label>
                <Textarea value={form.series_prompt || ""} onChange={(e) => update("series_prompt", e.target.value)} placeholder="Describe the series theme..." rows={4} />
              </div>
              <div className="space-y-2">
                <Label>Series Rules</Label>
                <Textarea value={form.series_rules || ""} onChange={(e) => update("series_rules", e.target.value)} placeholder="Rules for consistency..." rows={3} />
              </div>
              <div className="space-y-2">
                <Label>Negative Prompt</Label>
                <Input value={form.negative_prompt || ""} onChange={(e) => update("negative_prompt", e.target.value)} placeholder="What to avoid..." />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Scenes</Label>
                  <Input type="number" value={form.scene_count || 3} onChange={(e) => update("scene_count", parseInt(e.target.value))} min={1} max={20} />
                </div>
                <div className="space-y-2">
                  <Label>Clip Duration (s)</Label>
                  <Input type="number" value={form.clip_duration_sec || 10} onChange={(e) => update("clip_duration_sec", parseInt(e.target.value))} min={5} max={60} />
                </div>
                <div className="space-y-2">
                  <Label>Aspect Ratio</Label>
                  <Select value={form.aspect_ratio || "9:16"} onValueChange={(v) => update("aspect_ratio", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="9:16">9:16 (Vertical)</SelectItem>
                      <SelectItem value="16:9">16:9 (Horizontal)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Total duration:</span>
                <span className={durationWarning ? "text-destructive font-medium" : ""}>{totalDuration}s</span>
                {durationWarning && (
                  <span className="flex items-center gap-1 text-destructive">
                    <AlertTriangle className="h-3 w-3" /> Exceeds 180s Shorts/Reels limit
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="image" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Initial Image</CardTitle>
              <CardDescription>Seed image for consistent scene generation</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="border-2 border-dashed rounded-lg p-8 text-center">
                <p className="text-muted-foreground mb-2">Upload an initial image</p>
                <p className="text-xs text-muted-foreground mb-4">This image seeds all keyframe generation for visual consistency</p>
                <Button variant="outline">Choose File</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="kling" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Kling Configuration</CardTitle>
              <CardDescription>Image-to-video generation settings</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Model</Label>
                <Input value={form.kling_model_name || ""} onChange={(e) => update("kling_model_name", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Mode</Label>
                <Select value={form.kling_mode || "pro"} onValueChange={(v) => update("kling_mode", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pro">Pro</SelectItem>
                    <SelectItem value="std">Standard</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-3">
                <Switch checked={form.kling_sound || false} onCheckedChange={(v) => update("kling_sound", v)} />
                <Label>Enable Sound</Label>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="publish" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Upload-Post Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>API Key</Label>
                <div className="flex gap-2">
                  <Input type="password" placeholder="Enter Upload-Post API key" value={form.uploadpost_api_key_encrypted || ""} onChange={(e) => { update("uploadpost_api_key_encrypted", e.target.value); update("uploadpost_api_key_configured", !!e.target.value); }} />
                </div>
                <p className="text-xs text-muted-foreground">
                  Status: {form.uploadpost_api_key_configured ? "✅ Configured" : "❌ Not configured"}
                </p>
              </div>
              <div className="space-y-2">
                <Label>Profile Username</Label>
                <Input value={form.uploadpost_profile_username || ""} onChange={(e) => update("uploadpost_profile_username", e.target.value)} placeholder="Upload-Post profile username" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Platform Toggles</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {["tiktok", "instagram", "youtube", "facebook"].map((p) => (
                <div key={p} className="flex items-center justify-between">
                  <Label className="capitalize">{p}</Label>
                  <Switch checked={platforms[p] ?? true} onCheckedChange={() => togglePlatform(p)} />
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
                  <Select value={publishDefaults.tiktok?.privacy_level || "PUBLIC_TO_EVERYONE"} onValueChange={(v) => updatePublishDefault("tiktok", "privacy_level", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PUBLIC_TO_EVERYONE">Public</SelectItem>
                      <SelectItem value="MUTUAL_FOLLOW_FRIENDS">Friends</SelectItem>
                      <SelectItem value="SELF_ONLY">Private</SelectItem>
                    </SelectContent>
                  </Select>
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
                  <Select value={publishDefaults.youtube?.privacyStatus || "public"} onValueChange={(v) => updatePublishDefault("youtube", "privacyStatus", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="public">Public</SelectItem>
                      <SelectItem value="unlisted">Unlisted</SelectItem>
                      <SelectItem value="private">Private</SelectItem>
                    </SelectContent>
                  </Select>
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
                  <Select value={publishDefaults.facebook?.facebook_media_type || "VIDEO"} onValueChange={(v) => updatePublishDefault("facebook", "facebook_media_type", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="VIDEO">Video (Feed)</SelectItem>
                      <SelectItem value="REELS">Reels</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Facebook Page ID</Label>
                  <Input value={publishDefaults.facebook?.facebook_page_id || ""} onChange={(e) => updatePublishDefault("facebook", "facebook_page_id", e.target.value)} placeholder="Page ID" />
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="schedule" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Schedule</CardTitle>
              <CardDescription>Configure automated run scheduling</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Frequency</Label>
                <Select value={form.posting_frequency_type || "manual"} onValueChange={(v: any) => update("posting_frequency_type", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual</SelectItem>
                    <SelectItem value="interval_hours">Interval (hours)</SelectItem>
                    <SelectItem value="cron">Cron Expression</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.posting_frequency_type === "interval_hours" && (
                <div className="space-y-2">
                  <Label>Interval (hours)</Label>
                  <Input type="number" value={form.posting_interval_hours || ""} onChange={(e) => update("posting_interval_hours", parseInt(e.target.value))} min={1} />
                </div>
              )}
              {form.posting_frequency_type === "cron" && (
                <div className="space-y-2">
                  <Label>Cron Expression</Label>
                  <Input value={form.posting_cron || ""} onChange={(e) => update("posting_cron", e.target.value)} placeholder="0 */6 * * *" />
                </div>
              )}
              <div className="space-y-2">
                <Label>Timezone</Label>
                <Input value={form.timezone || "America/New_York"} onChange={(e) => update("timezone", e.target.value)} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="api" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Project Control API</CardTitle>
              <CardDescription>Token for external automation</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => {
                  const token = crypto.randomUUID();
                  const hint = token.slice(-4);
                  update("project_control_token_hash", token);
                  update("project_control_token_hint", hint);
                  navigator.clipboard.writeText(token);
                  toast({ title: "Token Generated", description: "Copied to clipboard. Save it — you won't see it again." });
                }}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Generate Token
                </Button>
                {form.project_control_token_hint && (
                  <span className="text-sm text-muted-foreground">Hint: ****{form.project_control_token_hint}</span>
                )}
              </div>
              <div className="space-y-2">
                <Label>Endpoints</Label>
                <div className="space-y-1 text-sm font-mono text-muted-foreground bg-muted p-3 rounded-md">
                  <p>POST /functions/v1/projects/{projectId}/trigger</p>
                  <p>POST /functions/v1/projects/{projectId}/pause</p>
                  <p>POST /functions/v1/projects/{projectId}/resume</p>
                  <p>POST /functions/v1/projects/{projectId}/stop</p>
                  <p>GET  /functions/v1/projects/{projectId}/status</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
