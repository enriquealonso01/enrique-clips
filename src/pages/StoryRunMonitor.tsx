import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StoryStatusBadge } from "@/components/story/StoryStatusBadge";
import { StoryRunStages } from "@/components/story/StoryRunStages";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft, Pause, Square, Play, Volume2, Image, Film, Music,
  FileText, Clock, Calendar, ExternalLink, RefreshCw, Send
} from "lucide-react";
import { useEffect, useState, useRef, useMemo } from "react";
import { toast } from "sonner";

// Asset type categories
const ASSET_CATEGORIES = {
  images: {
    label: "Images",
    icon: Image,
    types: ["real_image", "cast_reference_image", "scene_image", "emoji"],
  },
  clips: {
    label: "Video Clips",
    icon: Film,
    types: ["scene_video_raw", "scene_video_trimmed", "ending_visual_clip"],
  },
  audio: {
    label: "Audio",
    icon: Music,
    types: ["narration_audio", "background_music", "ending_audio", "ending_audio_trimmed"],
  },
  final: {
    label: "Final Output",
    icon: FileText,
    types: ["captioned_story_video", "final_video"],
  },
} as const;

function humanLabel(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function StoryRunMonitor() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();

  const { data: run, refetch } = useQuery({
    queryKey: ["story-run", runId],
    queryFn: async () => {
      const { data, error } = await supabase.from("story_runs").select("*").eq("id", runId!).single();
      if (error) throw error;
      return data;
    },
    enabled: !!runId,
    refetchInterval: 5000,
  });

  const { data: logs } = useQuery({
    queryKey: ["story-run-logs", runId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("story_run_logs")
        .select("*")
        .eq("run_id", runId!)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
    enabled: !!runId,
    refetchInterval: 5000,
  });

  const { data: assets, refetch: refetchAssets } = useQuery({
    queryKey: ["story-assets", runId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("story_assets")
        .select("*")
        .eq("run_id", runId!)
        .order("scene_index", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data;
    },
    enabled: !!runId,
    refetchInterval: 10000,
  });

  // Realtime subscription
  useEffect(() => {
    if (!runId) return;
    const channel = supabase
      .channel(`story-run-${runId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "story_runs", filter: `id=eq.${runId}` }, () => refetch())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "story_assets", filter: `run_id=eq.${runId}` }, () => refetchAssets())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [runId, refetch, refetchAssets]);

  const [acting, setActing] = useState(false);
  const [playingAssetId, setPlayingAssetId] = useState<string | null>(null);
  const [signingUrl, setSigningUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [loadingAudioId, setLoadingAudioId] = useState<string | null>(null);

  const getSignedUrl = async (path: string): Promise<string | null> => {
    const { data } = await supabase.storage.from("project-assets").createSignedUrl(path, 600);
    return data?.signedUrl || null;
  };

  const playAudio = async (assetPath: string, assetId: string) => {
    if (playingAssetId === assetId) {
      audioRef.current?.pause();
      setPlayingAssetId(null);
      return;
    }
    if (audioRef.current) audioRef.current.pause();
    const url = await getSignedUrl(assetPath);
    if (!url) { toast.error("Could not get audio URL"); return; }
    const audio = new Audio(url);
    audio.onended = () => setPlayingAssetId(null);
    audio.play();
    audioRef.current = audio;
    setPlayingAssetId(assetId);
  };

  const loadAudio = async (assetPath: string, assetId: string) => {
    if (audioUrls[assetId]) return;
    setLoadingAudioId(assetId);
    const url = await getSignedUrl(assetPath);
    if (url) setAudioUrls((prev) => ({ ...prev, [assetId]: url }));
    else toast.error("Could not get audio URL");
    setLoadingAudioId(null);
  };

  const [videoUrls, setVideoUrls] = useState<Record<string, string>>({});
  const playVideo = async (assetPath: string, assetId: string) => {
    if (videoUrls[assetId]) return;
    setSigningUrl(assetId);
    const url = await getSignedUrl(assetPath);
    if (url) setVideoUrls((prev) => ({ ...prev, [assetId]: url }));
    else toast.error("Could not get video URL");
    setSigningUrl(null);
  };

  // Categorized assets
  const categorized = useMemo(() => {
    if (!assets) return null;
    const result: Record<string, typeof assets> = {};
    for (const [catKey, cat] of Object.entries(ASSET_CATEGORIES)) {
      result[catKey] = assets.filter((a) => (cat.types as readonly string[]).includes(a.type));
    }
    return result;
  }, [assets]);

  const assetCounts = useMemo(() => {
    if (!categorized) return {};
    const counts: Record<string, number> = {};
    for (const [key, items] of Object.entries(categorized)) {
      counts[key] = items.length;
    }
    return counts;
  }, [categorized]);

  const isActive = run && !["failed", "cancelled", "published", "paused"].includes(run.status);
  const isPaused = run?.status === "paused";
  const isWaitingForOffPeak = isPaused && (run?.generated_metadata as any)?.waiting_for === "vidu_off_peak";
  const finalVideoPath = (run?.generated_metadata as any)?.final_video?.path
    || assets?.find((a) => a.type === "final_video")?.supabase_path;
  const canPostNow = !!finalVideoPath
    && run
    && ["failed", "publishing", "published", "cancelled"].includes(run.status);

  const postNow = async () => {
    if (!runId) return;
    setActing(true);
    try {
      // 1. Wipe prior publish_jobs so the idempotency guard in story-finalize
      //    lets the new submission through. Without this, the run will short-
      //    circuit and nothing will be posted.
      await supabase.from("publish_jobs")
        .update({ status: "failed" as any })
        .eq("run_id", runId)
        .in("status", ["submitted", "polling", "completed"] as any);

      // 2. Clear any stale scheduled-date metadata so we post immediately.
      const currentMeta = (run?.generated_metadata as any) || {};
      const cleanedMeta = { ...currentMeta };
      delete cleanedMeta.publish_scheduled_date;
      delete cleanedMeta.publish_timezone;
      delete cleanedMeta.publish_submitted_platforms;
      delete cleanedMeta.publish_retry_required;

      await supabase.from("story_runs").update({
        status: "publishing",
        current_stage: "publishing",
        error_message: null,
        finished_at: null,
        generated_metadata: cleanedMeta,
      }).eq("id", runId);
      const { error } = await supabase.functions.invoke("story-finalize", {
        body: {
          run_id: runId,
          publish_only: true,
          post_now: true,
          force_metadata: true,
          force_retry: true,
        },
      });
      if (error) throw error;
      toast.success("Post Now triggered — generating metadata and publishing");
      refetch();
    } catch (e: any) {
      toast.error(e.message || "Failed to trigger Post Now");
    } finally {
      setActing(false);
    }
  };

  const updateStatus = async (status: string) => {
    if (!runId) return;
    setActing(true);
    try {
      const fields: any = { status };
      if (status === "cancelled" || status === "failed") {
        fields.finished_at = new Date().toISOString();
        fields.error_message = status === "cancelled" ? "Cancelled by user" : run?.error_message;
      }
      const { error } = await supabase.from("story_runs").update(fields).eq("id", runId);
      if (error) throw error;
      toast.success(status === "cancelled" ? "Run cancelled" : status === "paused" ? "Run paused" : "Run resumed");
      refetch();
    } catch (e: any) {
      toast.error(e.message || "Failed to update run");
    } finally {
      setActing(false);
    }
  };

  if (!run) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading run...</div>;
  }

  const metadata = run.generated_metadata as any;
  const storyTitle = metadata?.story?.title;
  const storyHook = metadata?.story?.hook;
  const storySummary = metadata?.story?.summary || metadata?.story?.outline;
  const narrationScript = metadata?.narration_script;
  const realImageAsset = assets?.find((a) => a.type === "real_image");
  const realImageUrl = realImageAsset?.signed_url_last || metadata?.real_image?.primary_url;
  const sceneCount = metadata?.scene_prompts?.length || metadata?.beats?.length || 0;
  const totalDuration = metadata?.beats?.reduce((s: number, b: any) => s + (b.duration_sec || 0), 0) || 0;

  const elapsed = run.started_at && (run.finished_at || new Date().toISOString());
  const elapsedMs = elapsed ? new Date(run.finished_at || new Date()).getTime() - new Date(run.started_at).getTime() : 0;
  const elapsedStr = elapsedMs > 0 ? formatDuration(elapsedMs / 1000) : null;

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/stories/${run.project_id}`)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight truncate">
            {storyTitle || "Story Run"}
          </h1>
          <p className="text-xs text-muted-foreground font-mono">{runId}</p>
        </div>
        <StoryStatusBadge status={run.status} />
        <div className="ml-auto flex gap-2">
          {isPaused && (
            <Button size="sm" variant="outline" disabled={acting} onClick={() => updateStatus("queued")}>
              <Play className="h-4 w-4 mr-1" /> Resume
            </Button>
          )}
          {isActive && (
            <>
              <Button size="sm" variant="outline" disabled={acting} onClick={() => updateStatus("paused")}>
                <Pause className="h-4 w-4 mr-1" /> Pause
              </Button>
              <Button size="sm" variant="destructive" disabled={acting} onClick={() => updateStatus("cancelled")}>
                <Square className="h-4 w-4 mr-1" /> Cancel
              </Button>
            </>
          )}
          {canPostNow && (
            <Button size="sm" disabled={acting} onClick={postNow}>
              <Send className="h-4 w-4 mr-1" /> Post Now
            </Button>
          )}
        </div>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">Progress</p>
          <p className="text-2xl font-bold">{run.progress_pct}%</p>
          <Progress value={run.progress_pct} className="h-1 mt-1" />
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="h-3 w-3" /> Elapsed</p>
          <p className="text-2xl font-bold">{elapsedStr || "—"}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Film className="h-3 w-3" /> Scenes</p>
          <p className="text-2xl font-bold">{sceneCount || "—"}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Music className="h-3 w-3" /> Duration</p>
          <p className="text-2xl font-bold">{totalDuration > 0 ? formatDuration(totalDuration) : "—"}</p>
        </Card>
      </div>

      {/* Main content tabs */}
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="assets">
            Assets {assets && assets.length > 0 && <Badge variant="secondary" className="ml-1 h-5 text-xs">{assets.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="logs">
            Logs {logs && logs.length > 0 && <Badge variant="secondary" className="ml-1 h-5 text-xs">{logs.length}</Badge>}
          </TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {/* Pipeline stages */}
            <Card>
              <CardHeader><CardTitle className="text-base">Pipeline Stages</CardTitle></CardHeader>
              <CardContent>
                <StoryRunStages currentStage={run.current_stage} status={run.status} />
                {isWaitingForOffPeak && (
                  <div className="mt-3 flex items-center gap-2 p-3 rounded-md bg-muted text-muted-foreground text-sm">
                    <span className="animate-pulse">⏳</span>
                    <span>Waiting for off-peak Vidu clips (up to 48h). The pipeline will auto-resume when all clips are ready.</span>
                  </div>
                )}
                {run.error_message && (
                  <div className="mt-3 p-3 rounded-md bg-destructive/10 text-destructive text-sm">{run.error_message}</div>
                )}
              </CardContent>
            </Card>

            {/* Story info */}
            <Card>
              <CardHeader><CardTitle className="text-base">Story Details</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {storyTitle ? (
                  <>
                    <p className="font-medium">{storyTitle}</p>
                    {storyHook && <p className="text-sm text-muted-foreground italic">"{storyHook}"</p>}
                    {storySummary && <p className="text-sm text-muted-foreground mt-2">{typeof storySummary === 'string' ? storySummary : JSON.stringify(storySummary)}</p>}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Waiting for story discovery...</p>
                )}
                {realImageUrl && (
                  <div className="mt-3">
                    <p className="text-xs text-muted-foreground mb-1">Reference Image</p>
                    <a href={realImageUrl} target="_blank" rel="noopener noreferrer">
                      <img src={realImageUrl} alt="Story reference" className="rounded-md max-h-48 w-full object-cover border" crossOrigin="anonymous" />
                    </a>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Narration script */}
          {narrationScript && (
            <Card>
              <CardHeader><CardTitle className="text-base">Narration Script</CardTitle></CardHeader>
              <CardContent>
                {Array.isArray(narrationScript.beats) ? (
                  <div className="space-y-2">
                    {narrationScript.beats.map((beat: any, i: number) => (
                      <div key={i} className="flex gap-3 text-sm">
                        <Badge variant="outline" className="shrink-0 h-6">Beat {i + 1}</Badge>
                        <p className="text-muted-foreground">{beat.text || beat.narration || JSON.stringify(beat)}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                    {narrationScript.full_script || JSON.stringify(narrationScript, null, 2)}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Timestamps */}
          <Card>
            <CardHeader><CardTitle className="text-base">Timing</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Created</p>
                  <p>{new Date(run.created_at).toLocaleString()}</p>
                </div>
                {run.started_at && (
                  <div>
                    <p className="text-xs text-muted-foreground">Started</p>
                    <p>{new Date(run.started_at).toLocaleString()}</p>
                  </div>
                )}
                {run.finished_at && (
                  <div>
                    <p className="text-xs text-muted-foreground">Finished</p>
                    <p>{new Date(run.finished_at).toLocaleString()}</p>
                  </div>
                )}
                {elapsedStr && (
                  <div>
                    <p className="text-xs text-muted-foreground">Total Time</p>
                    <p className="font-medium">{elapsedStr}</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Assets Tab */}
        <TabsContent value="assets" className="space-y-4">
          {!assets || assets.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No assets generated yet
              </CardContent>
            </Card>
          ) : (
            Object.entries(ASSET_CATEGORIES).map(([catKey, cat]) => {
              const items = categorized?.[catKey];
              if (!items || items.length === 0) return null;
              const IconComp = cat.icon;
              return (
                <Card key={catKey}>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <IconComp className="h-4 w-4" />
                      {cat.label}
                      <Badge variant="secondary" className="ml-1">{items.length}</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {catKey === "images" && (
                      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4">
                        {items.map((a) => (
                          <div key={a.id} className="border rounded-lg overflow-hidden group">
                            {a.signed_url_last ? (
                              <a href={a.signed_url_last} target="_blank" rel="noopener noreferrer">
                                <img
                                  src={a.signed_url_last}
                                  alt={a.type}
                                  className="w-full aspect-[9/16] object-cover group-hover:opacity-90 transition-opacity"
                                  crossOrigin="anonymous"
                                />
                              </a>
                            ) : (
                              <div className="w-full aspect-[9/16] bg-muted flex items-center justify-center">
                                <Image className="h-6 w-6 text-muted-foreground" />
                              </div>
                            )}
                            <div className="p-2">
                              <p className="text-xs font-medium">{humanLabel(a.type)}</p>
                              {a.scene_index != null && (
                                <p className="text-xs text-muted-foreground">Scene {a.scene_index + 1}</p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {catKey === "clips" && (
                      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
                        {items.map((a) => (
                          <div key={a.id} className="border rounded-lg overflow-hidden">
                            {videoUrls[a.id] ? (
                              <video
                                src={videoUrls[a.id]}
                                controls
                                playsInline
                                preload="auto"
                                className="w-full aspect-[9/16] bg-black object-contain"
                              />
                            ) : (
                              <div className="w-full aspect-[9/16] bg-muted flex flex-col items-center justify-center gap-2">
                                <Film className="h-8 w-8 text-muted-foreground" />
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={signingUrl === a.id}
                                  onClick={() => playVideo(a.supabase_path, a.id)}
                                >
                                  {signingUrl === a.id ? (
                                    <><RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Loading...</>
                                  ) : (
                                    <><Play className="h-3 w-3 mr-1" /> Load Video</>
                                  )}
                                </Button>
                              </div>
                            )}
                            <div className="p-2">
                              <p className="text-xs font-medium">{humanLabel(a.type)}</p>
                              {a.scene_index != null && (
                                <p className="text-xs text-muted-foreground">Scene {a.scene_index + 1}</p>
                              )}
                              {(a.metadata as any)?.duration_sec && (
                                <p className="text-xs text-muted-foreground">
                                  {formatDuration((a.metadata as any).duration_sec)}
                                </p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {catKey === "audio" && (
                      <div className="space-y-2">
                        {items.map((a) => (
                          <div key={a.id} className="border rounded-lg p-3 space-y-2">
                            <div className="flex items-center gap-3">
                              <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium">{humanLabel(a.type)}</p>
                                <p className="text-xs text-muted-foreground truncate">{a.supabase_path.split("/").pop()}</p>
                              </div>
                              {(a.metadata as any)?.duration_sec && (
                                <Badge variant="secondary" className="shrink-0">
                                  {formatDuration((a.metadata as any).duration_sec)}
                                </Badge>
                              )}
                            </div>
                            {audioUrls[a.id] ? (
                              <audio
                                src={audioUrls[a.id]}
                                controls
                                preload="metadata"
                                className="w-full"
                              />
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="w-full"
                                disabled={loadingAudioId === a.id}
                                onClick={() => loadAudio(a.supabase_path, a.id)}
                              >
                                {loadingAudioId === a.id ? (
                                  <><RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Loading...</>
                                ) : (
                                  <><Play className="h-3 w-3 mr-1" /> Load Audio</>
                                )}
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {catKey === "final" && (
                      <div className="grid gap-3 grid-cols-1">
                        {items.map((a) => (
                          <div key={a.id} className="border rounded-lg overflow-hidden">
                            {videoUrls[a.id] ? (
                              <video
                                src={videoUrls[a.id]}
                                controls
                                playsInline
                                preload="auto"
                                className="w-full max-h-[500px] bg-black object-contain"
                              />
                            ) : (
                              <div className="w-full aspect-video bg-muted flex flex-col items-center justify-center gap-2">
                                <Film className="h-10 w-10 text-muted-foreground" />
                                <Button
                                  size="sm"
                                  disabled={signingUrl === a.id}
                                  onClick={() => playVideo(a.supabase_path, a.id)}
                                >
                                  {signingUrl === a.id ? (
                                    <><RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Loading...</>
                                  ) : (
                                    <><Play className="h-4 w-4 mr-1" /> Load Final Video</>
                                  )}
                                </Button>
                              </div>
                            )}
                            <div className="p-3">
                              <p className="text-sm font-medium">{humanLabel(a.type)}</p>
                              <p className="text-xs text-muted-foreground">{new Date(a.created_at).toLocaleString()}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })
          )}
        </TabsContent>

        {/* Logs Tab */}
        <TabsContent value="logs">
          <Card>
            <CardHeader><CardTitle className="text-base">Pipeline Logs</CardTitle></CardHeader>
            <CardContent>
              {logs && logs.length > 0 ? (
                <div className="space-y-1 max-h-[500px] overflow-y-auto font-mono text-xs">
                  {logs.map((log) => (
                    <div key={log.id} className="flex gap-2">
                      <span className="text-muted-foreground shrink-0">
                        {new Date(log.created_at).toLocaleTimeString()}
                      </span>
                      <span
                        className={
                          log.level === "error"
                            ? "text-destructive"
                            : log.level === "warn"
                            ? "text-yellow-500"
                            : "text-foreground"
                        }
                      >
                        [{log.level}] {log.message}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No logs yet</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
