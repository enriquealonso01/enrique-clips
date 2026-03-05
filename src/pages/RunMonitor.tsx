import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Play, Pause, Square } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { toast } from "@/hooks/use-toast";

const STEPS = ["plan", "keyframes", "kling", "stitch", "metadata", "publish", "done"] as const;

export default function RunMonitor() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [logFilter, setLogFilter] = useState<string>("all");
  const finalizeInvokedRef = useRef<string | null>(null);

  const { data: run } = useQuery({
    queryKey: ["run", runId],
    queryFn: async () => {
      const { data, error } = await supabase.from("runs").select("*").eq("id", runId!).single();
      if (error) throw error;
      return data;
    },
    enabled: !!runId,
    refetchInterval: 5000,
  });

  const isActive = run?.status === "running" || run?.status === "queued" || run?.status === "paused";
  const isKlingStep = run?.current_step === "kling" && run?.status === "running";
  const isPikaPolling = run?.current_step === "kling" && run?.status === "running";

  // Auto-poll Kling tasks when in kling step
  useEffect(() => {
    if (!isKlingStep || !runId) return;

    const pollKling = async () => {
      try {
        const { data, error } = await supabase.functions.invoke("poll-kling", {
          body: { run_id: runId },
        });
        if (data) {
          queryClient.invalidateQueries({ queryKey: ["run", runId] });
          queryClient.invalidateQueries({ queryKey: ["scenes", runId] });
          queryClient.invalidateQueries({ queryKey: ["run-logs", runId] });
        }
      } catch (err) {
        console.error("Poll-kling error:", err);
      }
    };

    pollKling();
    const interval = setInterval(pollKling, 15000);
    return () => clearInterval(interval);
  }, [isKlingStep, runId, queryClient]);

  // Auto-poll Pika tasks when in kling step (Pika uses same step name)
  useEffect(() => {
    if (!isPikaPolling || !runId) return;

    const pollPika = async () => {
      try {
        const { data, error } = await supabase.functions.invoke("poll-pika", {
          body: { run_id: runId },
        });
        if (data) {
          queryClient.invalidateQueries({ queryKey: ["run", runId] });
          queryClient.invalidateQueries({ queryKey: ["scenes", runId] });
          queryClient.invalidateQueries({ queryKey: ["run-logs", runId] });
        }
      } catch (err) {
        console.error("Poll-pika error:", err);
      }
    };

    pollPika();
    const interval = setInterval(pollPika, 20000);
    return () => clearInterval(interval);
  }, [isPikaPolling, runId, queryClient]);

  // Fallback: invoke finalize-video once when step reaches stitch/metadata/publish
  // Only fallback-invoke for metadata/publish — stitch is handled by the pipeline chain.
  // Including "stitch" here caused duplicate execution that overwrote correct results.
  const needsFinalize = run?.status === "running" && 
    ["metadata", "publish"].includes(run?.current_step);
  useEffect(() => {
    if (!needsFinalize || !runId || finalizeInvokedRef.current === runId) return;
    finalizeInvokedRef.current = runId;
    const invoke = async () => {
      try {
        console.log("Client fallback: invoking finalize-video for", runId);
        await supabase.functions.invoke("finalize-video", { body: { run_id: runId } });
        queryClient.invalidateQueries({ queryKey: ["run", runId] });
      } catch (err) {
        console.error("Finalize-video fallback failed:", err);
      }
    };
    // Delay 5s to give server-side chain a chance first
    const timer = setTimeout(invoke, 5000);
    return () => clearTimeout(timer);
  }, [needsFinalize, runId, queryClient]);


  const { data: scenes } = useQuery({
    queryKey: ["scenes", runId],
    queryFn: async () => {
      const { data, error } = await supabase.from("scenes").select("*").eq("run_id", runId!).order("scene_index");
      if (error) throw error;
      return data;
    },
    enabled: !!runId,
    refetchInterval: 5000,
  });

  const { data: logs } = useQuery({
    queryKey: ["run-logs", runId, logFilter],
    queryFn: async () => {
      let q = supabase.from("run_logs").select("*").eq("run_id", runId!).order("created_at", { ascending: false }).limit(100);
      if (logFilter !== "all") q = q.eq("level", logFilter as any);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
    enabled: !!runId,
    refetchInterval: 5000,
  });

  const { data: publishJobs } = useQuery({
    queryKey: ["publish-jobs", runId],
    queryFn: async () => {
      const { data, error } = await supabase.from("publish_jobs").select("*").eq("run_id", runId!);
      if (error) throw error;
      return data;
    },
    enabled: !!runId,
    refetchInterval: 5000,
  });

  // Realtime subscriptions
  useEffect(() => {
    if (!runId) return;

    const channel = supabase
      .channel(`run-monitor-${runId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'runs', filter: `id=eq.${runId}` }, () => {
        queryClient.invalidateQueries({ queryKey: ["run", runId] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scenes', filter: `run_id=eq.${runId}` }, () => {
        queryClient.invalidateQueries({ queryKey: ["scenes", runId] });
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'run_logs', filter: `run_id=eq.${runId}` }, () => {
        queryClient.invalidateQueries({ queryKey: ["run-logs", runId, logFilter] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'publish_jobs', filter: `run_id=eq.${runId}` }, () => {
        queryClient.invalidateQueries({ queryKey: ["publish-jobs", runId] });
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [runId, logFilter, queryClient]);

  const updateStatus = async (status: string) => {
    const updates: Record<string, unknown> = { status };
    if (status === "stopped") updates.finished_at = new Date().toISOString();
    const { error } = await supabase.from("runs").update(updates).eq("id", runId!);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      queryClient.invalidateQueries({ queryKey: ["run", runId] });
      toast({ title: "Updated", description: `Run ${status}` });
    }
  };

  if (!run) return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading run...</div>;

  const currentStepIndex = STEPS.indexOf(run.current_step);
  const canPause = run.status === "running";
  const canResume = run.status === "paused";
  const canStop = ["running", "paused", "queued"].includes(run.status);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight">Run Monitor</h1>
          <div className="flex items-center gap-3 mt-1">
            <StatusBadge status={run.status} />
            <span className="text-sm text-muted-foreground">Step: {run.current_step}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={!canResume} onClick={() => updateStatus("running")}>
            <Play className="h-3 w-3" />
          </Button>
          <Button size="sm" variant="outline" disabled={!canPause} onClick={() => updateStatus("paused")}>
            <Pause className="h-3 w-3" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={!canStop}>
                <Square className="h-3 w-3" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Stop this run?</AlertDialogTitle>
                <AlertDialogDescription>This will stop the current run. This action cannot be undone.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => updateStatus("stopped")}>Stop Run</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Pipeline Timeline */}
      <Card>
        <CardHeader><CardTitle className="text-base">Pipeline Progress</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Progress value={run.progress_pct} className="h-2" />
          <div className="flex justify-between">
            {STEPS.map((step, i) => (
              <div key={step} className="flex flex-col items-center gap-1">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${
                  i < currentStepIndex ? "bg-success text-success-foreground" :
                  i === currentStepIndex ? "bg-primary text-primary-foreground" :
                  "bg-muted text-muted-foreground"
                }`}>
                  {i + 1}
                </div>
                <span className="text-xs text-muted-foreground capitalize">{step}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Scenes Table */}
      <Card>
        <CardHeader><CardTitle className="text-base">Scenes</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">#</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Behavior</TableHead>
                <TableHead>Density</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Kling Prompt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scenes?.length ? scenes.map((scene) => (
                <TableRow key={scene.id}>
                  <TableCell>{scene.scene_index}</TableCell>
                  <TableCell>{scene.scene_title || "—"}</TableCell>
                  <TableCell>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                      {(scene as any).scene_behavior || "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      {(scene as any).activity_density || "—"}
                    </span>
                  </TableCell>
                  <TableCell><StatusBadge status={scene.status} /></TableCell>
                  <TableCell className="text-muted-foreground text-xs max-w-[200px] truncate" title={scene.kling_prompt || ""}>
                    {scene.kling_prompt || "—"}
                  </TableCell>
                </TableRow>
              )) : (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">No scenes yet</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Logs */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Logs</CardTitle>
          <Select value={logFilter} onValueChange={setLogFilter}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="debug">Debug</SelectItem>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="warn">Warn</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          <div className="max-h-64 overflow-auto space-y-1 font-mono text-xs">
            {logs?.length ? logs.map((log) => (
              <div key={log.id} className={`flex gap-2 py-1 border-b border-border/50 ${
                log.level === "error" ? "text-destructive" : log.level === "warn" ? "text-warning" : "text-muted-foreground"
              }`}>
                <span className="uppercase w-12 shrink-0">{log.level}</span>
                <span className="shrink-0 text-muted-foreground">{new Date(log.created_at).toLocaleTimeString()}</span>
                <span className="text-foreground">{log.message}</span>
              </div>
            )) : (
              <p className="text-muted-foreground py-4 text-center">No logs yet</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Publish Results */}
      {publishJobs && publishJobs.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Publish Results</CardTitle></CardHeader>
          <CardContent>
            {publishJobs.map((job) => (
              <div key={job.id} className="flex items-center gap-4">
                <StatusBadge status={job.status} />
                <span className="text-sm text-muted-foreground">
                  {job.uploadpost_request_id ? `Request: ${job.uploadpost_request_id}` : "Pending"}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
