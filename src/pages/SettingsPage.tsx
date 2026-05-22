import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Save, ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "@/hooks/use-toast";
import { TrackUploader } from "@/components/TrackUploader";
import { SfxLibrary } from "@/components/SfxLibrary";

export default function SettingsPage() {
  const [keys, setKeys] = useState({
    openai: "",
    gemini: "",
    kling: "",
    uploadpost: "",
  });

  const handleSave = () => {
    toast({ title: "Note", description: "API keys will be stored securely via Cloud secrets in a future update." });
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Global API key configuration</p>
      </div>

      <TrackUploader />

      <SfxLibrary />

      <Card>
        <CardHeader>
          <CardTitle>API Keys</CardTitle>
          <CardDescription>These will be stored securely as Cloud secrets</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {[
            { key: "openai" as const, label: "OpenAI API Key", placeholder: "sk-..." },
            { key: "gemini" as const, label: "Gemini API Key", placeholder: "AI..." },
            { key: "kling" as const, label: "Kling API Key", placeholder: "Enter key..." },
            { key: "uploadpost" as const, label: "Upload-Post API Key", placeholder: "Enter key..." },
          ].map(({ key, label, placeholder }) => (
            <div key={key} className="space-y-2">
              <Label>{label}</Label>
              <Input
                type="password"
                value={keys[key]}
                onChange={(e) => setKeys((prev) => ({ ...prev, [key]: e.target.value }))}
                placeholder={placeholder}
              />
            </div>
          ))}
          <Button onClick={handleSave}>
            <Save className="mr-2 h-4 w-4" />
            Save Keys
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Upload-Post Webhook</CardTitle>
          <CardDescription>Configure webhook for publish status updates</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label>Webhook URL</Label>
            <div className="flex gap-2">
              <Input readOnly value="/functions/v1/webhooks/uploadpost" className="font-mono text-sm" />
              <Button variant="outline" size="icon" onClick={() => {
                navigator.clipboard.writeText(window.location.origin + "/functions/v1/webhooks/uploadpost");
                toast({ title: "Copied" });
              }}>
                <ExternalLink className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Configure this URL in your Upload-Post notification settings
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
