

## Plan: Analytics Dashboard for Upload-Post Profiles

A new top-level page that aggregates Upload-Post analytics across multiple profiles, with a "Totals" overview tab plus a tab per profile.

### Architecture

```text
Sidebar → "Analytics" route (/analytics)
  ├── Tab: Totals (aggregate all profiles)
  ├── Tab: <profile_username_1>
  ├── Tab: <profile_username_2>
  └── [+ Add Profile] button → prompts for profile_username
```

### Backend

**1. New table `analytics_profiles`** — stores which profile usernames the user has added to track.
- Columns: `id`, `profile_username` (unique), `display_name`, `created_at`
- RLS: authenticated full access (matches existing pattern)

**2. New edge function `upload-post-analytics`** — proxies Upload-Post API calls so the JWT (`UPLOADPOST_API_KEY` secret — already used elsewhere) stays server-side.
- `GET ?action=profile&username=X&platforms=...` → calls `/api/analytics/{username}`
- `GET ?action=totals&username=X&period=...&breakdown=true` → calls `/api/uploadposts/total-impressions/{username}`
- `GET ?action=metrics-config` → calls `/api/uploadposts/platform-metrics` (cached)
- Will reuse the existing Upload-Post auth header pattern from current integration.

### Frontend

**3. New page `src/pages/AnalyticsDashboard.tsx`**
- Shadcn `Tabs` with dynamic tabs from `analytics_profiles` + a static "Totals" tab + "Add Profile" button (Dialog with single input).
- Date range selector (last_day / last_week / last_month / last_3months / last_year) using shadcn buttons or Select.
- Platform multi-select filter (chips).

**4. Per-profile tab content** — professional grade, includes:
- **KPI cards row**: Total Impressions, Followers, Likes, Comments, Shares, Saves, Profile Views (computed across selected platforms, deduplicated using `metric_type` to avoid double-counting).
- **Reach/Views over time** — Recharts line chart from `reach_timeseries` per platform (overlaid lines, one per platform, color-coded).
- **Per-platform breakdown** — Recharts bar chart comparing impressions/followers/engagement across platforms.
- **Engagement composition** — stacked bar (likes/comments/shares/saves) per platform.
- **Platform detail cards** — one card per platform showing all `available_metrics` with `metric_labels` from the API.

**5. Totals tab** — aggregates across all added profiles:
- Combined KPI cards (sum across profiles using `total-impressions` endpoint per profile, then summed).
- "Impressions by profile" bar chart.
- "Impressions by platform" pie/bar chart (summed across profiles).
- Time-series line chart (one line per profile).

**6. Sidebar update** — add "Analytics" entry with `BarChart3` icon between Stories and Settings.

### Technical Notes

- Use `@tanstack/react-query` (already in stack) for fetching with 5-min stale time and per-tab caching.
- All API calls go through the new edge function — never expose the Upload-Post JWT to the browser.
- Date filtering on `reach_timeseries` is done client-side per the Upload-Post docs.
- When aggregating across platforms, group by `metric_type` to avoid mixing reach + views + impressions into one number (show separate "Unique Reach" and "Views" totals when both exist, or use the `/total-impressions` endpoint which already deduplicates).
- Loading states with `Skeleton`, error states with `Alert`, empty state for "no profiles added yet" on first visit.

### Files to Create / Modify

- **Create** `supabase/functions/upload-post-analytics/index.ts`
- **Create** `src/pages/AnalyticsDashboard.tsx`
- **Create** `src/components/analytics/ProfileTab.tsx`
- **Create** `src/components/analytics/TotalsTab.tsx`
- **Create** `src/components/analytics/AddProfileDialog.tsx`
- **Create** `src/components/analytics/KpiCard.tsx`
- **Modify** `src/components/AppSidebar.tsx` (add Analytics nav item)
- **Modify** `src/App.tsx` (add `/analytics` route)
- **Migration**: create `analytics_profiles` table with RLS

