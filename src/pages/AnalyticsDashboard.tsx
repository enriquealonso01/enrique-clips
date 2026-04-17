import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AddProfileDialog } from "@/components/analytics/AddProfileDialog";
import { ProfileTab } from "@/components/analytics/ProfileTab";
import { TotalsTab } from "@/components/analytics/TotalsTab";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, BarChart3 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";

const ALL_PLATFORMS = ["instagram", "tiktok", "youtube", "facebook", "linkedin", "x", "threads", "pinterest", "reddit", "bluesky"];

export default function AnalyticsDashboard() {
  const qc = useQueryClient();
  const [period, setPeriod] = useState("last_month");
  const [activeTab, setActiveTab] = useState("totals");
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(ALL_PLATFORMS);

  const { data: profiles = [], isLoading } = useQuery({
    queryKey: ["analytics-profiles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("analytics_profiles")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });

  async function removeProfile(id: string, username: string) {
    if (!confirm(`Remove "${username}" from analytics tracking?`)) return;
    const { error } = await supabase.from("analytics_profiles").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    toast.success(`Removed ${username}`);
    qc.invalidateQueries({ queryKey: ["analytics-profiles"] });
    if (activeTab === id) setActiveTab("totals");
  }

  function togglePlatform(p: string) {
    setSelectedPlatforms((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]);
  }

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-4 max-w-7xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BarChart3 className="h-6 w-6 text-primary" /> Analytics
          </h1>
          <p className="text-sm text-muted-foreground">Cross-platform performance for your tracked profiles.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="last_day">Last day</SelectItem>
              <SelectItem value="last_week">Last week</SelectItem>
              <SelectItem value="last_month">Last 30 days</SelectItem>
              <SelectItem value="last_3months">Last 3 months</SelectItem>
              <SelectItem value="last_year">Last year</SelectItem>
            </SelectContent>
          </Select>
          <AddProfileDialog />
        </div>
      </div>

      {/* Platform filter chips (only used by per-profile view) */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-muted-foreground mr-1">Platforms:</span>
        {ALL_PLATFORMS.map((p) => (
          <Badge
            key={p}
            variant={selectedPlatforms.includes(p) ? "default" : "outline"}
            className="cursor-pointer capitalize"
            onClick={() => togglePlatform(p)}
          >
            {p}
          </Badge>
        ))}
      </div>

      {isLoading ? (
        <Skeleton className="h-96" />
      ) : (
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="flex flex-wrap h-auto">
            <TabsTrigger value="totals">Totals</TabsTrigger>
            {profiles.map((p) => (
              <TabsTrigger key={p.id} value={p.id}>
                {p.display_name || p.profile_username}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="totals" className="mt-4">
            <TotalsTab profiles={profiles} period={period} />
          </TabsContent>

          {profiles.map((p) => (
            <TabsContent key={p.id} value={p.id} className="mt-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm text-muted-foreground">
                  Username: <code className="text-foreground font-mono">{p.profile_username}</code>
                </div>
                <Button variant="ghost" size="sm" onClick={() => removeProfile(p.id, p.profile_username)}>
                  <Trash2 className="h-4 w-4 mr-1" /> Remove
                </Button>
              </div>
              <ProfileTab username={p.profile_username} period={period} selectedPlatforms={selectedPlatforms} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
