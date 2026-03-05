import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Play, Pause, Music } from "lucide-react";

interface TrackSelectorProps {
  selectedTrackId: string | null;
  onSelect: (trackId: string | null) => void;
}

export function TrackSelector({ selectedTrackId, onSelect }: TrackSelectorProps) {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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

  const selectedTrack = tracks?.find((t) => t.id === selectedTrackId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Background Music</CardTitle>
        <CardDescription>
          Select a music track to replace the generated audio. Upload tracks in Settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Music Track</Label>
          <Select
            value={selectedTrackId || "none"}
            onValueChange={(v) => onSelect(v === "none" ? null : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="No music track" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No music (keep original audio)</SelectItem>
              {tracks?.map((track) => (
                <SelectItem key={track.id} value={track.id}>
                  <span className="flex items-center gap-2">
                    <Music className="h-3 w-3" />
                    {track.title}
                    {track.duration_sec && (
                      <span className="text-muted-foreground">
                        ({Math.floor(Number(track.duration_sec) / 60)}:{String(Math.floor(Number(track.duration_sec) % 60)).padStart(2, "0")})
                      </span>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selectedTrack && (
          <div className="flex items-center gap-3 p-3 rounded-md border border-border bg-muted/50">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => togglePlay(selectedTrack.supabase_path, selectedTrack.id)}
            >
              {playingId === selectedTrack.id ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </Button>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{selectedTrack.title}</p>
              <p className="text-xs text-muted-foreground">
                {selectedTrack.duration_sec
                  ? `${Math.floor(Number(selectedTrack.duration_sec) / 60)}:${String(Math.floor(Number(selectedTrack.duration_sec) % 60)).padStart(2, "0")}`
                  : "Unknown duration"}
              </p>
            </div>
          </div>
        )}

        {(!tracks || tracks.length === 0) && (
          <p className="text-xs text-muted-foreground">
            No tracks available. Go to Settings to upload MP3 files.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
