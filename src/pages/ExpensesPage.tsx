import { useState, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { subDays, startOfYear, format, parseISO } from "date-fns";
import { DollarSign, ImageIcon, Film } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { KpiCard } from "@/components/analytics/KpiCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

const IMAGE_TYPES = new Set(["initial_image", "keyframe", "scene_image", "cast_reference_image", "real_image"]);
const VIDEO_TYPES = new Set(["clip", "scene_video_raw", "scene_video_trimmed"]);

type Period = "day" | "7d" | "30d" | "ytd";

function getPeriodRange(period: Period): { start: Date; end: Date } {
  const end = new Date();
  switch (period) {
    case "day":  return { start: subDays(end, 1), end };
    case "7d":   return { start: subDays(end, 7), end };
    case "30d":  return { start: subDays(end, 30), end };
    case "ytd":  return { start: startOfYear(end), end };
  }
}

function fmtUsd(n: number) {
  return `$${n.toFixed(2)}`;
}

const PERIODS: { key: Period; label: string }[] = [
  { key: "day", label: "Last Day" },
  { key: "7d",  label: "7 Days" },
  { key: "30d", label: "1 Month" },
  { key: "ytd", label: "Year to Date" },
];

export default function ExpensesPage() {
  const [period, setPeriod] = useState<Period>("30d");
  const { start, end } = getPeriodRange(period);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const [regularQ, storyQ] = useQueries({
    queries: [
      {
        queryKey: ["expenses-regular", startIso, endIso],
        queryFn: async () => {
          const { data, error } = await supabase
            .from("assets")
            .select("id, type, cost_usd, created_at, runs(project_id, projects(title))")
            .not("cost_usd", "is", null)
            .gte("created_at", startIso)
            .lte("created_at", endIso);
          if (error) throw error;
          return (data || []).map((a: any) => ({
            type: a.type as string,
            cost: Number(a.cost_usd),
            day: format(parseISO(a.created_at), "MMM d"),
            channel: (a.runs as any)?.projects?.title ?? "Unknown",
          }));
        },
      },
      {
        queryKey: ["expenses-story", startIso, endIso],
        queryFn: async () => {
          const { data, error } = await supabase
            .from("story_assets")
            .select("id, type, cost_usd, created_at, story_runs(project_id, story_projects(title))")
            .not("cost_usd", "is", null)
            .gte("created_at", startIso)
            .lte("created_at", endIso);
          if (error) throw error;
          return (data || []).map((a: any) => ({
            type: a.type as string,
            cost: Number(a.cost_usd),
            day: format(parseISO(a.created_at), "MMM d"),
            channel: (a.story_runs as any)?.story_projects?.title ?? "Unknown",
          }));
        },
      },
    ],
  });

  const loading = regularQ.isLoading || storyQ.isLoading;

  const all = useMemo(
    () => [...(regularQ.data ?? []), ...(storyQ.data ?? [])],
    [regularQ.data, storyQ.data],
  );

  const { totalCost, imageCost, videoCost, imageCount, videoCount } = useMemo(() => {
    let totalCost = 0, imageCost = 0, videoCost = 0, imageCount = 0, videoCount = 0;
    for (const item of all) {
      totalCost += item.cost;
      if (IMAGE_TYPES.has(item.type)) { imageCost += item.cost; imageCount++; }
      else if (VIDEO_TYPES.has(item.type)) { videoCost += item.cost; videoCount++; }
    }
    return { totalCost, imageCost, videoCost, imageCount, videoCount };
  }, [all]);

  const dailyData = useMemo(() => {
    const map = new Map<string, { date: string; Images: number; Video: number }>();
    for (const item of all) {
      if (!map.has(item.day)) map.set(item.day, { date: item.day, Images: 0, Video: 0 });
      const e = map.get(item.day)!;
      if (IMAGE_TYPES.has(item.type)) e.Images += item.cost;
      else if (VIDEO_TYPES.has(item.type)) e.Video += item.cost;
    }
    return Array.from(map.values());
  }, [all]);

  const byChannel = useMemo(() => {
    const map = new Map<string, { channel: string; ic: number; im: number; vc: number; vm: number }>();
    for (const item of all) {
      if (!map.has(item.channel)) map.set(item.channel, { channel: item.channel, ic: 0, im: 0, vc: 0, vm: 0 });
      const e = map.get(item.channel)!;
      if (IMAGE_TYPES.has(item.type)) { e.ic += item.cost; e.im++; }
      else if (VIDEO_TYPES.has(item.type)) { e.vc += item.cost; e.vm++; }
    }
    return Array.from(map.values()).sort((a, b) => (b.ic + b.vc) - (a.ic + a.vc));
  }, [all]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Expenses</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Image and video generation costs across all channels
          </p>
        </div>
        <div className="flex gap-1">
          {PERIODS.map(({ key, label }) => (
            <Button
              key={key}
              size="sm"
              variant={period === key ? "default" : "outline"}
              onClick={() => setPeriod(key)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiCard
          label="Total Spend"
          value={fmtUsd(totalCost)}
          icon={DollarSign}
          loading={loading}
          accent="primary"
        />
        <KpiCard
          label="Image Cost"
          value={fmtUsd(imageCost)}
          icon={ImageIcon}
          loading={loading}
          hint={`${imageCount} image${imageCount !== 1 ? "s" : ""}`}
          accent="sky"
        />
        <KpiCard
          label="Video Cost"
          value={fmtUsd(videoCost)}
          icon={Film}
          loading={loading}
          hint={`${videoCount} clip${videoCount !== 1 ? "s" : ""}`}
          accent="violet"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Daily Spend</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="h-52 flex items-center justify-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : dailyData.length === 0 ? (
            <div className="h-52 flex items-center justify-center text-sm text-muted-foreground text-center px-8">
              No cost data yet for this period. Costs are recorded on new runs going forward.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={dailyData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis
                  tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                  tick={{ fontSize: 11 }}
                  width={56}
                />
                <Tooltip
                  formatter={(v: number, name: string) => [`$${v.toFixed(4)}`, name]}
                  contentStyle={{ fontSize: 12 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="Images" stackId="a" fill="#38bdf8" />
                <Bar dataKey="Video" stackId="a" fill="#a78bfa" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">By Channel</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="h-24 flex items-center justify-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : byChannel.length === 0 ? (
            <div className="h-24 flex items-center justify-center text-sm text-muted-foreground">
              No data
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Channel</TableHead>
                  <TableHead className="text-right">Images</TableHead>
                  <TableHead className="text-right">Image Cost</TableHead>
                  <TableHead className="text-right">Clips</TableHead>
                  <TableHead className="text-right">Video Cost</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byChannel.map((row) => (
                  <TableRow key={row.channel}>
                    <TableCell className="font-medium">{row.channel}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.im}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtUsd(row.ic)}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.vm}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtUsd(row.vc)}</TableCell>
                    <TableCell className="text-right tabular-nums font-semibold">
                      {fmtUsd(row.ic + row.vc)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
