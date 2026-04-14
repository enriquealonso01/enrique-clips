import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StoryStatusBadge } from "@/components/story/StoryStatusBadge";
import { StoryRunStages } from "@/components/story/StoryRunStages";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Pause, Square, Play, Volume2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useEffect, useState, useRef } from "react";
import { toast } from "sonner";

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
        .limit(50);
      if (error) throw error;
      return data;
    },
    enabled: !!runId,
    refetchInterval: 5000,
  });

  const { data: assets } = useQuery({
    queryKey: ["story-assets", runId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("story_assets")
        .select("*")
        .eq("run_id", runId!)
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
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [runId, refetch]);

  const [acting, setActing] = useState(false);
  const [playingAssetId, setPlayingAssetId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const playAudio = async (assetPath: string, assetId: string) => {
    if (playingAssetId === assetId) {
      audioRef.current?.pause();
      setPlayingAssetId(null);
      return;
    }
    if (audioRef.current) audioRef.current.pause();
    const { data } = await supabase.storage.from("story-assets").createSignedUrl(assetPath, 300);
    if (!data?.signedUrl) { toast.error("Could not get audio URL"); return; }
    const audio = new Audio(data.signedUrl);
    audio.onended = () => setPlayingAssetId(null);
    audio.play();
    audioRef.current = audio;
    setPlayingAssetId(assetId);
  };

  const isActive = run && !["failed", "cancelled", "published", "paused"].includes(run.status);
  const isPaused = run?.status === "paused";

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
  const realImageAsset = assets?.find((a) => a.type === "real_image");
  const realImageUrl = realImageAsset?.signed_url_last || metadata?.real_image?.primary_url;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/stories/${run.project_id}`)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-xl font-bold tracking-tight">Story Run</h1>
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
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Progress</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <Progress value={run.progress_pct} className="h-2" />
            <p className="text-sm text-muted-foreground">{run.progress_pct}%</p>
            <StoryRunStages currentStage={run.current_stage} status={run.status} />
            {run.error_message && (
              <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{run.error_message}</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Story</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {storyTitle ? (
              <>
                <p className="font-medium">{storyTitle}</p>
                {storyHook && <p className="text-sm text-muted-foreground italic">"{storyHook}"</p>}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Waiting for story discovery...</p>
            )}
            {realImageUrl && (
              <div className="mt-3">
                <p className="text-xs text-muted-foreground mb-1">Real Image</p>
                <a href={realImageUrl} target="_blank" rel="noopener noreferrer">
                  <img src={realImageUrl} alt="Story reference" className="rounded-md max-h-64 w-full object-cover border" crossOrigin="anonymous" />
                </a>
                <p className="text-xs text-muted-foreground mt-1 truncate">{realImageUrl}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Assets */}
      {assets && assets.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Assets</CardTitle></CardHeader>
          <CardContent>
            <div className="grid gap-2 grid-cols-2 sm:grid-cols-3">
              {assets.map((a) => {
                const isAudio = ["narration_audio", "background_music", "ending_audio", "ending_audio_trimmed"].includes(a.type);
                return (
                  <div key={a.id} className="border rounded-md p-2 text-xs">
                    <span className="font-medium capitalize">{a.type.replace(/_/g, " ")}</span>
                    {a.signed_url_last && a.type.includes("image") && (
                      <img src={a.signed_url_last} alt={a.type} className="mt-1 rounded max-h-24 object-cover" />
                    )}
                    {isAudio && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-1 h-7 w-full text-xs"
                        onClick={() => playAudio(a.supabase_path, a.id)}
                      >
                        {playingAssetId === a.id ? <Pause className="h-3 w-3 mr-1" /> : <Volume2 className="h-3 w-3 mr-1" />}
                        {playingAssetId === a.id ? "Stop" : "Play"}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Logs */}
      <Card>
        <CardHeader><CardTitle>Logs</CardTitle></CardHeader>
        <CardContent>
          {logs && logs.length > 0 ? (
            <div className="space-y-1 max-h-64 overflow-y-auto font-mono text-xs">
              {logs.map((log) => (
                <div key={log.id} className="flex gap-2">
                  <span className="text-muted-foreground shrink-0">{new Date(log.created_at).toLocaleTimeString()}</span>
                  <span className={log.level === "error" ? "text-destructive" : log.level === "warn" ? "text-warning" : "text-foreground"}>
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
    </div>
  );
}
