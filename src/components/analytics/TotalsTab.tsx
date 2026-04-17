import { useQueries } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getFacebookPageIdForUsername } from "@/lib/facebookPageId";
import { KpiCard } from "./KpiCard";
import { ChartTooltip } from "./ChartTooltip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart3, Users, Eye, MessageCircle, Heart, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend, AreaChart, Area,
} from "recharts";
import { useMemo } from "react";

interface ProfileRow { id: string; profile_username: string; display_name: string | null; }
interface Props { profiles: ProfileRow[]; period: string; }

const PLATFORM_COLORS: Record<string, string> = {
  youtube: "hsl(0 75% 55%)",
  facebook: "hsl(217 80% 55%)",
  instagram: "hsl(330 80% 60%)",
  tiktok: "hsl(180 70% 45%)",
};

// Per-platform field used as "views":
// - instagram: views, facebook: reach (Unique Reach), youtube: impressions (Video Views), tiktok: impressions (Video Views)
function getViews(platform: string, p: any): number {
  if (!p || typeof p !== "object") return 0;
  if (platform === "instagram") return Number(p.views) || 0;
  if (platform === "facebook") return Number(p.reach) || 0;
  return Number(p.impressions) || 0; // youtube + tiktok
}

function getViewsTimeseries(platform: string, p: any): Array<{ date: string; value: number }> {
  if (!p || typeof p !== "object") return [];
  // All platforms expose reach_timeseries. For YT/TT this represents views.
  const ts = Array.isArray(p.reach_timeseries) ? p.reach_timeseries : [];
  return ts.map((d: any) => ({ date: String(d.date), value: Number(d.value) || 0 }));
}

export function TotalsTab({ profiles, period: _period }: Props) {
  const profileQueries = useQueries({
    queries: profiles.map((p) => ({
      queryKey: ["profile-summary", p.profile_username],
      queryFn: async () => {
        const platforms = "youtube,facebook,instagram,tiktok";
        const pageId = await getFacebookPageIdForUsername(p.profile_username);
        const pageQs = pageId ? `&page_id=${encodeURIComponent(pageId)}` : "";
        const { data, error } = await supabase.functions.invoke(
          `upload-post-analytics?action=profile&username=${encodeURIComponent(p.profile_username)}&platforms=${encodeURIComponent(platforms)}${pageQs}`,
          { method: "GET" }
        );
        if (error) throw error;
        return { username: p.profile_username, data };
      },
      staleTime: 5 * 60 * 1000,
      retry: false,
    })),
  });

  const isLoading = profileQueries.some((q) => q.isLoading);

  const aggregates = useMemo(() => {
    let totalViews = 0, totalFollowers = 0, totalLikes = 0, totalComments = 0;
    const perPlatform: Record<string, { views: number; followers: number; likes: number; comments: number }> = {};
    const perDayByPlatform: Record<string, Record<string, number>> = {};
    const perProfile: Array<{ username: string; display: string; views: number; followers: number; likes: number; comments: number }> = [];

    profileQueries.forEach((q, idx) => {
      const profileMeta = profiles[idx];
      if (!q.data) return;
      const d: any = q.data.data;
      let pv = 0, pf = 0, pl = 0, pc = 0;
      for (const platform of Object.keys(d || {})) {
        const p = d[platform];
        if (!p || typeof p !== "object" || p.error) continue;
        const v = getViews(platform, p);
        const f = Number(p.followers) || 0;
        const l = Number(p.likes) || 0;
        const c = Number(p.comments) || 0;
        pv += v; pf += f; pl += l; pc += c;
        totalViews += v; totalFollowers += f; totalLikes += l; totalComments += c;
        if (!perPlatform[platform]) perPlatform[platform] = { views: 0, followers: 0, likes: 0, comments: 0 };
        perPlatform[platform].views += v;
        perPlatform[platform].followers += f;
        perPlatform[platform].likes += l;
        perPlatform[platform].comments += c;

        for (const point of getViewsTimeseries(platform, p)) {
          if (!perDayByPlatform[point.date]) perDayByPlatform[point.date] = {};
          perDayByPlatform[point.date][platform] = (perDayByPlatform[point.date][platform] || 0) + point.value;
        }
      }
      perProfile.push({
        username: profileMeta.profile_username,
        display: profileMeta.display_name || profileMeta.profile_username,
        views: pv, followers: pf, likes: pl, comments: pc,
      });
    });

    const platformOrder = ["youtube", "facebook", "instagram", "tiktok"];
    const platformChart = platformOrder
      .filter((p) => perPlatform[p])
      .map((p) => ({ platform: p, ...perPlatform[p] }));

    const dayChart = Object.keys(perDayByPlatform).sort().map((date) => {
      const row: any = { date };
      for (const plat of platformOrder) row[plat] = perDayByPlatform[date][plat] || 0;
      return row;
    });

    perProfile.sort((a, b) => b.views - a.views);

    return { totalViews, totalFollowers, totalLikes, totalComments, platformChart, dayChart, perProfile };
  }, [profileQueries, profiles]);

  async function copyTable(format: "tsv" | "md") {
    const rows = aggregates.perProfile;
    const header = ["Profile", "Views", "Followers", "Likes", "Comments"];
    const totalRow = ["TOTAL", aggregates.totalViews, aggregates.totalFollowers, aggregates.totalLikes, aggregates.totalComments];
    let text = "";
    if (format === "tsv") {
      text = [header.join("\t"), ...rows.map((r) => [r.display, r.views, r.followers, r.likes, r.comments].join("\t")), totalRow.join("\t")].join("\n");
    } else {
      const sep = "| " + header.map(() => "---").join(" | ") + " |";
      const line = (cells: any[]) => "| " + cells.join(" | ") + " |";
      text = [line(header), sep, ...rows.map((r) => line([r.display, r.views, r.followers, r.likes, r.comments])), line(totalRow)].join("\n");
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied as ${format.toUpperCase()}`);
    } catch {
      toast.error("Copy failed");
    }
  }


  if (profiles.length === 0) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-border p-12 text-center bg-card/50">
        <BarChart3 className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
        <p className="text-sm text-muted-foreground">Add a profile to see aggregated analytics across YouTube, Facebook, Instagram, and TikTok.</p>
      </div>
    );
  }

  const platformOrder = ["youtube", "facebook", "instagram", "tiktok"];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Total Views" value={aggregates.totalViews} icon={Eye} loading={isLoading} hint="IG Views • FB Reach • YT/TT Video Views" accent="primary" />
        <KpiCard label="Followers" value={aggregates.totalFollowers} icon={Users} loading={isLoading} hint="YT Subs + FB/IG/TT Followers" accent="sky" />
        <KpiCard label="Likes" value={aggregates.totalLikes} icon={Heart} loading={isLoading} accent="rose" />
        <KpiCard label="Comments" value={aggregates.totalComments} icon={MessageCircle} loading={isLoading} accent="violet" />
      </div>

      <Card className="border-border/60 shadow-sm hover:shadow-md transition-shadow">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Views by Platform</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? <Skeleton className="h-64" /> : (
            <div className="h-64">
              <ResponsiveContainer>
                <BarChart data={aggregates.platformChart} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="platform" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} className="capitalize" />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}K` : v} />
                  <Tooltip cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }} content={<ChartTooltip />} />
                  <Bar dataKey="views" radius={[8, 8, 0, 0]} maxBarSize={64}>
                    {aggregates.platformChart.map((row) => (
                      <Bar key={row.platform} dataKey="views" fill={PLATFORM_COLORS[row.platform]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-sm hover:shadow-md transition-shadow">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Daily Views by Platform</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? <Skeleton className="h-72" /> : aggregates.dayChart.length === 0 ? (
            <div className="text-sm text-muted-foreground py-12 text-center">No daily breakdown available.</div>
          ) : (
            <div className="h-72">
              <ResponsiveContainer>
                <AreaChart data={aggregates.dayChart} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <defs>
                    {platformOrder.map((plat) => (
                      <linearGradient key={plat} id={`area-${plat}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={PLATFORM_COLORS[plat]} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={PLATFORM_COLORS[plat]} stopOpacity={0.02} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}K` : v} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" />
                  {platformOrder.map((plat) => (
                    <Area
                      key={plat}
                      type="monotone"
                      dataKey={plat}
                      stackId="1"
                      stroke={PLATFORM_COLORS[plat]}
                      strokeWidth={2}
                      fill={`url(#area-${plat})`}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
