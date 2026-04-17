import { useQueries } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { KpiCard } from "./KpiCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { BarChart3, Users, Eye, TrendingUp } from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend, LineChart, Line, PieChart, Pie, Cell,
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
        const { data, error } = await supabase.functions.invoke(
          `upload-post-analytics?action=profile&username=${encodeURIComponent(p.profile_username)}&platforms=${encodeURIComponent(platforms)}`,
          { method: "GET" }
        );
        if (error) throw error;
        return { username: p.profile_username, data };
      },
      staleTime: 5 * 60 * 1000,
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
    return <Alert><AlertDescription>Add a profile using the "Add Profile" button to see aggregated analytics.</AlertDescription></Alert>;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
        <KpiCard label="Total Impressions" value={aggregates.totalImpressions} icon={BarChart3} loading={isLoading} hint={`Across ${profiles.length} profiles`} />
        <KpiCard label="Total Followers" value={aggregates.totalFollowers} icon={Users} loading={isLoading} />
        <KpiCard label="Total Likes" value={aggregates.totalLikes} icon={TrendingUp} loading={isLoading} />
        <KpiCard label="Total Comments" value={aggregates.totalComments} icon={Eye} loading={isLoading} />
        <KpiCard label="Total Shares" value={aggregates.totalShares} icon={Eye} loading={isLoading} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Impressions by Profile</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-64" /> : (
              <div className="h-64">
                <ResponsiveContainer>
                  <BarChart data={aggregates.perProfile}>
                    <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                    <XAxis dataKey="profile" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                    <Tooltip contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                    <Bar dataKey="impressions" fill="hsl(var(--primary))" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Impressions by Platform</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-64" /> : (
              <div className="h-64">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={aggregates.platformChart} dataKey="value" nameKey="platform" outerRadius={90} label={(e: any) => e.platform}>
                      {aggregates.platformChart.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Daily Impressions per Profile</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? <Skeleton className="h-72" /> : aggregates.dayChart.length === 0 ? (
            <div className="text-sm text-muted-foreground">No daily breakdown available.</div>
          ) : (
            <div className="h-72">
              <ResponsiveContainer>
                <LineChart data={aggregates.dayChart}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                  <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <Tooltip contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                  <Legend />
                  {profiles.map((p, i) => (
                    <Line key={p.profile_username} type="monotone" dataKey={p.profile_username} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
