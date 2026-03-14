import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Overlay } from "@/components/OverlayEditor";
import React from "react";

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

interface Props {
  overlays: Overlay[];
}

export function OverlayPreview({ overlays }: Props) {
  return (
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
            if (ov.overlay_type !== "text") return null;

            // For ai_sequence, show first frame if available
            if (ov.content_mode === "ai_sequence") {
              let frames: Array<{ text: string }> = [];
              try { frames = JSON.parse(ov.content_text || "[]"); } catch {}
              if (frames.length === 0) return null;
              const posStyles = getPositionStyles(ov.position);
              return (
                <div
                  key={ov.id}
                  className="absolute px-2 py-1 rounded text-center max-w-[60%]"
                  style={{
                    ...posStyles,
                    fontSize: Math.max(8, (ov.font_size || 48) / 4),
                    color: ov.font_color || "#FFFFFF",
                    backgroundColor: ov.bg_color || "rgba(0,0,0,0.5)",
                    zIndex: ov.z_index,
                    wordBreak: "break-word",
                  }}
                >
                  {frames[0].text}
                  <span className="ml-1 text-[8px] opacity-60">+{frames.length - 1}</span>
                </div>
              );
            }

            if (!ov.content_text) return null;
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
  );
}
