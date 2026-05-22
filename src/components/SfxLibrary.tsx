import { useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Play, Pause, Volume2 } from "lucide-react";
import { SFX_LIBRARY } from "@/data/sfxLibrary";
import { mediaUrl } from "@/lib/media";

// Audio-hook SFX preview library, surfaced in Settings. Plays royalty-free
// sound effects served from Cloudflare R2 (sfx/ prefix) so winners can be picked
// before wiring any of them into the finalize-video pipeline.
export function SfxLibrary() {
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const togglePlay = (r2Key: string) => {
    if (playingKey === r2Key) {
      audioRef.current?.pause();
      setPlayingKey(null);
      return;
    }
    if (audioRef.current) audioRef.current.pause();

    const audio = new Audio(mediaUrl(r2Key));
    audio.onended = () => setPlayingKey(null);
    audio.play();
    audioRef.current = audio;
    setPlayingKey(r2Key);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sound Effects — Hook Audio</CardTitle>
        <CardDescription>
          Royalty-free SFX options for opening-hook audio, grouped by type and target channel.
          Source: Mixkit Free License (commercial use, no attribution). Click to preview, then pick winners.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {SFX_LIBRARY.map((group) => (
          <div key={group.slug} className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold">{group.title}</h3>
              <Badge variant="secondary">{group.channel}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">{group.role}</p>
            <div className="space-y-2">
              {group.items.map((sfx) => {
                const isPlaying = playingKey === sfx.r2Key;
                return (
                  <div
                    key={sfx.r2Key}
                    className="flex items-center gap-3 p-2 rounded-md border border-border"
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      onClick={() => togglePlay(sfx.r2Key)}
                    >
                      {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </Button>
                    <Volume2 className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{sfx.label}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
