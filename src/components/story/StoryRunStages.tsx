import { Check, Circle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const STAGES = [
  { key: "create_run", label: "Create Run" },
  { key: "researching_story", label: "Story Discovery" },
  { key: "story_selected", label: "Story Validated" },
  { key: "real_image", label: "Real Image" },
  { key: "cast_generated", label: "Cast Image" },
  { key: "narration_script", label: "Narration Script" },
  { key: "narration_generated", label: "Narrator MP3" },
  { key: "beats_extracted", label: "Beat Timing" },
  { key: "scene_prompts", label: "Scene Prompts" },
  { key: "scene_images_generating", label: "Scene Images" },
  { key: "scenes_generating", label: "Scene Clips" },
  { key: "audio_mixing", label: "Audio Mix" },
  { key: "subtitles_processing", label: "Subtitles" },
  { key: "end_card_rendering", label: "End Card" },
  { key: "ready_to_publish", label: "Ready" },
  { key: "publishing", label: "Publishing" },
  { key: "published", label: "Published" },
];

function getStageIndex(stage: string): number {
  const idx = STAGES.findIndex((s) => s.key === stage);
  return idx === -1 ? 0 : idx;
}

interface Props {
  currentStage: string;
  status: string;
}

export function StoryRunStages({ currentStage, status }: Props) {
  const currentIdx = getStageIndex(currentStage);
  const isFailed = status === "failed";
  const isPaused = status === "paused";

  return (
    <div className="space-y-1">
      {STAGES.map((stage, idx) => {
        const isDone = idx < currentIdx || status === "published";
        const isCurrent = idx === currentIdx && !isDone;
        const isActive = isCurrent && !isFailed && !isPaused;

        return (
          <div key={stage.key} className="flex items-center gap-2 text-sm">
            {isDone ? (
              <Check className="h-4 w-4 text-success shrink-0" />
            ) : isActive ? (
              <Loader2 className="h-4 w-4 text-warning animate-spin shrink-0" />
            ) : isCurrent && isFailed ? (
              <Circle className="h-4 w-4 text-destructive shrink-0" />
            ) : (
              <Circle className="h-4 w-4 text-muted-foreground/30 shrink-0" />
            )}
            <span
              className={cn(
                isDone && "text-muted-foreground",
                isCurrent && "font-medium",
                !isDone && !isCurrent && "text-muted-foreground/50"
              )}
            >
              {stage.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
