import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

export function AddProfileDialog() {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);
  const qc = useQueryClient();

  async function handleSave() {
    const u = username.trim();
    if (!u) { toast.error("Profile username is required"); return; }
    setSaving(true);
    const { error } = await supabase.from("analytics_profiles").insert({
      profile_username: u,
      display_name: displayName.trim() || null,
    });
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`Added profile: ${u}`);
    setUsername(""); setDisplayName(""); setOpen(false);
    qc.invalidateQueries({ queryKey: ["analytics-profiles"] });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline"><Plus className="h-4 w-4 mr-1" /> Add Profile</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Profile to Track</DialogTitle>
          <DialogDescription>Enter the Upload-Post profile username you want to track analytics for.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="username">Profile Username *</Label>
            <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. myprofile" />
          </div>
          <div>
            <Label htmlFor="display">Display Name (optional)</Label>
            <Input id="display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Friendly label" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Adding..." : "Add Profile"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
