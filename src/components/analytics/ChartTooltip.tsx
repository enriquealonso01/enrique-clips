import type { TooltipProps } from "recharts";

function fmt(n: any): string {
  const num = Number(n);
  if (!isFinite(num)) return String(n);
  if (Math.abs(num) >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (Math.abs(num) >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return num.toLocaleString();
}

export function ChartTooltip({ active, payload, label }: TooltipProps<any, any>) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-border/60 bg-popover/95 backdrop-blur-md shadow-lg px-3 py-2 text-xs">
      {label !== undefined && (
        <div className="font-semibold text-foreground mb-1.5 capitalize">{String(label)}</div>
      )}
      <div className="space-y-1">
        {payload.map((p: any, i: number) => (
          <div key={i} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ background: p.color || p.fill }} />
            <span className="text-muted-foreground capitalize">{p.name}</span>
            <span className="ml-auto font-mono font-semibold text-foreground">{fmt(p.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
