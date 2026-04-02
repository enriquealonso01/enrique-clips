import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Trash2, Clock } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { useState } from "react";

const WEEKDAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

interface ScheduleManagerProps {
  projectId: string;
  timezone: string;
}

export function ScheduleManager({ projectId, timezone }: ScheduleManagerProps) {
  const queryClient = useQueryClient();
  const [newTime, setNewTime] = useState("09:00");
  const [newDays, setNewDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);

  const { data: schedules, isLoading } = useQuery({
    queryKey: ["schedules", projectId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("schedules")
        .select("*")
        .eq("project_id", projectId)
        .order("time_utc", { ascending: true });
      if (error) throw error;
      return data;
    },
  });

  const addSchedule = useMutation({
    mutationFn: async (time: string) => {
      const { error } = await supabase
        .from("schedules")
        .insert({ project_id: projectId, time_utc: time + ":00", days_of_week: newDays } as any);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedules", projectId] });
      toast({ title: "Schedule added" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const toggleSchedule = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const { error } = await supabase
        .from("schedules")
        .update({ is_enabled: enabled })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["schedules", projectId] }),
  });

  const updateDays = useMutation({
    mutationFn: async ({ id, days }: { id: string; days: number[] }) => {
      const { error } = await supabase
        .from("schedules")
        .update({ days_of_week: days } as any)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["schedules", projectId] }),
  });

  const deleteSchedule = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("schedules").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedules", projectId] });
      toast({ title: "Schedule removed" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-5 w-5" />
          Daily Schedules
        </CardTitle>
        <CardDescription>
          Add daily post times. Each row triggers one run per day at the specified time ({timezone}).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add new schedule */}
        <div className="flex items-end gap-3">
          <div className="space-y-2 flex-1">
            <Label>Time ({timezone})</Label>
            <Input
              type="time"
              value={newTime}
              onChange={(e) => setNewTime(e.target.value)}
              className="max-w-[160px]"
            />
          </div>
          <Button
            onClick={() => addSchedule.mutate(newTime)}
            disabled={addSchedule.isPending}
            size="sm"
          >
            <Plus className="mr-1 h-4 w-4" />
            Add
          </Button>
        </div>

        {/* Existing schedules */}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : schedules && schedules.length > 0 ? (
          <div className="space-y-2">
            {schedules.map((schedule) => {
              const timeDisplay = schedule.time_utc.slice(0, 5); // HH:MM
              const lastTriggered = schedule.last_triggered_at
                ? new Date(schedule.last_triggered_at).toLocaleString()
                : "Never";

              return (
                <div
                  key={schedule.id}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={schedule.is_enabled}
                      onCheckedChange={(checked) =>
                        toggleSchedule.mutate({ id: schedule.id, enabled: checked })
                      }
                    />
                    <div>
                      <p className="font-medium text-sm">{timeDisplay}</p>
                      <p className="text-xs text-muted-foreground">
                        Last triggered: {lastTriggered}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => deleteSchedule.mutate(schedule.id)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No schedules yet. Add a daily time above.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
