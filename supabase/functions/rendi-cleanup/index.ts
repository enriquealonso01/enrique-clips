// rendi-cleanup — empties Rendi file storage (the account-level stored files
// that count against the plan's storage quota). Created 2026-06-12 after the
// quota filled up and every nightly finalize failed with:
//   "Rendi submit failed (403): Account has passed its' storage quota"
// Invoke with service role. Body: { "dry_run": true } to only count files.

const RENDI_BASE = "https://api.rendi.dev/v1";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const RENDI_API_KEY = Deno.env.get("RENDI_API_KEY");
  if (!RENDI_API_KEY) return json({ error: "RENDI_API_KEY not set" }, 500);

  let dryRun = false;
  try {
    const body = await req.json();
    dryRun = body?.dry_run === true;
  } catch {
    // empty body = real run
  }

  const headers = { "X-API-KEY": RENDI_API_KEY, "Content-Type": "application/json" };

  let filesSeen = 0;
  let totalMb = 0;
  let deletedCount = 0;
  const errors: string[] = [];
  const statusCounts: Record<string, number> = {};

  // Each round: list up to 1000 files, bulk-delete them, repeat until the
  // listing comes back empty. Capped at 50 rounds (50k files) as a backstop.
  for (let round = 0; round < 50; round++) {
    // After a bulk-delete the next page starts at 0 again; in dry-run we
    // paginate forward with offset to count everything.
    const offset = dryRun ? filesSeen : 0;
    const listResp = await fetch(`${RENDI_BASE}/files?limit=1000&offset=${offset}`, { headers });
    if (!listResp.ok) {
      errors.push(`list failed (${listResp.status}): ${(await listResp.text()).substring(0, 200)}`);
      break;
    }
    const listData = await listResp.json();
    const files: any[] = Array.isArray(listData) ? listData : (listData?.files ?? []);
    if (files.length === 0) break;

    filesSeen += files.length;
    for (const f of files) {
      totalMb += typeof f.size_mbytes === "number" ? f.size_mbytes : 0;
      const s = String(f.status ?? "unknown");
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    }

    if (dryRun) {
      if (files.length < 1000) break;
      continue;
    }

    const fileIds = files.map((f) => f.file_id).filter(Boolean);
    if (fileIds.length === 0) break;
    const delResp = await fetch(`${RENDI_BASE}/files/bulk-delete`, {
      method: "POST",
      headers,
      body: JSON.stringify({ file_ids: fileIds }),
    });
    if (!delResp.ok) {
      errors.push(`bulk-delete failed (${delResp.status}): ${(await delResp.text()).substring(0, 200)}`);
      break;
    }
    const delData = await delResp.json();
    const deletedIds: string[] = delData?.deleted_file_ids ?? [];
    deletedCount += deletedIds.length;
    // If nothing got deleted this round, stop instead of looping forever.
    if (deletedIds.length === 0) {
      errors.push(`bulk-delete returned 0 deletions for ${fileIds.length} ids — stopping`);
      break;
    }
  }

  return json({
    dry_run: dryRun,
    files_seen: filesSeen,
    total_mbytes: Math.round(totalMb * 10) / 10,
    deleted_count: deletedCount,
    status_counts: statusCounts,
    errors,
  });
});
