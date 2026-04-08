import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { StatusBadge } from "@/components/StatusBadge";
import { ArrowLeft, Save, RefreshCw, AlertTriangle, ImageIcon, ChevronDown, RotateCcw, Wand2, Bot, Loader2, History, Clock, CheckCircle2, XCircle } from "lucide-react";
import { TrackSelector } from "@/components/TrackSelector";
import { OverlayEditor } from "@/components/OverlayEditor";
import { MemorySourceProjects } from "@/components/MemorySourceProjects";
import { ScheduleManager } from "@/components/ScheduleManager";
import { toast } from "@/hooks/use-toast";
import { useState, useEffect, useMemo } from "react";
import type { Tables } from "@/integrations/supabase/types";
import {
  getDefaultPromptConfig,
  validatePromptConfig,
  legacyFieldsToPromptConfig,
  buildResolvedPromptConfig,
  mergePromptConfig,
} from "@/lib/promptConfig";

type Project = Tables<"projects">;

async function hashTokenSHA256(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default function ProjectEditor() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Partial<Project & { prompt_config_json?: any }>>({});
  const [customKlingModel, setCustomKlingModel] = useState(false);
  const [promptConfigText, setPromptConfigText] = useState("");
  const [promptConfigErrors, setPromptConfigErrors] = useState<string[]>([]);
  const [resolvedPreviewOpen, setResolvedPreviewOpen] = useState(false);
  const [aiFeedback, setAiFeedback] = useState("");
  const [aiFixLoading, setAiFixLoading] = useState(false);
  const [aiRerunAfterFix, setAiRerunAfterFix] = useState(false);
  const [aiFixOpen, setAiFixOpen] = useState(false);
  const [aiFixLogs, setAiFixLogs] = useState<string[]>([]);
  const [showFixHistory, setShowFixHistory] = useState(false);

  const { data: project, isLoading } = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => {
      const { data, error } = await supabase.from("projects").select("*").eq("id", projectId!).single();
      if (error) throw error;
      return data;
    },
    enabled: !!projectId,
  });

  // Fetch runs for this project
  const { data: runs } = useQuery({
    queryKey: ["project-runs", projectId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("runs")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data;
    },
    enabled: !!projectId,
  });

  // Fetch AI fix history
  const { data: fixHistory, refetch: refetchFixHistory } = useQuery({
    queryKey: ["ai-fix-history", projectId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_fix_history" as any)
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data as any[];
    },
    enabled: !!projectId && showFixHistory,
    refetchInterval: showFixHistory ? 5000 : false,
  });

  const KLING_PRESETS = ["kling-v1", "kling-v1-5", "kling-v1-6", "kling-v2-master", "kling-v2-1", "kling-v2-1-master", "kling-v2-5-turbo", "kling-v2-6"];

  useEffect(() => {
    if (project) {
      setForm(project);
      if (project.kling_model_name && !KLING_PRESETS.includes(project.kling_model_name)) {
        setCustomKlingModel(true);
      }
      // Init prompt config text from project
      const pcj = (project as any).prompt_config_json;
      setPromptConfigText(pcj ? JSON.stringify(pcj, null, 2) : "");
      setPromptConfigErrors([]);
    }
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
    const { id, created_at, updated_at, ...updates } = form as any;

    // Validate and attach prompt config JSON if present
    if (promptConfigText.trim()) {
      try {
        const parsed = JSON.parse(promptConfigText);
        const validation = validatePromptConfig(parsed);
        if (!validation.valid) {
          setPromptConfigErrors(validation.errors);
          toast({ title: "Validation Error", description: validation.errors[0], variant: "destructive" });
          return;
        }
        updates.prompt_config_json = parsed;
        setPromptConfigErrors([]);
      } catch (e: any) {
        setPromptConfigErrors([`Invalid JSON: ${e.message}`]);
        toast({ title: "Invalid JSON", description: e.message, variant: "destructive" });
        return;
      }
    } else {
      updates.prompt_config_json = null;
    }

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
    <div className="space-y-4 md:space-y-6 max-w-4xl">
      <div className="flex items-center gap-2 md:gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/")} className="shrink-0">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <Input
            value={form.title || ""}
            onChange={(e) => update("title", e.target.value)}
            className="text-lg md:text-xl font-bold border-none bg-transparent px-0 h-auto text-foreground"
          />
        </div>
        <Button onClick={handleSave} disabled={updateProject.isPending} size="sm" className="shrink-0">
          <Save className="mr-1 md:mr-2 h-4 w-4" />
          <span className="hidden sm:inline">Save</span>
        </Button>
      </div>

      <Tabs defaultValue="series">
        <TabsList className="flex flex-wrap h-auto gap-1 p-1">
          <TabsTrigger value="series" className="text-xs sm:text-sm">Series</TabsTrigger>
          <TabsTrigger value="video" className="text-xs sm:text-sm">Video</TabsTrigger>
          <TabsTrigger value="overlays" className="text-xs sm:text-sm">Overlays</TabsTrigger>
          <TabsTrigger value="publish" className="text-xs sm:text-sm">Publish</TabsTrigger>
          <TabsTrigger value="schedule" className="text-xs sm:text-sm">Schedule</TabsTrigger>
          <TabsTrigger value="api" className="text-xs sm:text-sm">API</TabsTrigger>
          <TabsTrigger value="runs" className="text-xs sm:text-sm">Runs</TabsTrigger>
          <TabsTrigger value="gallery" className="text-xs sm:text-sm" onClick={() => navigate(`/projects/${projectId}/gallery`)}>
            <ImageIcon className="h-3 w-3 mr-1" /> Gallery
          </TabsTrigger>
        </TabsList>

        {/* Series Tab */}
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
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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

          {/* Series Memory */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Series Memory
                <Switch
                  checked={(() => {
                    try {
                      const pcj = promptConfigText.trim() ? JSON.parse(promptConfigText) : {};
                      return pcj?.memory?.enabled || false;
                    } catch { return false; }
                  })()}
                  onCheckedChange={(checked) => {
                    try {
                      const pcj = promptConfigText.trim() ? JSON.parse(promptConfigText) : {};
                      if (!pcj.memory) pcj.memory = { enabled: false, instruction: "", lookback_count: 30 };
                      pcj.memory.enabled = checked;
                      if (!pcj.version) pcj.version = 1;
                      setPromptConfigText(JSON.stringify(pcj, null, 2));
                    } catch {}
                  }}
                />
              </CardTitle>
              <CardDescription>
                Feed the planner with memory of past videos to avoid repetition or continue themes. When enabled, the last N topic summaries are injected into the planning prompt.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {(() => {
                let memoryEnabled = false;
                let memoryInstruction = "";
                let lookbackCount = 30;
                let sourceProjectIds: string[] = [];
                try {
                  const pcj = promptConfigText.trim() ? JSON.parse(promptConfigText) : {};
                  memoryEnabled = pcj?.memory?.enabled || false;
                  memoryInstruction = pcj?.memory?.instruction || "";
                  lookbackCount = pcj?.memory?.lookback_count || 30;
                  sourceProjectIds = pcj?.memory?.source_project_ids || [];
                } catch {}

                if (!memoryEnabled) return <p className="text-sm text-muted-foreground">Enable the toggle above to configure memory.</p>;

                return (
                  <>
                    <div className="space-y-2">
                      <Label>Memory Instruction</Label>
                      <Textarea
                        value={memoryInstruction}
                        onChange={(e) => {
                          try {
                            const pcj = JSON.parse(promptConfigText || "{}");
                            pcj.memory.instruction = e.target.value;
                            setPromptConfigText(JSON.stringify(pcj, null, 2));
                          } catch {}
                        }}
                        placeholder="e.g. Do not repeat the construction landmarks shown in the last videos. Pick a different famous landmark each time."
                        rows={3}
                      />
                      <p className="text-xs text-muted-foreground">Tell the planner how to use the memory of past videos.</p>
                    </div>
                    <div className="space-y-2">
                      <Label>Lookback Count</Label>
                      <Input
                        type="number"
                        value={lookbackCount}
                        onChange={(e) => {
                          try {
                            const pcj = JSON.parse(promptConfigText || "{}");
                            pcj.memory.lookback_count = parseInt(e.target.value) || 30;
                            setPromptConfigText(JSON.stringify(pcj, null, 2));
                          } catch {}
                        }}
                        min={1}
                        max={100}
                      />
                      <p className="text-xs text-muted-foreground">How many past video topics to include (max 100).</p>
                    </div>
                    <MemorySourceProjects
                      currentProjectId={projectId!}
                      sourceProjectIds={sourceProjectIds}
                      onChange={(ids) => {
                        try {
                          const pcj = JSON.parse(promptConfigText || "{}");
                          if (!pcj.memory) pcj.memory = { enabled: true, instruction: "", lookback_count: 30 };
                          pcj.memory.source_project_ids = ids;
                          setPromptConfigText(JSON.stringify(pcj, null, 2));
                        } catch {}
                      }}
                    />
                  </>
                );
              })()}
            </CardContent>
          </Card>

          {/* Prompt Config JSON Editor */}
          <Card>
            <CardHeader>
              <CardTitle>Prompt Config JSON</CardTitle>
              <CardDescription>
                Advanced: override all pipeline prompts, rules, and settings via a single JSON configuration.
                If empty, the system uses legacy fields above + system defaults.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setPromptConfigText(JSON.stringify(getDefaultPromptConfig(), null, 2));
                    setPromptConfigErrors([]);
                  }}
                >
                  <RotateCcw className="mr-1 h-3 w-3" /> Reset to Default
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const legacy = legacyFieldsToPromptConfig({
                      series_prompt: form.series_prompt as string,
                      series_rules: form.series_rules as string,
                      negative_prompt: form.negative_prompt as string,
                    });
                    const merged = mergePromptConfig(getDefaultPromptConfig(), legacy);
                    setPromptConfigText(JSON.stringify(merged, null, 2));
                    setPromptConfigErrors([]);
                  }}
                >
                  <Wand2 className="mr-1 h-3 w-3" /> Generate from Legacy Fields
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    try {
                      const parsed = JSON.parse(promptConfigText);
                      setPromptConfigText(JSON.stringify(parsed, null, 2));
                    } catch (e: any) {
                      setPromptConfigErrors([`Invalid JSON: ${e.message}`]);
                    }
                  }}
                >
                  Pretty Print
                </Button>
              </div>
              <Textarea
                value={promptConfigText}
                onChange={(e) => {
                  setPromptConfigText(e.target.value);
                  setPromptConfigErrors([]);
                }}
                placeholder='Paste or edit JSON config here... Leave empty to use legacy fields.'
                rows={16}
                className="font-mono text-xs"
              />
              {promptConfigErrors.length > 0 && (
                <div className="text-sm text-destructive space-y-1">
                  {promptConfigErrors.map((err, i) => (
                    <p key={i}>⚠ {err}</p>
                  ))}
                </div>
              )}

              {/* Resolved Config Preview */}
              <Collapsible open={resolvedPreviewOpen} onOpenChange={setResolvedPreviewOpen}>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="w-full justify-between">
                    Resolved Config Preview
                    <ChevronDown className={`h-4 w-4 transition-transform ${resolvedPreviewOpen ? "rotate-180" : ""}`} />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-2 p-3 bg-muted rounded-md text-xs font-mono overflow-auto max-h-[400px]">
                    {JSON.stringify(
                      buildResolvedPromptConfig({
                        series_prompt: form.series_prompt as string,
                        series_rules: form.series_rules as string,
                        negative_prompt: form.negative_prompt as string,
                        prompt_config_json: promptConfigText.trim()
                          ? (() => { try { return JSON.parse(promptConfigText); } catch { return null; } })()
                          : null,
                      }),
                      null,
                      2
                    )}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            </CardContent>
          </Card>

          {/* AI Config Fix */}
          <Card>
            <CardHeader>
              <Collapsible open={aiFixOpen} onOpenChange={setAiFixOpen}>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" className="w-full justify-between p-0 h-auto">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Bot className="h-4 w-4" /> Fix Config with AI
                    </CardTitle>
                    <ChevronDown className={`h-4 w-4 transition-transform ${aiFixOpen ? "rotate-180" : ""}`} />
                  </Button>
                </CollapsibleTrigger>
                <CardDescription className="mt-1">
                  Describe what went wrong and let AI fix the config. You can close the app — it runs server-side.
                </CardDescription>
                <CollapsibleContent>
                  <CardContent className="px-0 pt-4 space-y-4">
                    <div className="space-y-2">
                      <Label>What went wrong?</Label>
                      <Textarea
                        value={aiFeedback}
                        onChange={(e) => setAiFeedback(e.target.value)}
                        placeholder="e.g. The workers appeared too early in scene 2, the camera was shaking, the reveal didn't feel dramatic enough..."
                        rows={4}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="ai-rerun"
                        checked={aiRerunAfterFix}
                        onCheckedChange={(checked) => setAiRerunAfterFix(checked === true)}
                      />
                      <Label htmlFor="ai-rerun" className="text-sm cursor-pointer">
                        Re-run pipeline without publishing after fix
                      </Label>
                    </div>
                    <Button
                      onClick={async () => {
                        if (!aiFeedback.trim()) {
                          toast({ title: "Error", description: "Please describe what went wrong", variant: "destructive" });
                          return;
                        }
                        setAiFixLoading(true);
                        setAiFixLogs(["🚀 Submitted to AI (server-side). You can leave the app."]);
                        try {
                          const { data, error } = await supabase.functions.invoke("fix-config", {
                            body: {
                              project_id: projectId,
                              user_feedback: aiFeedback,
                              rerun_after_fix: aiRerunAfterFix,
                              documentation: "See PROMPT_CONFIG_REFERENCE.md for the full schema. The JSON must follow the structure documented there.",
                            },
                          });
                          if (error) throw error;
                          if (data?.error) throw new Error(data.error);

                          setAiFixLogs(prev => [...prev, "✅ Server received the request. Check history for results."]);
                          setAiFeedback("");
                          toast({ title: "Submitted!", description: "AI is fixing the config server-side. Check history for results." });
                          // Refresh history
                          setShowFixHistory(true);
                          setTimeout(() => refetchFixHistory(), 2000);
                          // Also refresh project data after some time
                          setTimeout(() => queryClient.invalidateQueries({ queryKey: ["project", projectId] }), 10000);
                        } catch (err: any) {
                          setAiFixLogs(prev => [...prev, `❌ Failed: ${err.message}`]);
                          toast({ title: "AI Fix Failed", description: err.message, variant: "destructive" });
                        } finally {
                          setAiFixLoading(false);
                        }
                      }}
                      disabled={aiFixLoading || !aiFeedback.trim()}
                      className="w-full"
                    >
                      {aiFixLoading ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Submitting...</>
                      ) : (
                        <><Bot className="mr-2 h-4 w-4" /> Fix with AI</>
                      )}
                    </Button>
                    {aiFixLogs.length > 0 && (
                      <div className="mt-3 rounded-md border bg-muted/50 p-3 max-h-40 overflow-y-auto">
                        <p className="text-xs font-medium text-muted-foreground mb-1">Status</p>
                        {aiFixLogs.map((log, i) => (
                          <p key={i} className="text-xs font-mono text-foreground/80">{log}</p>
                        ))}
                      </div>
                    )}

                    {/* History Button */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setShowFixHistory(!showFixHistory);
                        if (!showFixHistory) refetchFixHistory();
                      }}
                      className="w-full"
                    >
                      <History className="mr-2 h-4 w-4" />
                      {showFixHistory ? "Hide" : "Show"} Feedback History
                    </Button>

                    {/* History List */}
                    {showFixHistory && (
                      <div className="space-y-2 mt-2">
                        {!fixHistory?.length && (
                          <p className="text-xs text-muted-foreground text-center py-4">No feedback submitted yet.</p>
                        )}
                        {fixHistory?.map((item: any) => (
                          <div key={item.id} className="rounded-md border p-3 space-y-1">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                {item.status === "completed" && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
                                {item.status === "failed" && <XCircle className="h-3.5 w-3.5 text-destructive" />}
                                {(item.status === "pending" || item.status === "processing") && <Clock className="h-3.5 w-3.5 text-yellow-500 animate-pulse" />}
                                <span className="text-xs font-medium capitalize">{item.status}</span>
                              </div>
                              <span className="text-xs text-muted-foreground">
                                {new Date(item.created_at).toLocaleString()}
                              </span>
                            </div>
                            <p className="text-xs text-foreground/80 line-clamp-3">{item.feedback}</p>
                            {item.error_message && (
                              <p className="text-xs text-destructive">Error: {item.error_message}</p>
                            )}
                            {item.rerun_triggered && item.run_id && (
                              <p className="text-xs text-muted-foreground">Re-run: {item.run_id.slice(0, 8)}...</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </CollapsibleContent>
              </Collapsible>
            </CardHeader>
          </Card>
        </TabsContent>

        {/* Video Generator Tab */}
        <TabsContent value="video" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Video Generator</CardTitle>
              <CardDescription>Choose which AI video model to use</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Generator</Label>
                <Select value={(form as any).video_generator || "kling"} onValueChange={(v) => update("video_generator" as any, v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                     <SelectItem value="kling">Kling AI</SelectItem>
                     <SelectItem value="pika">Pika 2.2 (via fal.ai)</SelectItem>
                     <SelectItem value="vidu">Vidu Q3 Turbo (via fal.ai)</SelectItem>
                     <SelectItem value="vidu_direct">Vidu Q3 Turbo (Direct API)</SelectItem>
                   </SelectContent>
                 </Select>
              </div>
            </CardContent>
          </Card>

          {/* Kling Settings */}
          {((form as any).video_generator || "kling") === "kling" && (
            <Card>
              <CardHeader>
                <CardTitle>Kling Configuration</CardTitle>
                <CardDescription>Image-to-video generation settings</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Model</Label>
                  <div className="flex gap-2">
                    <Select
                      value={customKlingModel ? "__custom__" : (form.kling_model_name || "kling-v1")}
                      onValueChange={(v) => {
                        if (v === "__custom__") {
                          setCustomKlingModel(true);
                          update("kling_model_name", "");
                        } else {
                          setCustomKlingModel(false);
                          update("kling_model_name", v);
                        }
                      }}
                    >
                      <SelectTrigger className="flex-1"><SelectValue placeholder="Select or type custom" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="kling-v1">Kling V1</SelectItem>
                        <SelectItem value="kling-v1-5">Kling V1.5</SelectItem>
                        <SelectItem value="kling-v1-6">Kling V1.6</SelectItem>
                        <SelectItem value="kling-v2-master">Kling V2 Master</SelectItem>
                        <SelectItem value="kling-v2-1">Kling V2.1</SelectItem>
                        <SelectItem value="kling-v2-1-master">Kling V2.1 Master</SelectItem>
                        <SelectItem value="kling-v2-5-turbo">Kling V2.5 Turbo</SelectItem>
                        <SelectItem value="kling-v2-6">Kling V2.6</SelectItem>
                        <SelectItem value="__custom__">Custom...</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {customKlingModel && (
                    <Input
                      value={form.kling_model_name || ""}
                      onChange={(e) => update("kling_model_name", e.target.value)}
                      placeholder="Enter custom model name, e.g. kling-v3-pro"
                      className="mt-1"
                      autoFocus
                    />
                  )}
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
          )}

          {/* Pika Settings */}
          {((form as any).video_generator || "kling") === "pika" && (
            <Card>
              <CardHeader>
                <CardTitle>Pika 2.2 Configuration</CardTitle>
                <CardDescription>Video generation via fal.ai</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Pika Model</Label>
                  <Select value={(form as any).pika_model || "pikaframes"} onValueChange={(v) => update("pika_model" as any, v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pikaframes">Pikaframes (keyframe-to-keyframe transitions)</SelectItem>
                      <SelectItem value="image-to-video">Image-to-Video (single image per clip)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Resolution</Label>
                  <Select value={(form as any).pika_resolution || "1080p"} onValueChange={(v) => update("pika_resolution" as any, v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="720p">720p</SelectItem>
                      <SelectItem value="1080p">1080p</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-xs text-muted-foreground">
                  {(form as any).pika_model === "image-to-video"
                    ? "Image-to-Video generates a 5s video from each keyframe image individually using a motion prompt."
                    : "Pikaframes generates smooth transitions between consecutive keyframe pairs (start→end, 5s each)."}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Background Music */}
          <TrackSelector projectId={projectId!} />

           {/* Vidu Settings (fal.ai) */}
           {((form as any).video_generator || "kling") === "vidu" && (
             <Card>
               <CardHeader>
                 <CardTitle>Vidu Q3 Turbo</CardTitle>
                 <CardDescription>Image-to-video generation via fal.ai</CardDescription>
               </CardHeader>
               <CardContent className="space-y-4">
                 <div className="space-y-2">
                   <Label>Resolution</Label>
                   <Select value={(form as any).pika_resolution || "720p"} onValueChange={(v) => update("pika_resolution" as any, v)}>
                     <SelectTrigger><SelectValue /></SelectTrigger>
                     <SelectContent>
                       <SelectItem value="360p">360p</SelectItem>
                       <SelectItem value="540p">540p</SelectItem>
                       <SelectItem value="720p">720p</SelectItem>
                       <SelectItem value="1080p">1080p</SelectItem>
                     </SelectContent>
                   </Select>
                 </div>
                 <div className="flex items-center gap-3">
                   <Switch checked={(form as any).kling_sound || false} onCheckedChange={(v) => update("kling_sound", v)} />
                   <Label>Enable Audio</Label>
                 </div>
                 <p className="text-xs text-muted-foreground">
                   Vidu Q3 Turbo generates a 5s video from each keyframe image. Supports audio generation with dialogue and sound effects.
                 </p>
               </CardContent>
             </Card>
           )}

           {/* Vidu Direct API Settings */}
           {((form as any).video_generator || "kling") === "vidu_direct" && (
             <Card>
               <CardHeader>
                 <CardTitle>Vidu Q3 Turbo (Direct API)</CardTitle>
                 <CardDescription>Image-to-video via platform.vidu.com — cheaper than fal.ai</CardDescription>
               </CardHeader>
               <CardContent className="space-y-4">
                 <div className="space-y-2">
                   <Label>Resolution</Label>
                   <Select value={(form as any).pika_resolution || "720p"} onValueChange={(v) => update("pika_resolution" as any, v)}>
                     <SelectTrigger><SelectValue /></SelectTrigger>
                     <SelectContent>
                       <SelectItem value="540p">540p</SelectItem>
                       <SelectItem value="720p">720p</SelectItem>
                       <SelectItem value="1080p">1080p</SelectItem>
                     </SelectContent>
                   </Select>
                 </div>
                 <div className="space-y-2">
                   <Label>Clip Duration (1–16s)</Label>
                   <Input
                     type="number"
                     value={form.clip_duration_sec || 5}
                     onChange={(e) => update("clip_duration_sec", Math.min(16, Math.max(1, parseInt(e.target.value) || 5)))}
                     min={1} max={16}
                   />
                 </div>
                 <div className="flex items-center gap-3">
                   <Switch checked={(form as any).kling_sound || false} onCheckedChange={(v) => update("kling_sound", v)} />
                   <Label>Enable Audio (dialogue + sound effects)</Label>
                 </div>
                 <p className="text-xs text-muted-foreground">
                   Uses viduq3-turbo model directly via Vidu API. $0.04/second (off-peak) or $0.08/second. Supports 1–16s clips at up to 1080p.
                 </p>
               </CardContent>
             </Card>
           )}
        </TabsContent>

        {/* Overlays Tab */}
        <TabsContent value="overlays" className="space-y-4 mt-4">
          <OverlayEditor projectId={projectId!} />
        </TabsContent>

        {/* Publish Tab */}
        <TabsContent value="publish" className="space-y-4 mt-4">
          <Card>
            <CardHeader><CardTitle>Upload-Post Configuration</CardTitle></CardHeader>
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
                <div className="flex items-center justify-between pt-2">
                  <div>
                    <Label>Facebook Image Post</Label>
                    <p className="text-xs text-muted-foreground">Post last keyframe as image post</p>
                  </div>
                  <Switch checked={form.facebook_image_post_enabled || false} onCheckedChange={(v) => update("facebook_image_post_enabled", v)} />
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Schedule Tab */}
        <TabsContent value="schedule" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Timezone</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Label>Project Timezone</Label>
                <Input value={form.timezone || "America/New_York"} onChange={(e) => update("timezone", e.target.value)} />
                <p className="text-xs text-muted-foreground">Schedule times are interpreted in this timezone.</p>
              </div>
            </CardContent>
          </Card>
          {projectId && <ScheduleManager projectId={projectId} timezone={form.timezone || "America/New_York"} />}
        </TabsContent>

        {/* API Tab */}
        <TabsContent value="api" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Project Control API</CardTitle>
              <CardDescription>Token for external automation</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={async () => {
                  const token = crypto.randomUUID();
                  const hint = token.slice(-4);
                  const hash = await hashTokenSHA256(token);
                  update("project_control_token_hash", hash);
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
                <div className="space-y-1 text-xs sm:text-sm font-mono text-muted-foreground bg-muted p-3 rounded-md overflow-x-auto">
                  <p className="whitespace-nowrap">POST /functions/v1/project-control?project_id={projectId}&action=trigger</p>
                  <p className="whitespace-nowrap">POST /functions/v1/project-control?project_id={projectId}&action=pause</p>
                  <p className="whitespace-nowrap">POST /functions/v1/project-control?project_id={projectId}&action=resume</p>
                  <p className="whitespace-nowrap">POST /functions/v1/project-control?project_id={projectId}&action=stop</p>
                  <p className="whitespace-nowrap">GET  /functions/v1/project-control?project_id={projectId}&action=status</p>
                </div>
                <p className="text-xs text-muted-foreground">Include header: <code className="bg-muted px-1 rounded">X-Project-Token: YOUR_TOKEN</code></p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Runs Tab */}
        <TabsContent value="runs" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Run History</CardTitle>
              <CardDescription>Recent runs for this project — each run generates its own initial image for visual consistency</CardDescription>
            </CardHeader>
            <CardContent>
              {runs && runs.length > 0 ? (
                <div className="space-y-2">
                  {runs.map((run) => (
                    <div
                      key={run.id}
                      className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between p-3 rounded-md border border-border hover:bg-muted/50 cursor-pointer transition-colors"
                      onClick={() => navigate(`/runs/${run.id}`)}
                    >
                      <div className="flex items-center gap-3">
                        <StatusBadge status={run.status} />
                        <span className="text-sm text-muted-foreground capitalize">{run.current_step}</span>
                      </div>
                      {(run as any).topic_summary && (
                        <p className="text-xs text-muted-foreground truncate max-w-[300px]" title={(run as any).topic_summary}>
                          📝 {(run as any).topic_summary}
                        </p>
                      )}
                      <div className="flex items-center gap-3 text-xs sm:text-sm text-muted-foreground">
                        <span>{run.progress_pct}%</span>
                        <span>{new Date(run.created_at).toLocaleString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-center text-muted-foreground py-8">No runs yet. Click "Run Now" from the projects list to start one.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
