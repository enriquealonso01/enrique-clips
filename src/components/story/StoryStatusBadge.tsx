import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STORY_STATUS_STYLES: Record<string, string> = {
  queued: "bg-muted text-muted-foreground",
  researching_story: "bg-warning text-warning-foreground",
  story_selected: "bg-primary text-primary-foreground",
  cast_generated: "bg-primary text-primary-foreground",
  narration_generated: "bg-primary text-primary-foreground",
  beats_extracted: "bg-primary text-primary-foreground",
  scene_images_generating: "bg-warning text-warning-foreground",
  scenes_generating: "bg-warning text-warning-foreground",
  audio_mixing: "bg-warning text-warning-foreground",
  subtitles_processing: "bg-warning text-warning-foreground",
  end_card_rendering: "bg-warning text-warning-foreground",
  ready_to_publish: "bg-success text-success-foreground",
  publishing: "bg-warning text-warning-foreground",
  published: "bg-success text-success-foreground",
  paused: "bg-secondary text-secondary-foreground",
  failed: "bg-destructive text-destructive-foreground",
  cancelled: "bg-secondary text-secondary-foreground",
};

export function StoryStatusBadge({ status }: { status: string }) {
  return (
    <Badge className={cn("capitalize", STORY_STATUS_STYLES[status] || "bg-muted text-muted-foreground")}>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}
