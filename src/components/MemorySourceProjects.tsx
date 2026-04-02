import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, Plus } from "lucide-react";
import { useState } from "react";

interface Props {
  currentProjectId: string;
  sourceProjectIds: string[];
  onChange: (ids: string[]) => void;
}

export function MemorySourceProjects({ currentProjectId, sourceProjectIds, onChange }: Props) {
  const [adding, setAdding] = useState(false);

  const { data: allProjects } = useQuery({
    queryKey: ["all-projects"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("projects")
        .select("id, title")
        .order("title");
      if (error) throw error;
      return data;
    },
  });

  const availableProjects = (allProjects || []).filter(
    (p) => p.id !== currentProjectId && !sourceProjectIds.includes(p.id)
  );

  const selectedProjects = (allProjects || []).filter((p) =>
    sourceProjectIds.includes(p.id)
  );

  return (
    <div className="space-y-2">
      <Label>Memory Source Projects</Label>
      <p className="text-xs text-muted-foreground">
        Include memory from other projects. Runs from all selected projects will be combined with this project's runs, sorted by date, up to the lookback count.
      </p>
      {selectedProjects.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedProjects.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-1 rounded-md border bg-muted px-2 py-1 text-sm"
            >
              <span>{p.title}</span>
              <button
                onClick={() => onChange(sourceProjectIds.filter((id) => id !== p.id))}
                className="ml-1 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {adding ? (
        <Select
          onValueChange={(id) => {
            onChange([...sourceProjectIds, id]);
            setAdding(false);
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select a project..." />
          </SelectTrigger>
          <SelectContent>
            {availableProjects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAdding(true)}
          disabled={availableProjects.length === 0}
        >
          <Plus className="mr-1 h-3 w-3" /> Add Project
        </Button>
      )}
    </div>
  );
}
