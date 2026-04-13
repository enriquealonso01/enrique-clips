import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Upload, X, Music, Image } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

interface Props {
  projectId: string;
  label: string;
  accept: string;
  currentPath: string | null;
  icon: "music" | "image";
  onUploaded: (path: string | null) => void;
}

export function StoryAssetUploader({ projectId, label, accept, currentPath, icon, onUploaded }: Props) {
  const [uploading, setUploading] = useState(false);
  const Icon = icon === "music" ? Music : Image;

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    const ext = file.name.split(".").pop();
    const path = `story-projects/${projectId}/${label.toLowerCase().replace(/\s+/g, "_")}_${Date.now()}.${ext}`;

    const { error } = await supabase.storage.from("project-assets").upload(path, file, { upsert: true });
    if (error) {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    } else {
      onUploaded(path);
      toast({ title: "Uploaded", description: `${label} uploaded successfully` });
    }
    setUploading(false);
  };

  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-2">
        <Icon className="h-4 w-4" />
        {label}
      </Label>
      {currentPath ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="truncate flex-1">{currentPath.split("/").pop()}</span>
          <Button size="sm" variant="ghost" onClick={() => onUploaded(null)}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      ) : (
        <div>
          <Button variant="outline" size="sm" disabled={uploading} asChild>
            <label className="cursor-pointer">
              <Upload className="mr-2 h-3 w-3" />
              {uploading ? "Uploading..." : "Upload"}
              <input type="file" accept={accept} className="hidden" onChange={handleUpload} />
            </label>
          </Button>
        </div>
      )}
    </div>
  );
}
