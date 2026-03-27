import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import type { Overlay } from "@/components/OverlayEditor";

const STYLES = [
  { value: "lower_third", label: "Lower Third" },
  { value: "title_card", label: "Title Card" },
  { value: "subtitle", label: "Subtitle" },
  { value: "corner_badge", label: "Corner Badge" },
  { value: "watermark", label: "Watermark" },
];

const POSITIONS = [
  { value: "top_left", label: "Top Left" },
  { value: "top_center", label: "Top Center" },
  { value: "top_right", label: "Top Right" },
  { value: "center", label: "Center" },
  { value: "bottom_left", label: "Bottom Left" },
  { value: "bottom_center", label: "Bottom Center" },
  { value: "bottom_right", label: "Bottom Right" },
];

const CONTENT_MODES = [
  { value: "exact", label: "Exact text", desc: "Use the text you type below" },
  { value: "ai_generated", label: "AI generated", desc: "AI writes a single text from your prompt" },
  { value: "ai_sequence", label: "AI sequence", desc: "AI generates a timed sequence of changing text frames" },
];

interface Props {
  overlay: Overlay;
  onUpdate: (id: string, field: keyof Overlay, value: any) => void;
  onImageUpload: (overlayId: string, file: File) => void;
}

export function OverlayItemEditor({ overlay: ov, onUpdate, onImageUpload }: Props) {
  // Try parsing ai_sequence frames from content_text
  let sequenceFrames: Array<{ text: string; start_pct: number; end_pct: number }> = [];
  if (ov.content_mode === "ai_sequence" && ov.content_text) {
    try {
      sequenceFrames = JSON.parse(ov.content_text);
    } catch { /* not valid JSON yet */ }
  }

  return (
    <div className="p-4 pt-0 space-y-4 border-t border-border bg-muted/20">
      {/* Row 1: Type, Style, Position */}
      <div className="grid grid-cols-3 gap-3 pt-3">
        <div className="space-y-1">
          <Label className="text-xs">Type</Label>
          <Select value={ov.overlay_type} onValueChange={(v) => onUpdate(ov.id, "overlay_type", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="text">Text</SelectItem>
              <SelectItem value="image">Image/Logo</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Style</Label>
          <Select value={ov.style} onValueChange={(v) => onUpdate(ov.id, "style", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {STYLES.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Position</Label>
          <Select value={ov.position} onValueChange={(v) => onUpdate(ov.id, "position", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {POSITIONS.map((p) => (
                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Content mode selector */}
      {ov.overlay_type === "text" && (
        <div className="space-y-1">
          <Label className="text-xs">Content Mode</Label>
          <Select value={ov.content_mode} onValueChange={(v) => onUpdate(ov.id, "content_mode", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {CONTENT_MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  <div>
                    <span>{m.label}</span>
                    <span className="text-muted-foreground ml-2 text-xs">— {m.desc}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Content area based on mode */}
      {ov.overlay_type === "text" ? (
        ov.content_mode === "ai_sequence" ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Sequence Prompt</Label>
              <Textarea
                value={ov.content_prompt || ""}
                onChange={(e) => onUpdate(ov.id, "content_prompt", e.target.value)}
                placeholder="e.g. 'Show construction year progressing from 1887 to 1889, changing every 2 scenes. Use format: YEAR [year]'"
                rows={3}
              />
              <p className="text-[11px] text-muted-foreground">
                The AI will receive the full video context (scenes, concept) and generate a sequence of timed text frames that change throughout the video. Same style/position is used for all frames.
              </p>
            </div>
            {sequenceFrames.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs">Last Generated Sequence ({sequenceFrames.length} frames)</Label>
                <div className="bg-background rounded border border-border p-2 space-y-1 max-h-40 overflow-y-auto">
                  {sequenceFrames.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground font-mono w-16">{f.start_pct}%-{f.end_pct}%</span>
                      <span className="font-medium">{f.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : ov.content_mode === "ai_generated" ? (
          <div className="space-y-1">
            <Label className="text-xs">Prompt / Guidance for AI</Label>
            <Textarea
              value={ov.content_prompt || ""}
              onChange={(e) => onUpdate(ov.id, "content_prompt", e.target.value)}
              placeholder="e.g. 'Generate a project label like PROJECT: [CODENAME] | $[X]M'"
              rows={2}
            />
            {ov.content_text && (
              <p className="text-xs text-muted-foreground">Last generated: {ov.content_text}</p>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            <Label className="text-xs">Text Content</Label>
            <Textarea
              value={ov.content_text || ""}
              onChange={(e) => onUpdate(ov.id, "content_text", e.target.value)}
              placeholder="Enter the exact text to display"
              rows={2}
            />
          </div>
        )
      ) : (
        <div className="space-y-2">
          <Label className="text-xs">Overlay Image</Label>
          <Input
            type="file"
            accept="image/png,image/svg+xml,image/webp,image/x-icon,image/vnd.microsoft.icon"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onImageUpload(ov.id, file);
            }}
          />
          {ov.image_path && (
            <p className="text-xs text-muted-foreground">Current: {ov.image_path.split("/").pop()}</p>
          )}
        </div>
      )}

      {/* Timing */}
      <div className="space-y-2">
        <Label className="text-xs">Timing: {ov.start_pct}% – {ov.end_pct}% of video</Label>
        <div className="flex gap-3 items-center">
          <span className="text-xs text-muted-foreground w-10">Start</span>
          <Slider
            value={[ov.start_pct]}
            onValueChange={([v]) => onUpdate(ov.id, "start_pct", v)}
            min={0} max={100} step={5}
            className="flex-1"
          />
          <span className="text-xs w-8 text-right">{ov.start_pct}%</span>
        </div>
        <div className="flex gap-3 items-center">
          <span className="text-xs text-muted-foreground w-10">End</span>
          <Slider
            value={[ov.end_pct]}
            onValueChange={([v]) => onUpdate(ov.id, "end_pct", v)}
            min={0} max={100} step={5}
            className="flex-1"
          />
          <span className="text-xs w-8 text-right">{ov.end_pct}%</span>
        </div>
        {ov.content_mode === "ai_sequence" && (
          <p className="text-[11px] text-muted-foreground">
            The AI will subdivide this time window into individual frames.
          </p>
        )}
      </div>

      {/* Text styling */}
      {ov.overlay_type === "text" && (
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Font Size</Label>
            <Input
              type="number"
              value={ov.font_size || 48}
              onChange={(e) => onUpdate(ov.id, "font_size", parseInt(e.target.value))}
              min={12} max={120}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Font Color</Label>
            <div className="flex gap-2">
              <input
                type="color"
                value={ov.font_color || "#FFFFFF"}
                onChange={(e) => onUpdate(ov.id, "font_color", e.target.value)}
                className="h-10 w-10 rounded border border-input cursor-pointer"
              />
              <Input
                value={ov.font_color || "#FFFFFF"}
                onChange={(e) => onUpdate(ov.id, "font_color", e.target.value)}
                className="flex-1"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Background</Label>
            <Input
              value={ov.bg_color || "rgba(0,0,0,0.5)"}
              onChange={(e) => onUpdate(ov.id, "bg_color", e.target.value)}
              placeholder="rgba(0,0,0,0.5)"
            />
          </div>
        </div>
      )}
    </div>
  );
}
