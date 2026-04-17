import { useQueries } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getFacebookPageIdForUsername } from "@/lib/facebookPageId";
import { KpiCard } from "./KpiCard";
import { ChartTooltip } from "./ChartTooltip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart3, Users, Eye, TrendingUp } from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend, AreaChart, Area, PieChart, Pie, Cell,
} from "recharts";
import { useMemo } from "react";

interface ProfileRow { id: string; profile_username: string; display_name: string | null; }
interface Props { profiles: ProfileRow[]; period: string; }

const COLORS = [
  "hsl(330 80% 60%)", "hsl(210 80% 60%)", "hsl(160 70% 50%)", "hsl(40 90% 55%)",
  "hsl(280 70% 60%)", "hsl(0 80% 55%)", "hsl(190 80% 50%)", "hsl(60 80% 55%)",
];

export function TotalsTab({ profiles, period }: Props) {
  const queries = useQueries({
    queries: profiles.map((p) => ({
      queryKey: ["totals", p.profile_username, period],
      queryFn: async () => {
        const { data, error } = await supabase.functions.invoke(
          `upload-post-analytics?action=totals&username=${encodeURIComponent(p.profile_username)}&period=${encodeURIComponent(period)}&breakdown=true`,
          { method: "GET" }
        );
        if (error) throw error;
        return { username: p.profile_username, ...((data as any) || {}) };
      },
      staleTime: 5 * 60 * 1000,
    })),
  });

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

  const isLoading = queries.some((q) => q.isLoading) || profileQueries.some((q) => q.isLoading);

  // Combined totals
  const aggregates = useMemo(() => {
    let totalImpressions = 0;
    const perProfile: Array<{ profile: string; impressions: number }> = [];
    const perPlatform: Record<string, number> = {};
    const perDay: Record<string, Record<string, number>> = {}; // date -> profile -> impressions

    queries.forEach((q) => {
      if (!q.data) return;
      const d: any = q.data;
      const ti = Number(d.total_impressions) || 0;
      totalImpressions += ti;
      perProfile.push({ profile: d.username, impressions: ti });
      if (d.per_platform && typeof d.per_platform === "object") {
        for (const plat of Object.keys(d.per_platform)) {
          perPlatform[plat] = (perPlatform[plat] || 0) + (Number(d.per_platform[plat]) || 0);
        }
      }
      if (d.per_day && typeof d.per_day === "object") {
        for (const date of Object.keys(d.per_day)) {
          if (!perDay[date]) perDay[date] = {};
          perDay[date][d.username] = (perDay[date][d.username] || 0) + (Number(d.per_day[date]) || 0);
        }
      }
    });

    let totalFollowers = 0, totalLikes = 0, totalComments = 0, totalShares = 0;
    profileQueries.forEach((q) => {
      if (!q.data) return;
      const d: any = q.data.data;
      for (const k of Object.keys(d || {})) {
        const p = d[k];
        if (!p || typeof p !== "object" || p.error) continue;
        totalFollowers += Number(p.followers) || 0;
        totalLikes += Number(p.likes) || 0;
        totalComments += Number(p.comments) || 0;
        totalShares += Number(p.shares) || 0;
      }
    });

    const platformChart = Object.entries(perPlatform).map(([platform, value]) => ({ platform, value }));
    const dayChart = Object.keys(perDay).sort().map((date) => ({ date, ...perDay[date] }));

    return { totalImpressions, perProfile, platformChart, dayChart, totalFollowers, totalLikes, totalComments, totalShares };
  }, [queries, profileQueries]);

  if (profiles.length === 0) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-border p-12 text-center bg-card/50">
        <BarChart3 className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
        <p className="text-sm text-muted-foreground">Add a profile to see aggregated analytics across YouTube, Facebook, Instagram, and TikTok.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
        <KpiCard label="Total Impressions" value={aggregates.totalImpressions} icon={BarChart3} loading={isLoading} hint={`Across ${profiles.length} profile${profiles.length > 1 ? "s" : ""}`} accent="primary" />
        <KpiCard label="Followers" value={aggregates.totalFollowers} icon={Users} loading={isLoading} accent="sky" />
        <KpiCard label="Likes" value={aggregates.totalLikes} icon={TrendingUp} loading={isLoading} accent="rose" />
        <KpiCard label="Comments" value={aggregates.totalComments} icon={Eye} loading={isLoading} accent="violet" />
        <KpiCard label="Shares" value={aggregates.totalShares} icon={Eye} loading={isLoading} accent="emerald" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="border-border/60 shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Impressions by Profile</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-64" /> : (
              <div className="h-64">
                <ResponsiveContainer>
                  <BarChart data={aggregates.perProfile} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                    <defs>
                      <linearGradient id="barProfileGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.95} />
                        <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.45} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="profile" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}K` : v} />
                    <Tooltip cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }} content={<ChartTooltip />} />
                    <Bar dataKey="impressions" fill="url(#barProfileGrad)" radius={[8, 8, 0, 0]} maxBarSize={56} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border/60 shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Impressions by Platform</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-64" /> : (
              <div className="h-64">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie
                      data={aggregates.platformChart}
                      dataKey="value"
                      nameKey="platform"
                      innerRadius={50}
                      outerRadius={90}
                      paddingAngle={3}
                      stroke="hsl(var(--background))"
                      strokeWidth={3}
                      label={(e: any) => e.platform}
                    >
                      {aggregates.platformChart.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="border-border/60 shadow-sm hover:shadow-md transition-shadow">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Daily Impressions per Profile</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? <Skeleton className="h-72" /> : aggregates.dayChart.length === 0 ? (
            <div className="text-sm text-muted-foreground py-12 text-center">No daily breakdown available.</div>
          ) : (
            <div className="h-72">
              <ResponsiveContainer>
                <AreaChart data={aggregates.dayChart} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <defs>
                    {profiles.map((p, i) => (
                      <linearGradient key={p.profile_username} id={`area-${i}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={COLORS[i % COLORS.length]} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={COLORS[i % COLORS.length]} stopOpacity={0.02} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}K` : v} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" />
                  {profiles.map((p, i) => (
                    <Area
                      key={p.profile_username}
                      type="monotone"
                      dataKey={p.profile_username}
                      stroke={COLORS[i % COLORS.length]}
                      strokeWidth={2.5}
                      fill={`url(#area-${i})`}
                      activeDot={{ r: 5, strokeWidth: 2, stroke: "hsl(var(--background))" }}
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
