import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type StatusVariant = "completed" | "running" | "failed" | "queued" | "paused" | "stopped" | "pending" | "partial_failed" | "not_started" | "submitted" | "polling";

const variantStyles: Record<StatusVariant, string> = {
  completed: "bg-success text-success-foreground",
  running: "bg-warning text-warning-foreground",
  failed: "bg-destructive text-destructive-foreground",
  queued: "bg-muted text-muted-foreground",
  paused: "bg-secondary text-secondary-foreground",
  stopped: "bg-secondary text-secondary-foreground",
  pending: "bg-muted text-muted-foreground",
  partial_failed: "bg-warning text-warning-foreground",
  not_started: "bg-muted text-muted-foreground",
  submitted: "bg-primary text-primary-foreground",
  polling: "bg-warning text-warning-foreground",
};

export function StatusBadge({ status }: { status: string }) {
  const variant = status as StatusVariant;
  return (
    <Badge className={cn("capitalize", variantStyles[variant] || "bg-muted text-muted-foreground")}>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}
