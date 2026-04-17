import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  label: string;
  value: number | string | null | undefined;
  icon?: LucideIcon;
  loading?: boolean;
  hint?: string;
  accent?: "primary" | "rose" | "amber" | "emerald" | "violet" | "sky" | "slate";
  delta?: number;
}

const ACCENTS: Record<NonNullable<Props["accent"]>, { ring: string; text: string; bg: string }> = {
  primary: { ring: "ring-primary/15", text: "text-primary", bg: "from-primary/10 to-transparent" },
  rose: { ring: "ring-rose-500/15", text: "text-rose-500", bg: "from-rose-500/10 to-transparent" },
  amber: { ring: "ring-amber-500/15", text: "text-amber-500", bg: "from-amber-500/10 to-transparent" },
  emerald: { ring: "ring-emerald-500/15", text: "text-emerald-500", bg: "from-emerald-500/10 to-transparent" },
  violet: { ring: "ring-violet-500/15", text: "text-violet-500", bg: "from-violet-500/10 to-transparent" },
  sky: { ring: "ring-sky-500/15", text: "text-sky-500", bg: "from-sky-500/10 to-transparent" },
  slate: { ring: "ring-slate-500/15", text: "text-muted-foreground", bg: "from-muted/40 to-transparent" },
};

function fmt(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString();
}

export function KpiCard({ label, value, icon: Icon, loading, hint, accent = "slate" }: Props) {
  const a = ACCENTS[accent];
  return (
    <Card className={cn(
      "relative overflow-hidden ring-1 ring-border/60 hover:ring-border transition-all hover:shadow-md group",
    )}>
      <div className={cn("absolute inset-0 bg-gradient-to-br pointer-events-none opacity-70", a.bg)} />
      <CardContent className="relative p-4">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
          {Icon && (
            <div className={cn("h-7 w-7 rounded-lg bg-background/70 backdrop-blur flex items-center justify-center ring-1", a.ring)}>
              <Icon className={cn("h-3.5 w-3.5", a.text)} />
            </div>
          )}
        </div>
        {loading ? (
          <Skeleton className="mt-3 h-8 w-24" />
        ) : (
          <div className="mt-2 text-3xl font-bold tracking-tight tabular-nums">{fmt(value)}</div>
        )}
        {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}
