import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2, GripVertical, Layers, Type, Image as ImageIcon } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { useState } from "react";

interface Overlay {
  id: string;
  project_id: string;
  overlay_type: string;
  style: string;
  content_text: string | null;
  content_prompt: string | null;
  content_mode: string;
  position: string;
  start_pct: number;
  end_pct: number;
  z_index: number;
  font_size: number | null;
  font_color: string | null;
  bg_color: string | null;
  image_path: string | null;
  sort_order: number;
}

const STYLES = [
  { value: "lower_third", label: "Lower Third", desc: "Name plate at bottom" },
  { value: "title_card", label: "Title Card", desc: "Centered large text" },
  { value: "subtitle", label: "Subtitle", desc: "Bottom centered caption" },
  { value: "corner_badge", label: "Corner Badge", desc: "Small badge in corner" },
  { value: "watermark", label: "Watermark", desc: "Semi-transparent overlay" },
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

interface OverlayEditorProps {
  projectId: string;
}

export function OverlayEditor({ projectId }: OverlayEditorProps) {
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: overlays, isLoading } = useQuery({
    queryKey: ["overlays", projectId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("overlays")
        .select("*")
        .eq("project_id", projectId)
        .order("sort_order");
      if (error) throw error;
      return data as unknown as Overlay[];
    },
  });

  const addOverlay = useMutation({
    mutationFn: async () => {
      const nextOrder = (overlays?.length || 0) + 1;
      const { error } = await supabase.from("overlays").insert({
        project_id: projectId,
        overlay_type: "text",
        style: "lower_third",
        content_text: "",
        content_mode: "exact",
        position: "bottom_center",
        start_pct: 0,
        end_pct: 100,
        z_index: nextOrder,
        font_size: 48,
        font_color: "#FFFFFF",
        bg_color: "rgba(0,0,0,0.5)",
        sort_order: nextOrder,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["overlays", projectId] });
      toast({ title: "Overlay added" });
    },
  });

  const updateOverlay = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<Overlay> }) => {
      const { error } = await supabase.from("overlays").update(updates as any).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["overlays", projectId] }),
  });

  const deleteOverlay = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("overlays").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["overlays", projectId] });
      toast({ title: "Overlay removed" });
    },
  });

  const handleUpdate = (id: string, field: keyof Overlay, value: any) => {
    updateOverlay.mutate({ id, updates: { [field]: value } });
  };

  // Upload image for image overlays
  const handleImageUpload = async (overlayId: string, file: File) => {
    const path = `overlays/${projectId}/${overlayId}/${file.name}`;
    const { error } = await supabase.storage.from("project-assets").upload(path, file, { upsert: true });
    if (error) {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
      return;
    }
    handleUpdate(overlayId, "image_path", path);
    toast({ title: "Image uploaded" });
  };

  if (isLoading) return <div className="text-muted-foreground text-sm">Loading overlays...</div>;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Layers className="h-5 w-5" /> Video Overlays
              </CardTitle>
              <CardDescription>
                Add text or image overlays to your final video. AI can generate content during the plan step.
              </CardDescription>
            </div>
            <Button onClick={() => addOverlay.mutate()} disabled={addOverlay.isPending} size="sm">
              <Plus className="h-4 w-4 mr-1" /> Add Overlay
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {(!overlays || overlays.length === 0) ? (
            <p className="text-center text-muted-foreground py-6 text-sm">
              No overlays configured. Add one to get started.
            </p>
          ) : (
            <div className="space-y-3">
              {overlays.map((ov, idx) => (
                <div
                  key={ov.id}
                  className="border border-border rounded-lg overflow-hidden"
                >
                  {/* Collapsed header */}
                  <div
                    className="flex items-center gap-3 p-3 cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => setExpandedId(expandedId === ov.id ? null : ov.id)}
                  >
                    <GripVertical className="h-4 w-4 text-muted-foreground" />
                    <span className="text-xs font-mono text-muted-foreground">#{idx + 1}</span>
                    {ov.overlay_type === "text" ? (
                      <Type className="h-4 w-4 text-primary" />
                    ) : (
                      <ImageIcon className="h-4 w-4 text-primary" />
                    )}
                    <span className="text-sm font-medium flex-1 truncate">
                      {ov.content_text || (ov.content_mode === "ai_generated" ? "AI-generated content" : "Empty overlay")}
                    </span>
                    <span className="text-xs text-muted-foreground capitalize">
                      {ov.style.replace("_", " ")} · {ov.position.replace("_", " ")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {ov.start_pct}%-{ov.end_pct}%
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteOverlay.mutate(ov.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>

                  {/* Expanded editor */}
                  {expandedId === ov.id && (
                    <div className="p-4 pt-0 space-y-4 border-t border-border bg-muted/20">
                      {/* Row 1: Type and Style */}
                      <div className="grid grid-cols-3 gap-3 pt-3">
                        <div className="space-y-1">
                          <Label className="text-xs">Type</Label>
                          <Select value={ov.overlay_type} onValueChange={(v) => handleUpdate(ov.id, "overlay_type", v)}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="text">Text</SelectItem>
                              <SelectItem value="image">Image/Logo</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Style</Label>
                          <Select value={ov.style} onValueChange={(v) => handleUpdate(ov.id, "style", v)}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {STYLES.map((s) => (
                                <SelectItem key={s.value} value={s.value}>
                                  {s.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Position</Label>
                          <Select value={ov.position} onValueChange={(v) => handleUpdate(ov.id, "position", v)}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {POSITIONS.map((p) => (
                                <SelectItem key={p.value} value={p.value}>
                                  {p.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      {/* Content mode toggle */}
                      <div className="flex items-center gap-3">
                        <Switch
                          checked={ov.content_mode === "ai_generated"}
                          onCheckedChange={(v) => {
                            handleUpdate(ov.id, "content_mode", v ? "ai_generated" : "exact");
                          }}
                        />
                        <Label className="text-sm">
                          {ov.content_mode === "ai_generated"
                            ? "AI generates content based on prompt/series context"
                            : "Use exact text below"}
                        </Label>
                      </div>

                      {/* Content */}
                      {ov.overlay_type === "text" ? (
                        ov.content_mode === "ai_generated" ? (
                          <div className="space-y-1">
                            <Label className="text-xs">Prompt / Guidance for AI</Label>
                            <Textarea
                              value={ov.content_prompt || ""}
                              onChange={(e) => handleUpdate(ov.id, "content_prompt", e.target.value)}
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
                              onChange={(e) => handleUpdate(ov.id, "content_text", e.target.value)}
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
                              if (file) handleImageUpload(ov.id, file);
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
                            onValueChange={([v]) => handleUpdate(ov.id, "start_pct", v)}
                            min={0}
                            max={100}
                            step={5}
                            className="flex-1"
                          />
                          <span className="text-xs w-8 text-right">{ov.start_pct}%</span>
                        </div>
                        <div className="flex gap-3 items-center">
                          <span className="text-xs text-muted-foreground w-10">End</span>
                          <Slider
                            value={[ov.end_pct]}
                            onValueChange={([v]) => handleUpdate(ov.id, "end_pct", v)}
                            min={0}
                            max={100}
                            step={5}
                            className="flex-1"
                          />
                          <span className="text-xs w-8 text-right">{ov.end_pct}%</span>
                        </div>
                      </div>

                      {/* Text styling */}
                      {ov.overlay_type === "text" && (
                        <div className="grid grid-cols-3 gap-3">
                          <div className="space-y-1">
                            <Label className="text-xs">Font Size</Label>
                            <Input
                              type="number"
                              value={ov.font_size || 48}
                              onChange={(e) => handleUpdate(ov.id, "font_size", parseInt(e.target.value))}
                              min={12}
                              max={120}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Font Color</Label>
                            <div className="flex gap-2">
                              <input
                                type="color"
                                value={ov.font_color || "#FFFFFF"}
                                onChange={(e) => handleUpdate(ov.id, "font_color", e.target.value)}
                                className="h-10 w-10 rounded border border-input cursor-pointer"
                              />
                              <Input
                                value={ov.font_color || "#FFFFFF"}
                                onChange={(e) => handleUpdate(ov.id, "font_color", e.target.value)}
                                className="flex-1"
                              />
                            </div>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Background</Label>
                            <Input
                              value={ov.bg_color || "rgba(0,0,0,0.5)"}
                              onChange={(e) => handleUpdate(ov.id, "bg_color", e.target.value)}
                              placeholder="rgba(0,0,0,0.5)"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Preview mockup */}
      {overlays && overlays.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Overlay Preview</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="relative bg-muted rounded-lg overflow-hidden" style={{ aspectRatio: "9/16", maxHeight: 300 }}>
              <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-xs">
                Video Preview
              </div>
              {overlays.map((ov) => {
                if (ov.overlay_type !== "text" || !ov.content_text) return null;
                const posStyles = getPositionStyles(ov.position);
                return (
                  <div
                    key={ov.id}
                    className="absolute px-2 py-1 rounded text-center max-w-[80%]"
                    style={{
                      ...posStyles,
                      fontSize: Math.max(8, (ov.font_size || 48) / 4),
                      color: ov.font_color || "#FFFFFF",
                      backgroundColor: ov.bg_color || "rgba(0,0,0,0.5)",
                      zIndex: ov.z_index,
                    }}
                  >
                    {ov.content_text}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function getPositionStyles(position: string): React.CSSProperties {
  const map: Record<string, React.CSSProperties> = {
    top_left: { top: 80, left: 8 },
    top_center: { top: 80, left: "50%", transform: "translateX(-50%)" },
    top_right: { top: 80, right: 8 },
    center: { top: "50%", left: "50%", transform: "translate(-50%, -50%)" },
    bottom_left: { bottom: 8, left: 8 },
    bottom_center: { bottom: 8, left: "50%", transform: "translateX(-50%)" },
    bottom_right: { bottom: 8, right: 8 },
  };
  return map[position] || map.bottom_center;
}
