import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Play, Pause, Music, Shuffle } from "lucide-react";

interface TrackSelectorProps {
  projectId: string;
}

export function TrackSelector({ projectId }: TrackSelectorProps) {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queryClient = useQueryClient();

  const { data: tracks } = useQuery({
    queryKey: ["tracks"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tracks")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: selectedTrackIds = [] } = useQuery({
    queryKey: ["project-tracks", projectId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("project_tracks")
        .select("track_id")
        .eq("project_id", projectId);
      if (error) throw error;
      return data.map((r) => r.track_id);
    },
    enabled: !!projectId,
  });

  const toggleTrack = useMutation({
    mutationFn: async (trackId: string) => {
      const isSelected = selectedTrackIds.includes(trackId);
      if (isSelected) {
        const { error } = await supabase
          .from("project_tracks")
          .delete()
          .eq("project_id", projectId)
          .eq("track_id", trackId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("project_tracks")
          .insert({ project_id: projectId, track_id: trackId });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-tracks", projectId] });
    },
  });

  const togglePlay = (trackPath: string, trackId: string) => {
    if (playingId === trackId) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    if (audioRef.current) audioRef.current.pause();
    const { data: urlData } = supabase.storage.from("project-assets").getPublicUrl(trackPath);
    const audio = new Audio(urlData.publicUrl);
    audio.onended = () => setPlayingId(null);
    audio.play();
    audioRef.current = audio;
    setPlayingId(trackId);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shuffle className="h-4 w-4" />
          Background Music
        </CardTitle>
        <CardDescription>
          Select one or more tracks. On each run, one will be chosen randomly. Upload tracks in Settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {(!tracks || tracks.length === 0) && (
          <p className="text-xs text-muted-foreground">
            No tracks available. Go to Settings to upload MP3 files.
          </p>
        )}

        {tracks?.map((track) => {
          const isSelected = selectedTrackIds.includes(track.id);
          return (
            <div
              key={track.id}
              className={`flex items-center gap-3 p-3 rounded-md border transition-colors ${
                isSelected ? "border-primary bg-primary/5" : "border-border bg-muted/30"
              }`}
            >
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => toggleTrack.mutate(track.id)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => togglePlay(track.supabase_path, track.id)}
              >
                {playingId === track.id ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
              </Button>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <Music className="h-3 w-3 text-muted-foreground" />
                  {track.title}
                </p>
                <p className="text-xs text-muted-foreground">
                  {track.duration_sec
                    ? `${Math.floor(Number(track.duration_sec) / 60)}:${String(Math.floor(Number(track.duration_sec) % 60)).padStart(2, "0")}`
                    : "Unknown duration"}
                </p>
              </div>
            </div>
          );
        })}

        {selectedTrackIds.length > 0 && (
          <p className="text-xs text-muted-foreground pt-2">
            {selectedTrackIds.length} track{selectedTrackIds.length !== 1 ? "s" : ""} selected — one will be picked randomly per run.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
