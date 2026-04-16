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
  storyProject?: boolean;
}

export function ScheduleManager({ projectId, timezone, storyProject = false }: ScheduleManagerProps) {
  const queryClient = useQueryClient();
  const [newTime, setNewTime] = useState("09:00");
  const [newDays, setNewDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [newPostTime, setNewPostTime] = useState("");
  const [newPostTimeEnd, setNewPostTimeEnd] = useState("");

  const { data: schedules, isLoading } = useQuery({
    queryKey: ["schedules", projectId],
    queryFn: async () => {
      const filterCol = storyProject ? "story_project_id" : "project_id";
      const { data, error } = await (supabase.from("schedules").select("*").order("time_utc", { ascending: true }) as any).eq(filterCol, projectId);
      if (error) throw error;
      return data;
    },
  });

  const addSchedule = useMutation({
    mutationFn: async (time: string) => {
      const insertData: any = { time_utc: time + ":00", days_of_week: newDays };
      if (storyProject) {
        insertData.story_project_id = projectId;
      } else {
        insertData.project_id = projectId;
      }
      if (newPostTime) insertData.scheduled_post_time = newPostTime + ":00";
      if (newPostTimeEnd) insertData.scheduled_post_time_end = newPostTimeEnd + ":00";
      const { error } = await supabase
        .from("schedules")
        .insert(insertData);
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

  const updatePostTime = useMutation({
    mutationFn: async ({ id, time, timeEnd }: { id: string; time: string | null; timeEnd?: string | null }) => {
      const updateData: any = { scheduled_post_time: time };
      if (timeEnd !== undefined) updateData.scheduled_post_time_end = timeEnd;
      const { error } = await supabase
        .from("schedules")
        .update(updateData as any)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedules", projectId] });
      toast({ title: "Post time updated" });
    },
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
        <div className="space-y-3">
          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-2">
              <Label>Run Time ({timezone})</Label>
              <Input
                type="time"
                value={newTime}
                onChange={(e) => setNewTime(e.target.value)}
                className="max-w-[160px]"
              />
            </div>
            <div className="space-y-2">
              <Label>Post Time From (optional)</Label>
              <Input
                type="time"
                value={newPostTime}
                onChange={(e) => setNewPostTime(e.target.value)}
                className="max-w-[160px]"
                placeholder="Immediate"
              />
            </div>
            {newPostTime && (
              <div className="space-y-2">
                <Label>Post Time To (optional)</Label>
                <Input
                  type="time"
                  value={newPostTimeEnd}
                  onChange={(e) => setNewPostTimeEnd(e.target.value)}
                  className="max-w-[160px]"
                  placeholder="Same as From"
                />
              </div>
            )}
            <Button
              onClick={() => { addSchedule.mutate(newTime); setNewPostTime(""); setNewPostTimeEnd(""); }}
              disabled={addSchedule.isPending || newDays.length === 0}
              size="sm"
            >
              <Plus className="mr-1 h-4 w-4" />
              Add
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Leave "Post Time" empty to publish immediately. Set both From and To for a random time in that range.
          </p>
          <div className="flex gap-2 flex-wrap">
            {WEEKDAYS.map((day) => (
              <label key={day.value} className="flex items-center gap-1 text-sm cursor-pointer">
                <Checkbox
                  checked={newDays.includes(day.value)}
                  onCheckedChange={(checked) =>
                    setNewDays(checked
                      ? [...newDays, day.value].sort()
                      : newDays.filter((d) => d !== day.value)
                    )
                  }
                />
                {day.label}
              </label>
            ))}
          </div>
        </div>

        {/* Existing schedules */}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : schedules && schedules.length > 0 ? (
          <div className="space-y-2">
            {schedules.map((schedule) => {
              const timeDisplay = schedule.time_utc.slice(0, 5); // HH:MM
              const postTimeRaw = (schedule as any).scheduled_post_time;
              const postTimeEndRaw = (schedule as any).scheduled_post_time_end;
              const postTimeDisplay = postTimeRaw ? postTimeRaw.slice(0, 5) : null;
              const postTimeEndDisplay = postTimeEndRaw ? postTimeEndRaw.slice(0, 5) : null;
              const lastTriggered = schedule.last_triggered_at
                ? new Date(schedule.last_triggered_at).toLocaleString()
                : "Never";

              const scheduleDays: number[] = (schedule as any).days_of_week || [0,1,2,3,4,5,6];
              const daysLabel = scheduleDays.length === 7
                ? "Every day"
                : WEEKDAYS.filter((d) => scheduleDays.includes(d.value)).map((d) => d.label).join(", ");

              const postLabel = postTimeDisplay
                ? postTimeEndDisplay
                  ? `Post ${postTimeDisplay}–${postTimeEndDisplay}`
                  : `Post at ${postTimeDisplay}`
                : "Post immediately";

              return (
                <div
                  key={schedule.id}
                  className="rounded-lg border p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Switch
                        checked={schedule.is_enabled}
                        onCheckedChange={(checked) =>
                          toggleSchedule.mutate({ id: schedule.id, enabled: checked })
                        }
                      />
                      <div>
                        <p className="font-medium text-sm">
                          Run {timeDisplay} · {daysLabel} → {postLabel}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Last triggered: {lastTriggered}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Input
                        type="time"
                        value={postTimeDisplay || ""}
                        onChange={(e) => {
                          const val = e.target.value;
                          updatePostTime.mutate({
                            id: schedule.id,
                            time: val ? val + ":00" : null,
                            timeEnd: val ? undefined : null, // clear end if clearing start
                          });
                        }}
                        className="w-[110px] h-8 text-xs"
                        placeholder="From"
                      />
                      {postTimeDisplay && (
                        <Input
                          type="time"
                          value={postTimeEndDisplay || ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            updatePostTime.mutate({
                              id: schedule.id,
                              time: postTimeRaw,
                              timeEnd: val ? val + ":00" : null,
                            });
                          }}
                          className="w-[110px] h-8 text-xs"
                          placeholder="To"
                        />
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deleteSchedule.mutate(schedule.id)}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex gap-2 flex-wrap pl-10">
                    {WEEKDAYS.map((day) => (
                      <label key={day.value} className="flex items-center gap-1 text-xs cursor-pointer">
                        <Checkbox
                          checked={scheduleDays.includes(day.value)}
                          onCheckedChange={(checked) => {
                            const updated = checked
                              ? [...scheduleDays, day.value].sort()
                              : scheduleDays.filter((d) => d !== day.value);
                            if (updated.length > 0) {
                              updateDays.mutate({ id: schedule.id, days: updated });
                            }
                          }}
                        />
                        {day.label}
                      </label>
                    ))}
                  </div>
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
