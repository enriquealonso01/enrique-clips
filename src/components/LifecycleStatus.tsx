import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { AlertTriangle, CalendarClock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type LifecycleStatus = "testing" | "awaiting_monetization" | "monetized" | "killed";

export const LIFECYCLE_OPTIONS: { value: LifecycleStatus; label: string }[] = [
  { value: "testing", label: "Testing" },
  { value: "awaiting_monetization", label: "Awaiting Monetization" },
  { value: "monetized", label: "Monetized" },
  { value: "killed", label: "Killed" },
];

export function lifecycleLabel(status: string | null | undefined): string {
  return LIFECYCLE_OPTIONS.find((o) => o.value === status)?.label ?? "Testing";
}

const badgeStyles: Record<LifecycleStatus, string> = {
  testing: "bg-muted text-foreground",
  awaiting_monetization: "bg-warning text-warning-foreground",
  monetized: "bg-success text-success-foreground",
  killed: "bg-destructive text-destructive-foreground",
};

export function LifecycleBadge({ status }: { status: string | null | undefined }) {
  const value = (status ?? "testing") as LifecycleStatus;
  return (
    <Badge className={cn(badgeStyles[value] ?? "bg-muted text-foreground")}>
      {lifecycleLabel(value)}
    </Badge>
  );
}

type ReviewState = "none" | "upcoming" | "today" | "overdue";

export interface ReviewDueInfo {
  state: ReviewState;
  /** Calendar days until the due date (negative = days overdue). */
  days: number;
  /** Formatted due date, e.g. "May 9, 2026". Empty when no date set. */
  dueLabel: string;
  /** Human sentence for tooltips / inline text. */
  message: string;
}

export function reviewDueInfo(dueDate: string | null | undefined): ReviewDueInfo {
  if (!dueDate) {
    return { state: "none", days: NaN, dueLabel: "", message: "No review date set" };
  }
  const due = parseISO(dueDate);
  const days = differenceInCalendarDays(due, new Date());
  const dueLabel = format(due, "MMM d, yyyy");
  if (days < 0) {
    const n = Math.abs(days);
    return { state: "overdue", days, dueLabel, message: `Review overdue by ${n} day${n === 1 ? "" : "s"} — was due ${dueLabel}` };
  }
  if (days === 0) {
    return { state: "today", days, dueLabel, message: `Review due today (${dueLabel})` };
  }
  return { state: "upcoming", days, dueLabel, message: `Review in ${days} day${days === 1 ? "" : "s"} — ${dueLabel}` };
}

/** Glanceable icon for a testing channel's review status. Render only for testing projects. */
export function ReviewDueIcon({ dueDate, className }: { dueDate: string | null | undefined; className?: string }) {
  const info = reviewDueInfo(dueDate);
  const alert = info.state === "overdue" || info.state === "today";
  const Icon = alert ? AlertTriangle : CalendarClock;
  const color =
    info.state === "overdue" || info.state === "today"
      ? "text-destructive"
      : info.state === "upcoming"
        ? "text-muted-foreground"
        : "text-muted-foreground/50";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex", className)}>
          <Icon className={cn("h-4 w-4 shrink-0", color)} aria-label={info.message} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{info.message}</TooltipContent>
    </Tooltip>
  );
}
