import { supabase } from "@/integrations/supabase/client";

// In-memory cache: username -> page_id (or null)
const cache = new Map<string, string | null>();

export async function getFacebookPageIdForUsername(username: string): Promise<string | null> {
  if (cache.has(username)) return cache.get(username) ?? null;

  const [projRes, storyRes] = await Promise.all([
    supabase
      .from("projects")
      .select("publish_defaults")
      .eq("uploadpost_profile_username", username)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("story_projects")
      .select("publish_defaults")
      .eq("uploadpost_profile_username", username)
      .limit(1)
      .maybeSingle(),
  ]);

  const fromProj = (projRes.data as any)?.publish_defaults?.facebook?.facebook_page_id;
  const fromStory = (storyRes.data as any)?.publish_defaults?.facebook?.facebook_page_id;
  const pageId = (fromProj || fromStory || null) as string | null;
  cache.set(username, pageId);
  return pageId;
}
