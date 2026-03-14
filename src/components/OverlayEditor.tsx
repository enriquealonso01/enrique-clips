import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Plus, Trash2, GripVertical, Layers, Type, Image as ImageIcon, Film } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { useState } from "react";
import { OverlayPreview } from "./overlay/OverlayPreview";
import { OverlayItemEditor } from "./overlay/OverlayItemEditor";

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
  source: string;
}

export type { Overlay };

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
                Add text, image, or AI-sequenced overlays to your final video.
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
                <div key={ov.id} className="border border-border rounded-lg overflow-hidden">
                  {/* Collapsed header */}
                  <div
                    className="flex items-center gap-3 p-3 cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => setExpandedId(expandedId === ov.id ? null : ov.id)}
                  >
                    <GripVertical className="h-4 w-4 text-muted-foreground" />
                    <span className="text-xs font-mono text-muted-foreground">#{idx + 1}</span>
                    {ov.content_mode === "ai_sequence" ? (
                      <Film className="h-4 w-4 text-primary" />
                    ) : ov.overlay_type === "text" ? (
                      <Type className="h-4 w-4 text-primary" />
                    ) : (
                      <ImageIcon className="h-4 w-4 text-primary" />
                    )}
                    <span className="text-sm font-medium flex-1 truncate">
                      {ov.content_mode === "ai_sequence"
                        ? (ov.content_prompt ? `Sequence: ${ov.content_prompt.substring(0, 50)}…` : "AI Sequence (no prompt)")
                        : ov.content_text || (ov.content_mode === "ai_generated" ? "AI-generated content" : "Empty overlay")}
                    </span>
                    {(ov as any).source === "json_config" && (
                      <span className="text-[10px] bg-accent text-accent-foreground px-1.5 py-0.5 rounded font-mono">JSON</span>
                    )}
                    <span className="text-xs text-muted-foreground capitalize">
                      {ov.content_mode === "ai_sequence" ? "sequence" : ov.style.replace("_", " ")} · {ov.position.replace("_", " ")}
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
                    <OverlayItemEditor
                      overlay={ov}
                      onUpdate={handleUpdate}
                      onImageUpload={handleImageUpload}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {overlays && overlays.length > 0 && <OverlayPreview overlays={overlays} />}
    </div>
  );
}
