import { useQueries, useQuery } from "@tanstack/react-query";
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
import { Fragment, useMemo } from "react";
import { ExternalLink } from "lucide-react";
import { buildPlatformUrl } from "@/lib/platformUrls";

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

function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
export function TotalsTab({ profiles, period: _period }: Props) {
  // links per platform in the Per-Profile Breakdown table.
  const socialAccountsQuery = useQuery({
    queryKey: ["upload-post-social-accounts"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(
        `upload-post-analytics?action=social-accounts`,
        { method: "GET" }
      );
      if (error) throw error;
      return data as { profiles?: Array<{ username: string; social_accounts?: Record<string, { handle?: string; display_name?: string }> }> };
    },
    staleTime: 30 * 60 * 1000,
    retry: false,
  });

  // username (lowercased) -> { platform -> handle }
  const handlesByUser = useMemo(() => {
    const map: Record<string, Record<string, string>> = {};
    for (const p of socialAccountsQuery.data?.profiles ?? []) {
      const key = p.username.toLowerCase();
      const inner: Record<string, string> = {};
      for (const [plat, info] of Object.entries(p.social_accounts ?? {})) {
        if (info?.handle) inner[plat] = info.handle;
      }
      map[key] = inner;
    }
    return map;
  }, [socialAccountsQuery.data]);

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
        return { username: p.profile_username, data, fbPageId: pageId };
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
    const perProfile: Array<{ username: string; display: string; platform: string; views: number; followers: number; likes: number | null; comments: number | null; firstDataDate: string | null; profileUrl: string | null }> = [];
    const profileTotals: Record<string, { views: number; followers: number; likes: number; comments: number }> = {};

    profileQueries.forEach((q, idx) => {
      const profileMeta = profiles[idx];
      if (!q.data) return;
      const d: any = q.data.data;
      const display = profileMeta.display_name || profileMeta.profile_username;
      let pv = 0, pf = 0, pl = 0, pc = 0;
      for (const platform of Object.keys(d || {})) {
        const p = d[platform];
        if (!p || typeof p !== "object" || p.error) continue;
        const v = getViews(platform, p);
        const f = Number(p.followers) || 0;
        // Facebook profile-summary endpoint does not expose likes/comments — mark as N/A
        const fbNoEngagement = platform === "facebook";
        const l = fbNoEngagement ? null : (Number(p.likes) || 0);
        const c = fbNoEngagement ? null : (Number(p.comments) || 0);
        pv += v; pf += f;
        if (l !== null) pl += l;
        if (c !== null) pc += c;
        totalViews += v; totalFollowers += f;
        if (l !== null) totalLikes += l;
        if (c !== null) totalComments += c;
        if (!perPlatform[platform]) perPlatform[platform] = { views: 0, followers: 0, likes: 0, comments: 0 };
        perPlatform[platform].views += v;
        perPlatform[platform].followers += f;
        if (l !== null) perPlatform[platform].likes += l;
        if (c !== null) perPlatform[platform].comments += c;

        const tsPoints = getViewsTimeseries(platform, p);
        const firstNonZero = tsPoints.find((pt) => pt.value > 0);
        // Pull the real social handle from the social-accounts mapping. For Facebook,
        // prefer the configured facebook_page_id (numeric IDs always resolve at /<id>),
        // since Upload-Post returns the user's display name there.
        const userHandles = handlesByUser[profileMeta.profile_username.toLowerCase()] || {};
        let profileUrl: string | null = null;
        if (platform === "facebook" && q.data.fbPageId) {
          profileUrl = buildPlatformUrl("facebook", q.data.fbPageId);
        } else {
          profileUrl = buildPlatformUrl(platform, userHandles[platform] || null);
        }
        perProfile.push({
          username: profileMeta.profile_username,
          display,
          platform,
          views: v, followers: f, likes: l, comments: c,
          firstDataDate: firstNonZero ? firstNonZero.date : null,
          profileUrl,
        });

        for (const point of tsPoints) {
          if (!perDayByPlatform[point.date]) perDayByPlatform[point.date] = {};
          perDayByPlatform[point.date][platform] = (perDayByPlatform[point.date][platform] || 0) + point.value;
        }
      }
      profileTotals[profileMeta.profile_username] = { views: pv, followers: pf, likes: pl, comments: pc };
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

    const platformRank: Record<string, number> = { youtube: 0, facebook: 1, instagram: 2, tiktok: 3 };
    perProfile.sort((a, b) => {
      const ta = profileTotals[a.username]?.views ?? 0;
      const tb = profileTotals[b.username]?.views ?? 0;
      if (tb !== ta) return tb - ta;
      if (a.username !== b.username) return a.username.localeCompare(b.username);
      return (platformRank[a.platform] ?? 99) - (platformRank[b.platform] ?? 99);
    });

    // TikTok's API returns zeros for older days even when posts existed earlier.
    // Use Instagram's first-data date for the same profile as a proxy.
    const igFirstByUser: Record<string, string | null> = {};
    for (const r of perProfile) {
      if (r.platform === "instagram") igFirstByUser[r.username] = r.firstDataDate;
    }
    for (const r of perProfile) {
      if (r.platform === "tiktok" && igFirstByUser[r.username]) {
        r.firstDataDate = igFirstByUser[r.username];
      }
    }

    return { totalViews, totalFollowers, totalLikes, totalComments, platformChart, dayChart, perProfile, profileTotals };
  }, [profileQueries, profiles, handlesByUser]);

  async function copyTable(format: "tsv" | "md") {
    const rows = aggregates.perProfile;
    const header = ["Profile", "Platform", "Views", "Followers", "Likes", "Comments", "First Data"];
    const totalRow = ["TOTAL", "", aggregates.totalViews, aggregates.totalFollowers, aggregates.totalLikes, aggregates.totalComments, ""];
    const fmt = (n: number | null) => n === null ? "N/A" : String(n);
    const fmtDate = (d: string | null) => d ?? "—";
    let text = "";
    if (format === "tsv") {
      text = [header.join("\t"), ...rows.map((r) => [r.display, r.platform, r.views, r.followers, fmt(r.likes), fmt(r.comments), fmtDate(r.firstDataDate)].join("\t")), totalRow.join("\t")].join("\n");
    } else {
      const sep = "| " + header.map(() => "---").join(" | ") + " |";
      const line = (cells: any[]) => "| " + cells.join(" | ") + " |";
      text = [line(header), sep, ...rows.map((r) => line([r.display, r.platform, r.views, r.followers, fmt(r.likes), fmt(r.comments), fmtDate(r.firstDataDate)])), line(totalRow)].join("\n");
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

      <Card className="border-border/60 shadow-sm hover:shadow-md transition-shadow">
        <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Per-Profile Breakdown</CardTitle>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => copyTable("tsv")} className="h-8">
              <Copy className="h-3.5 w-3.5 mr-1.5" /> Copy (TSV)
            </Button>
            <Button size="sm" variant="outline" onClick={() => copyTable("md")} className="h-8">
              <Copy className="h-3.5 w-3.5 mr-1.5" /> Copy (Markdown)
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? <Skeleton className="h-48" /> : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Profile</TableHead>
                    <TableHead>Platform</TableHead>
                    <TableHead className="text-right">Views</TableHead>
                    <TableHead className="text-right">Followers</TableHead>
                    <TableHead className="text-right">Likes</TableHead>
                    <TableHead className="text-right">Comments</TableHead>
                    <TableHead className="text-right">First Data</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {aggregates.perProfile.map((r, i) => {
                    const prev = aggregates.perProfile[i - 1];
                    const isFirstOfProfile = !prev || prev.username !== r.username;
                    const next = aggregates.perProfile[i + 1];
                    const isLastOfProfile = !next || next.username !== r.username;
                    const totals = aggregates.profileTotals[r.username];
                    return (
                      <Fragment key={`${r.username}-${r.platform}`}>
                        <TableRow className={isFirstOfProfile ? "border-t-2 border-border/60" : ""}>
                          <TableCell className="font-medium">{isFirstOfProfile ? r.display : ""}</TableCell>
                          <TableCell>
                            {r.profileUrl ? (
                              <a
                                href={r.profileUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-2 capitalize text-xs text-primary hover:underline"
                                title={`Open ${r.platform} profile`}
                              >
                                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: PLATFORM_COLORS[r.platform] }} />
                                {r.platform}
                                <ExternalLink className="h-3 w-3 opacity-60" />
                              </a>
                            ) : (
                              <span className="inline-flex items-center gap-2 capitalize text-xs">
                                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: PLATFORM_COLORS[r.platform] }} />
                                {r.platform}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono">{r.views.toLocaleString()}</TableCell>
                          <TableCell className="text-right font-mono">{r.followers.toLocaleString()}</TableCell>
                          <TableCell className="text-right font-mono">{r.likes === null ? <span className="text-muted-foreground">N/A</span> : r.likes.toLocaleString()}</TableCell>
                          <TableCell className="text-right font-mono">{r.comments === null ? <span className="text-muted-foreground">N/A</span> : r.comments.toLocaleString()}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{r.firstDataDate ?? <span className="text-muted-foreground">—</span>}</TableCell>
                        </TableRow>
                        {isLastOfProfile && totals && (
                          <TableRow className="bg-muted/20 text-xs">
                            <TableCell className="font-medium text-muted-foreground">Subtotal</TableCell>
                            <TableCell />
                            <TableCell className="text-right font-mono">{totals.views.toLocaleString()}</TableCell>
                            <TableCell className="text-right font-mono">{totals.followers.toLocaleString()}</TableCell>
                            <TableCell className="text-right font-mono">{totals.likes.toLocaleString()}</TableCell>
                            <TableCell className="text-right font-mono">{totals.comments.toLocaleString()}</TableCell>
                            <TableCell />
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                  <TableRow className="bg-muted/50 font-semibold border-t-2 border-border">
                    <TableCell>TOTAL</TableCell>
                    <TableCell />
                    <TableCell className="text-right font-mono">{aggregates.totalViews.toLocaleString()}</TableCell>
                    <TableCell className="text-right font-mono">{aggregates.totalFollowers.toLocaleString()}</TableCell>
                    <TableCell className="text-right font-mono">{aggregates.totalLikes.toLocaleString()}</TableCell>
                    <TableCell className="text-right font-mono">{aggregates.totalComments.toLocaleString()}</TableCell>
                    <TableCell />
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
