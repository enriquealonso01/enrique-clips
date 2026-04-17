import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getFacebookPageIdForUsername } from "@/lib/facebookPageId";
import { KpiCard } from "./KpiCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Eye, Users, Heart, MessageCircle, Share2, Bookmark, UserCheck, BarChart3 } from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
  BarChart, Bar,
} from "recharts";
import { ChartTooltip } from "./ChartTooltip";

interface Props {
  username: string;
  period: string;
  selectedPlatforms: string[];
}

const PLATFORM_COLORS: Record<string, string> = {
  instagram: "hsl(330 80% 60%)",
  tiktok: "hsl(0 0% 80%)",
  youtube: "hsl(0 80% 55%)",
  facebook: "hsl(220 80% 55%)",
  linkedin: "hsl(210 70% 45%)",
  x: "hsl(0 0% 60%)",
  threads: "hsl(280 60% 60%)",
  pinterest: "hsl(0 70% 50%)",
  reddit: "hsl(20 90% 55%)",
  bluesky: "hsl(200 80% 60%)",
};

function periodToDays(period: string): number {
  switch (period) {
    case "last_day": return 1;
    case "last_week": return 7;
    case "last_month": return 30;
    case "last_3months": return 90;
    case "last_year": return 365;
    default: return 30;
  }
}

export function ProfileTab({ username, period, selectedPlatforms }: Props) {
  const platformsQuery = selectedPlatforms.join(",");

  const { data, isLoading, error } = useQuery({
    queryKey: ["profile-analytics", username, platformsQuery],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("upload-post-analytics", {
        method: "GET" as any,
        body: undefined,
      } as any);
      // fallback: use direct fetch via invoke with query string
      if (error) throw error;
      return data;
    },
    enabled: false, // we use the manual one below
  });

  // Use manual fetch via supabase.functions.invoke with URL trick
  const q = useQuery({
    queryKey: ["upload-post-profile", username, platformsQuery],
    queryFn: async () => {
      const pageId = platformsQuery.includes("facebook")
        ? await getFacebookPageIdForUsername(username)
        : null;
      const pageQs = pageId ? `&page_id=${encodeURIComponent(pageId)}` : "";
      const { data, error } = await supabase.functions.invoke(
        `upload-post-analytics?action=profile&username=${encodeURIComponent(username)}&platforms=${encodeURIComponent(platformsQuery)}${pageQs}`,
        { method: "GET" }
      );
      if (error) throw error;
      return data as Record<string, any>;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const days = periodToDays(period);

  // Filter timeseries by period & build chart data
  const timeseriesData = useMemo(() => {
    if (!q.data) return [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const byDate: Record<string, any> = {};
    for (const platform of Object.keys(q.data)) {
      const series = q.data[platform]?.reach_timeseries;
      if (!Array.isArray(series)) continue;
      for (const point of series) {
        if (!point?.date) continue;
        const d = new Date(point.date);
        if (d < cutoff) continue;
        if (!byDate[point.date]) byDate[point.date] = { date: point.date };
        byDate[point.date][platform] = point.value;
      }
    }
    return Object.values(byDate).sort((a: any, b: any) => a.date.localeCompare(b.date));
  }, [q.data, days]);

  // Aggregate KPIs (deduplicated using metric_type — sum reach for "reach" platforms, views for "views" platforms)
  const kpis = useMemo(() => {
    if (!q.data) return null;
    let followers = 0, likes = 0, comments = 0, shares = 0, saves = 0, profileViews = 0;
    let reachTotal = 0, viewsTotal = 0, impressionsTotal = 0;
    for (const platform of Object.keys(q.data)) {
      const p = q.data[platform];
      if (!p || typeof p !== "object" || p.error) continue;
      followers += Number(p.followers) || 0;
      likes += Number(p.likes) || 0;
      comments += Number(p.comments) || 0;
      shares += Number(p.shares) || 0;
      saves += Number(p.saves) || 0;
      profileViews += Number(p.profileViews) || 0;
      const mt = p.metric_type;
      if (mt === "reach") reachTotal += Number(p.reach) || 0;
      else if (mt === "views") viewsTotal += Number(p.views) || 0;
      else if (mt === "impressions") impressionsTotal += Number(p.impressions) || 0;
    }
    const totalImpressions = reachTotal + viewsTotal + impressionsTotal;
    return { followers, likes, comments, shares, saves, profileViews, totalImpressions };
  }, [q.data]);

  // Platform comparison data (followers + impressions per platform)
  const platformBreakdown = useMemo(() => {
    if (!q.data) return [];
    return Object.keys(q.data)
      .filter((k) => q.data![k] && !q.data![k].error)
      .map((k) => {
        const p = q.data![k];
        const primary = p.primary_impressions_field || "impressions";
        return {
          platform: k,
          followers: Number(p.followers) || 0,
          impressions: Number(p[primary]) || 0,
          engagement: (Number(p.likes) || 0) + (Number(p.comments) || 0) + (Number(p.shares) || 0) + (Number(p.saves) || 0),
        };
      });
  }, [q.data]);

  const engagementBreakdown = useMemo(() => {
    if (!q.data) return [];
    return Object.keys(q.data)
      .filter((k) => q.data![k] && !q.data![k].error)
      .map((k) => ({
        platform: k,
        likes: Number(q.data![k].likes) || 0,
        comments: Number(q.data![k].comments) || 0,
        shares: Number(q.data![k].shares) || 0,
        saves: Number(q.data![k].saves) || 0,
      }));
  }, [q.data]);

  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  if (q.error) {
    return <Alert variant="destructive"><AlertDescription>Failed to load analytics: {String((q.error as Error).message)}</AlertDescription></Alert>;
  }

  if (q.data && (q.data as any)._error) {
    return <Alert variant="destructive"><AlertDescription>Upload-Post: {String((q.data as any)._error)} (username <code>{username}</code>)</AlertDescription></Alert>;
  }

  if (!q.data || Object.keys(q.data).length === 0) {
    return <Alert><AlertDescription>No analytics data returned for <code>{username}</code>.</AlertDescription></Alert>;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        <KpiCard label="Total Impressions" value={kpis?.totalImpressions} icon={BarChart3} accent="primary" />
        <KpiCard label="Followers" value={kpis?.followers} icon={Users} accent="sky" />
        <KpiCard label="Profile Views" value={kpis?.profileViews} icon={UserCheck} accent="violet" />
        <KpiCard label="Likes" value={kpis?.likes} icon={Heart} accent="rose" />
        <KpiCard label="Comments" value={kpis?.comments} icon={MessageCircle} accent="sky" />
        <KpiCard label="Shares" value={kpis?.shares} icon={Share2} accent="emerald" />
        <KpiCard label="Saves" value={kpis?.saves} icon={Bookmark} accent="amber" />
      </div>

      <Card className="border-border/60 shadow-sm hover:shadow-md transition-shadow">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Reach / Views Over Time</CardTitle>
        </CardHeader>
        <CardContent>
          {timeseriesData.length === 0 ? (
            <div className="text-sm text-muted-foreground py-12 text-center">No time-series data available for the selected period.</div>
          ) : (
            <div className="h-72 w-full">
              <ResponsiveContainer>
                <AreaChart data={timeseriesData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <defs>
                    {Object.keys(q.data).filter((k) => Array.isArray(q.data![k]?.reach_timeseries)).map((k) => (
                      <linearGradient key={k} id={`reach-${k}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={PLATFORM_COLORS[k] || "hsl(var(--primary))"} stopOpacity={0.4} />
                        <stop offset="100%" stopColor={PLATFORM_COLORS[k] || "hsl(var(--primary))"} stopOpacity={0.02} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}K` : v} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" />
                  {Object.keys(q.data).filter((k) => Array.isArray(q.data![k]?.reach_timeseries)).map((k) => (
                    <Area
                      key={k}
                      type="monotone"
                      dataKey={k}
                      stroke={PLATFORM_COLORS[k] || "hsl(var(--primary))"}
                      strokeWidth={2.5}
                      fill={`url(#reach-${k})`}
                      activeDot={{ r: 5, strokeWidth: 2, stroke: "hsl(var(--background))" }}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="border-border/60 shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Followers & Impressions by Platform</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64 w-full">
              <ResponsiveContainer>
                <BarChart data={platformBreakdown} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="followersGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.95} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.5} />
                    </linearGradient>
                    <linearGradient id="impressionsGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(280 70% 60%)" stopOpacity={0.95} />
                      <stop offset="100%" stopColor="hsl(280 70% 60%)" stopOpacity={0.5} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="platform" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}K` : v} />
                  <Tooltip cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }} content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" />
                  <Bar dataKey="followers" fill="url(#followersGrad)" radius={[6, 6, 0, 0]} maxBarSize={40} />
                  <Bar dataKey="impressions" fill="url(#impressionsGrad)" radius={[6, 6, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/60 shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Engagement by Platform</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64 w-full">
              <ResponsiveContainer>
                <BarChart data={engagementBreakdown} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="platform" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}K` : v} />
                  <Tooltip cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }} content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" />
                  <Bar dataKey="likes" stackId="a" fill="hsl(330 80% 60%)" maxBarSize={48} />
                  <Bar dataKey="comments" stackId="a" fill="hsl(210 80% 60%)" maxBarSize={48} />
                  <Bar dataKey="shares" stackId="a" fill="hsl(160 70% 50%)" maxBarSize={48} />
                  <Bar dataKey="saves" stackId="a" fill="hsl(40 90% 55%)" radius={[6, 6, 0, 0]} maxBarSize={48} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-2">Per-Platform Detail</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {Object.keys(q.data).map((platform) => {
            const p = q.data![platform];
            if (!p || typeof p !== "object") return null;
            if (p.error || p.message) {
              return (
                <Card key={platform}>
                  <CardHeader><CardTitle className="text-sm capitalize">{platform}</CardTitle></CardHeader>
                  <CardContent>
                    <div className="text-xs text-muted-foreground">{p.error || p.message}</div>
                  </CardContent>
                </Card>
              );
            }
            const labels: Record<string, string> = p.metric_labels || {};
            const available: string[] = p.available_metrics || ["followers", "likes", "comments", "shares"];
            return (
              <Card key={platform}>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle className="text-sm capitalize">{platform}</CardTitle>
                  {p.primary_impressions_field && (
                    <Badge variant="secondary" className="text-[10px]">primary: {p.primary_impressions_field}</Badge>
                  )}
                </CardHeader>
                <CardContent className="space-y-1.5">
                  {available.map((m) => {
                    const v = p[m];
                    if (v === undefined || v === null) return null;
                    return (
                      <div key={m} className="flex justify-between text-xs">
                        <span className="text-muted-foreground">{labels[m] || m}</span>
                        <span className="font-mono font-medium">{typeof v === "number" ? v.toLocaleString() : String(v)}</span>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
