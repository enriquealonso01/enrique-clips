import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Upload, Trash2, Play, Pause, Music } from "lucide-react";
import { toast } from "@/hooks/use-toast";

export function TrackUploader() {
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const { data: tracks, isLoading } = useQuery({
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

  const deleteMutation = useMutation({
    mutationFn: async (track: { id: string; supabase_path: string }) => {
      await supabase.storage.from("project-assets").remove([track.supabase_path]);
      const { error } = await supabase.from("tracks").delete().eq("id", track.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tracks"] });
      toast({ title: "Track deleted" });
    },
  });

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith(".mp3") && !file.type.includes("audio")) {
      toast({ title: "Error", description: "Please upload an MP3 file", variant: "destructive" });
      return;
    }

    setUploading(true);
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `tracks/${Date.now()}_${safeName}`;

      const { error: upErr } = await supabase.storage
        .from("project-assets")
        .upload(path, file, { contentType: "audio/mpeg", upsert: false });
      if (upErr) throw upErr;

      // Get duration from audio element
      const duration = await new Promise<number>((resolve) => {
        const audio = new Audio(URL.createObjectURL(file));
        audio.addEventListener("loadedmetadata", () => resolve(Math.round(audio.duration)));
        audio.addEventListener("error", () => resolve(0));
      });

      const title = file.name.replace(/\.[^.]+$/, "");
      const { error: dbErr } = await supabase.from("tracks").insert({
        title,
        filename: file.name,
        supabase_path: path,
        duration_sec: duration || null,
      });
      if (dbErr) throw dbErr;

      queryClient.invalidateQueries({ queryKey: ["tracks"] });
      toast({ title: "Track uploaded", description: title });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

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
        <CardTitle>Music Tracks</CardTitle>
        <CardDescription>Upload MP3 files to use as background music in your videos</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label htmlFor="track-upload" className="cursor-pointer">
            <div className="flex items-center gap-2">
              <Button variant="outline" disabled={uploading} asChild>
                <span>
                  <Upload className="h-4 w-4 mr-2" />
                  {uploading ? "Uploading..." : "Upload MP3"}
                </span>
              </Button>
            </div>
          </Label>
          <Input
            id="track-upload"
            type="file"
            accept=".mp3,audio/mpeg"
            onChange={handleUpload}
            className="hidden"
          />
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading tracks...</p>
        ) : tracks && tracks.length > 0 ? (
          <div className="space-y-2">
            {tracks.map((track) => (
              <div
                key={track.id}
                className="flex items-center gap-3 p-3 rounded-md border border-border"
              >
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  onClick={() => togglePlay(track.supabase_path, track.id)}
                >
                  {playingId === track.id ? (
                    <Pause className="h-4 w-4" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                </Button>
                <Music className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{track.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {track.duration_sec ? `${Math.floor(Number(track.duration_sec) / 60)}:${String(Math.floor(Number(track.duration_sec) % 60)).padStart(2, "0")}` : "—"}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-destructive hover:text-destructive"
                  onClick={() => deleteMutation.mutate({ id: track.id, supabase_path: track.supabase_path })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground py-4 text-center">No tracks uploaded yet</p>
        )}
      </CardContent>
    </Card>
  );
}
