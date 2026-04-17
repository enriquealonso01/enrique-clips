import { useEffect, useState } from "react";
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

const ALL_PLATFORMS = ["youtube", "facebook", "instagram", "tiktok"];

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

  // Auto-seed profiles from existing Projects + Story Projects that have an uploadpost username configured.
  // Respects user deletions: only auto-adds usernames that don't already exist in analytics_profiles.
  useEffect(() => {
    if (isLoading) return;
    let cancelled = false;
    (async () => {
      const [projRes, storyRes] = await Promise.all([
        supabase.from("projects").select("uploadpost_profile_username, title").not("uploadpost_profile_username", "is", null),
        supabase.from("story_projects").select("uploadpost_profile_username, title").not("uploadpost_profile_username", "is", null),
      ]);
      const collected = new Map<string, string>();
      for (const r of (projRes.data || [])) {
        const u = (r as any).uploadpost_profile_username?.trim();
        if (u && !collected.has(u)) collected.set(u, (r as any).title || u);
      }
      for (const r of (storyRes.data || [])) {
        const u = (r as any).uploadpost_profile_username?.trim();
        if (u && !collected.has(u)) collected.set(u, (r as any).title || u);
      }
      const existing = new Set(profiles.map((p: any) => p.profile_username));
      const toInsert = Array.from(collected.entries())
        .filter(([u]) => !existing.has(u))
        .map(([profile_username, display_name]) => ({ profile_username, display_name }));
      if (toInsert.length === 0 || cancelled) return;
      const { error } = await supabase.from("analytics_profiles").insert(toInsert);
      if (!error) {
        toast.success(`Auto-added ${toInsert.length} profile${toInsert.length > 1 ? "s" : ""} from your projects`);
        qc.invalidateQueries({ queryKey: ["analytics-profiles"] });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);


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

  const PLATFORM_STYLES: Record<string, string> = {
    youtube: "data-[active=true]:bg-rose-500/15 data-[active=true]:text-rose-600 data-[active=true]:border-rose-500/40",
    facebook: "data-[active=true]:bg-blue-500/15 data-[active=true]:text-blue-600 data-[active=true]:border-blue-500/40",
    instagram: "data-[active=true]:bg-pink-500/15 data-[active=true]:text-pink-600 data-[active=true]:border-pink-500/40",
    tiktok: "data-[active=true]:bg-foreground/10 data-[active=true]:text-foreground data-[active=true]:border-foreground/30",
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-muted/30">
      <div className="container mx-auto p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl animate-fade-in">
        {/* Hero header */}
        <div className="relative overflow-hidden rounded-2xl border bg-card p-5 sm:p-6 shadow-sm">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-violet-500/5 pointer-events-none" />
          <div className="relative flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="h-9 w-9 rounded-xl bg-primary/10 ring-1 ring-primary/20 flex items-center justify-center">
                  <BarChart3 className="h-4.5 w-4.5 text-primary" />
                </div>
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Analytics</h1>
              </div>
              <p className="text-sm text-muted-foreground">Cross-platform performance for your tracked profiles.</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Select value={period} onValueChange={setPeriod}>
                <SelectTrigger className="w-[170px] bg-background/80 backdrop-blur"><SelectValue /></SelectTrigger>
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
        </div>

        {/* Platform filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] uppercase font-semibold tracking-wider text-muted-foreground mr-1">Platforms</span>
          {ALL_PLATFORMS.map((p) => {
            const active = selectedPlatforms.includes(p);
            return (
              <button
                key={p}
                data-active={active}
                onClick={() => togglePlatform(p)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-all capitalize ${
                  active ? "shadow-sm" : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                } ${PLATFORM_STYLES[p] || ""}`}
              >
                {p}
              </button>
            );
          })}
        </div>

        {isLoading ? (
          <Skeleton className="h-96 rounded-2xl" />
        ) : (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="flex flex-wrap h-auto bg-muted/60 p-1 rounded-xl">
              <TabsTrigger value="totals" className="rounded-lg data-[state=active]:shadow-sm">📊 Totals</TabsTrigger>
              {profiles.map((p) => (
                <TabsTrigger key={p.id} value={p.id} className="rounded-lg data-[state=active]:shadow-sm">
                  {p.display_name || p.profile_username}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="totals" className="mt-5 animate-fade-in">
              <TotalsTab profiles={profiles} period={period} />
            </TabsContent>

            {profiles.map((p) => (
              <TabsContent key={p.id} value={p.id} className="mt-5 animate-fade-in">
                <div className="flex items-center justify-between mb-4 px-1">
                  <div className="text-sm text-muted-foreground">
                    Profile <code className="text-foreground font-mono bg-muted px-1.5 py-0.5 rounded text-xs">{p.profile_username}</code>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => removeProfile(p.id, p.profile_username)} className="text-muted-foreground hover:text-destructive">
                    <Trash2 className="h-4 w-4 mr-1" /> Remove
                  </Button>
                </div>
                <ProfileTab username={p.profile_username} period={period} selectedPlatforms={selectedPlatforms} />
              </TabsContent>
            ))}
          </Tabs>
        )}
      </div>
    </div>
  );
}
