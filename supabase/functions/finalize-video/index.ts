import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ===== MP4 CONCATENATION UTILITIES =====

function readU32(d: Uint8Array, o: number): number {
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
}

function writeU32(d: Uint8Array, o: number, v: number) {
  d[o] = (v >>> 24) & 0xff;
  d[o + 1] = (v >>> 16) & 0xff;
  d[o + 2] = (v >>> 8) & 0xff;
  d[o + 3] = v & 0xff;
}

function boxType(d: Uint8Array, o: number): string {
  return String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
}

function makeBoxType(type: string): Uint8Array {
  return new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]);
}

interface Box {
  type: string;
  start: number;
  size: number;
  hdr: number;
}

function scanBoxes(data: Uint8Array, from: number, to: number): Box[] {
  const result: Box[] = [];
  let pos = from;
  while (pos + 8 <= to) {
    let size = readU32(data, pos);
    const type = boxType(data, pos + 4);
    let hdr = 8;
    if (size === 1 && pos + 16 <= to) {
      size = readU32(data, pos + 12);
      hdr = 16;
    }
    if (size === 0) size = to - pos;
    if (size < 8 || pos + size > to) break;
    result.push({ type, start: pos, size, hdr });
    pos += size;
  }
  return result;
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "dinf", "edts", "udta"]);

function findBox(data: Uint8Array, boxes: Box[], ...path: string[]): Box | null {
  let current = boxes;
  for (let i = 0; i < path.length; i++) {
    const found = current.find((b) => b.type === path[i]);
    if (!found) return null;
    if (i < path.length - 1) {
      current = scanBoxes(data, found.start + found.hdr, found.start + found.size);
    } else {
      return found;
    }
  }
  return null;
}

// Parse sample table entries from stbl sub-boxes
function parseStts(data: Uint8Array, box: Box): number[][] {
  const base = box.start + box.hdr;
  const count = readU32(data, base + 4);
  const entries: number[][] = [];
  for (let i = 0; i < count; i++) {
    entries.push([readU32(data, base + 8 + i * 8), readU32(data, base + 8 + i * 8 + 4)]);
  }
  return entries;
}

function parseStsz(data: Uint8Array, box: Box): { sampleSize: number; sizes: number[] } {
  const base = box.start + box.hdr;
  const sampleSize = readU32(data, base + 4);
  const count = readU32(data, base + 8);
  const sizes: number[] = [];
  if (sampleSize === 0) {
    for (let i = 0; i < count; i++) sizes.push(readU32(data, base + 12 + i * 4));
  }
  return { sampleSize, sizes };
}

function parseStsc(data: Uint8Array, box: Box): number[][] {
  const base = box.start + box.hdr;
  const count = readU32(data, base + 4);
  const entries: number[][] = [];
  for (let i = 0; i < count; i++) {
    const o = base + 8 + i * 12;
    entries.push([readU32(data, o), readU32(data, o + 4), readU32(data, o + 8)]);
  }
  return entries;
}

function parseStco(data: Uint8Array, box: Box): number[] {
  const base = box.start + box.hdr;
  const count = readU32(data, base + 4);
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(readU32(data, base + 8 + i * 4));
  return offsets;
}

function parseStss(data: Uint8Array, box: Box): number[] {
  const base = box.start + box.hdr;
  const count = readU32(data, base + 4);
  const samples: number[] = [];
  for (let i = 0; i < count; i++) samples.push(readU32(data, base + 8 + i * 4));
  return samples;
}

// Build sample table box from entries
function buildStts(entries: number[][]): Uint8Array {
  const size = 8 + 8 + entries.length * 8;
  const buf = new Uint8Array(size);
  writeU32(buf, 0, size);
  buf.set(makeBoxType("stts"), 4);
  writeU32(buf, 12, entries.length);
  for (let i = 0; i < entries.length; i++) {
    writeU32(buf, 16 + i * 8, entries[i][0]);
    writeU32(buf, 16 + i * 8 + 4, entries[i][1]);
  }
  return buf;
}

function buildStsz(sampleSize: number, sizes: number[]): Uint8Array {
  const hasIndividual = sampleSize === 0;
  const size = 8 + 12 + (hasIndividual ? sizes.length * 4 : 0);
  const buf = new Uint8Array(size);
  writeU32(buf, 0, size);
  buf.set(makeBoxType("stsz"), 4);
  writeU32(buf, 12, sampleSize);
  writeU32(buf, 16, sizes.length);
  if (hasIndividual) {
    for (let i = 0; i < sizes.length; i++) writeU32(buf, 20 + i * 4, sizes[i]);
  }
  return buf;
}

function buildStsc(entries: number[][]): Uint8Array {
  const size = 8 + 8 + entries.length * 12;
  const buf = new Uint8Array(size);
  writeU32(buf, 0, size);
  buf.set(makeBoxType("stsc"), 4);
  writeU32(buf, 12, entries.length);
  for (let i = 0; i < entries.length; i++) {
    const o = 16 + i * 12;
    writeU32(buf, o, entries[i][0]);
    writeU32(buf, o + 4, entries[i][1]);
    writeU32(buf, o + 8, entries[i][2]);
  }
  return buf;
}

function buildStco(offsets: number[]): Uint8Array {
  const size = 8 + 8 + offsets.length * 4;
  const buf = new Uint8Array(size);
  writeU32(buf, 0, size);
  buf.set(makeBoxType("stco"), 4);
  writeU32(buf, 12, offsets.length);
  for (let i = 0; i < offsets.length; i++) writeU32(buf, 16 + i * 4, offsets[i]);
  return buf;
}

function buildStss(samples: number[]): Uint8Array {
  const size = 8 + 8 + samples.length * 4;
  const buf = new Uint8Array(size);
  writeU32(buf, 0, size);
  buf.set(makeBoxType("stss"), 4);
  writeU32(buf, 12, samples.length);
  for (let i = 0; i < samples.length; i++) writeU32(buf, 16 + i * 4, samples[i]);
  return buf;
}

// Rebuild a container box by replacing specific children
function rebuildContainer(
  data: Uint8Array,
  container: Box,
  replacements: Map<string, Uint8Array>
): Uint8Array {
  const children = scanBoxes(data, container.start + container.hdr, container.start + container.size);
  const parts: Uint8Array[] = [];

  // Copy header bytes (version/flags if fullbox, or just box header)
  const headerBytes = data.slice(container.start + 8, container.start + container.hdr);

  for (const child of children) {
    if (replacements.has(child.type)) {
      parts.push(replacements.get(child.type)!);
    } else if (CONTAINERS.has(child.type)) {
      // Recurse into container children
      const rebuilt = rebuildContainer(data, child, replacements);
      parts.push(rebuilt);
    } else {
      parts.push(data.slice(child.start, child.start + child.size));
    }
  }

  const contentSize = parts.reduce((s, p) => s + p.length, 0);
  const totalSize = 8 + headerBytes.length + contentSize;
  const result = new Uint8Array(totalSize);
  writeU32(result, 0, totalSize);
  result.set(makeBoxType(container.type), 4);
  result.set(headerBytes, 8);

  let offset = 8 + headerBytes.length;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// Get total sample count from a track's stbl
function getTotalSamples(data: Uint8Array, stbl: Box): number {
  const stszBox = findBox(data, scanBoxes(data, stbl.start + stbl.hdr, stbl.start + stbl.size), "stsz");
  if (!stszBox) return 0;
  const base = stszBox.start + stszBox.hdr;
  return readU32(data, base + 8);
}

// Get total chunk count from stco
function getTotalChunks(data: Uint8Array, stbl: Box): number {
  const stcoBox = findBox(data, scanBoxes(data, stbl.start + stbl.hdr, stbl.start + stbl.size), "stco");
  if (!stcoBox) return 0;
  const base = stcoBox.start + stcoBox.hdr;
  return readU32(data, base + 4);
}

function concatenateMP4(files: Uint8Array[]): Uint8Array {
  if (files.length <= 1) return files[0];

  const allParsed = files.map((f) => ({ data: f, boxes: scanBoxes(f, 0, f.length) }));

  // Extract ftyp from first file
  const ftypBox = allParsed[0].boxes.find((b) => b.type === "ftyp");
  const ftypData = ftypBox
    ? allParsed[0].data.slice(ftypBox.start, ftypBox.start + ftypBox.size)
    : new Uint8Array(0);

  // Combine mdat content from all files
  const mdatContents: Uint8Array[] = [];
  const mdatOffsets: number[] = []; // Start offset of each file's mdat content in the combined mdat
  let mdatPos = 0;
  for (const p of allParsed) {
    const mdat = p.boxes.find((b) => b.type === "mdat");
    if (mdat) {
      mdatOffsets.push(mdatPos);
      const content = p.data.slice(mdat.start + mdat.hdr, mdat.start + mdat.size);
      mdatContents.push(content);
      mdatPos += content.length;
    } else {
      mdatOffsets.push(mdatPos);
    }
  }

  // We'll place: ftyp + moov + mdat
  // So mdat starts at: ftypData.length + moovSize
  // We need moov size first, so build moov, then calculate

  // Get first file's moov and track structure
  const firstData = allParsed[0].data;
  const firstBoxes = allParsed[0].boxes;
  const moovBox = firstBoxes.find((b) => b.type === "moov")!;
  const moovChildren = scanBoxes(firstData, moovBox.start + moovBox.hdr, moovBox.start + moovBox.size);
  const trakBoxes = moovChildren.filter((b) => b.type === "trak");

  // For each track, merge sample tables from all files
  const trackReplacements: Map<string, Uint8Array>[] = trakBoxes.map(() => new Map());

  for (let t = 0; t < trakBoxes.length; t++) {
    const trak = trakBoxes[t];
    const stbl = findBox(
      firstData,
      scanBoxes(firstData, trak.start + trak.hdr, trak.start + trak.size),
      "mdia",
      "minf",
      "stbl"
    );
    if (!stbl) continue;

    const stblChildren = scanBoxes(firstData, stbl.start + stbl.hdr, stbl.start + stbl.size);

    // Merge stts
    let mergedStts: number[][] = [];
    // Merge stsz
    let mergedSampleSize = 0;
    let mergedSizes: number[] = [];
    let firstFile = true;
    // Merge stsc
    let mergedStsc: number[][] = [];
    // Merge stco
    let mergedStco: number[] = [];
    // Merge stss
    let mergedStss: number[] = [];
    let hasStss = false;

    let cumulativeSamples = 0;
    let cumulativeChunks = 0;

    for (let f = 0; f < allParsed.length; f++) {
      const fData = allParsed[f].data;
      const fBoxes = allParsed[f].boxes;
      const fMoov = fBoxes.find((b) => b.type === "moov");
      if (!fMoov) continue;

      const fMoovChildren = scanBoxes(fData, fMoov.start + fMoov.hdr, fMoov.start + fMoov.size);
      const fTraks = fMoovChildren.filter((b) => b.type === "trak");
      if (t >= fTraks.length) continue;

      const fTrak = fTraks[t];
      const fStbl = findBox(
        fData,
        scanBoxes(fData, fTrak.start + fTrak.hdr, fTrak.start + fTrak.size),
        "mdia",
        "minf",
        "stbl"
      );
      if (!fStbl) continue;
      const fStblChildren = scanBoxes(fData, fStbl.start + fStbl.hdr, fStbl.start + fStbl.size);

      // stts
      const sttsBox = fStblChildren.find((b) => b.type === "stts");
      if (sttsBox) mergedStts = mergedStts.concat(parseStts(fData, sttsBox));

      // stsz
      const stszBox = fStblChildren.find((b) => b.type === "stsz");
      if (stszBox) {
        const parsed = parseStsz(fData, stszBox);
        if (firstFile) {
          mergedSampleSize = parsed.sampleSize;
          mergedSizes = parsed.sizes;
        } else {
          if (parsed.sampleSize !== mergedSampleSize) {
            // Different sample sizes — fall back to per-sample
            if (mergedSampleSize !== 0 && mergedSizes.length === 0) {
              // Expand first file's constant size
              const prevCount = cumulativeSamples;
              mergedSizes = new Array(prevCount).fill(mergedSampleSize);
              mergedSampleSize = 0;
            }
            mergedSizes = mergedSizes.concat(parsed.sizes.length > 0 ? parsed.sizes : []);
          } else {
            mergedSizes = mergedSizes.concat(parsed.sizes);
          }
        }
      }

      // stsc
      const stscBox = fStblChildren.find((b) => b.type === "stsc");
      if (stscBox) {
        const entries = parseStsc(fData, stscBox);
        for (const e of entries) {
          mergedStsc.push([e[0] + cumulativeChunks, e[1], e[2]]);
        }
      }

      // stco — these will need offset adjustment later
      const stcoBox = fStblChildren.find((b) => b.type === "stco");
      if (stcoBox) {
        const offsets = parseStco(fData, stcoBox);
        // Find this file's mdat position in the original file
        const fMdat = fBoxes.find((b) => b.type === "mdat");
        const origMdatStart = fMdat ? fMdat.start + fMdat.hdr : 0;
        // Offsets are relative to file start, pointing into mdat
        // We need to adjust them to point into the combined mdat
        for (const off of offsets) {
          const relativeInMdat = off - origMdatStart;
          // Will be adjusted after we know final moov size
          mergedStco.push(relativeInMdat + mdatOffsets[f]);
        }
      }

      // stss
      const stssBox = fStblChildren.find((b) => b.type === "stss");
      if (stssBox) {
        hasStss = true;
        const samples = parseStss(fData, stssBox);
        for (const s of samples) mergedStss.push(s + cumulativeSamples);
      }

      // Count samples and chunks for offset adjustments
      cumulativeSamples += getTotalSamples(fData, fStbl);
      cumulativeChunks += getTotalChunks(fData, fStbl);
      firstFile = false;
    }

    // Build replacement boxes
    const replacements = new Map<string, Uint8Array>();
    replacements.set("stts", buildStts(mergedStts));
    replacements.set("stsz", buildStsz(mergedSampleSize, mergedSizes));
    replacements.set("stsc", buildStsc(mergedStsc));
    replacements.set("stco", buildStco(mergedStco)); // offsets relative to mdat start, adjusted below
    if (hasStss) replacements.set("stss", buildStss(mergedStss));

    trackReplacements[t] = replacements;
  }

  // Build the new moov by replacing stbl contents in each trak
  // First, build each trak's stbl with merged tables
  const globalReplacements = new Map<string, Uint8Array>();

  // We need to rebuild moov with updated traks
  // Strategy: rebuild moov container recursively, replacing stbl children
  // Combine all track replacements into a single pass

  // Build moov with replacements
  // Since rebuildContainer works recursively, we need to pass replacements that match stbl children
  // We'll do this by first rebuilding each stbl, then each trak, then moov

  const rebuiltTraks: Uint8Array[] = [];
  for (let t = 0; t < trakBoxes.length; t++) {
    const replacements = trackReplacements[t];
    if (replacements.size === 0) {
      rebuiltTraks.push(firstData.slice(trakBoxes[t].start, trakBoxes[t].start + trakBoxes[t].size));
      continue;
    }

    // Find stbl and rebuild it
    const trak = trakBoxes[t];
    const trakChildren = scanBoxes(firstData, trak.start + trak.hdr, trak.start + trak.size);
    const mdia = trakChildren.find((b) => b.type === "mdia");
    if (!mdia) {
      rebuiltTraks.push(firstData.slice(trak.start, trak.start + trak.size));
      continue;
    }
    // Rebuild stbl inside mdia > minf > stbl
    const rebuiltTrak = rebuildContainer(firstData, trak, replacements);
    rebuiltTraks.push(rebuiltTrak);
  }

  // Rebuild moov with new traks
  const moovParts: Uint8Array[] = [];
  let trakIndex = 0;
  for (const child of moovChildren) {
    if (child.type === "trak") {
      moovParts.push(rebuiltTraks[trakIndex++]);
    } else {
      moovParts.push(firstData.slice(child.start, child.start + child.size));
    }
  }

  const moovContentSize = moovParts.reduce((s, p) => s + p.length, 0);
  const moovSize = 8 + moovContentSize;
  const newMoov = new Uint8Array(moovSize);
  writeU32(newMoov, 0, moovSize);
  newMoov.set(makeBoxType("moov"), 4);
  let moovOffset = 8;
  for (const part of moovParts) {
    newMoov.set(part, moovOffset);
    moovOffset += part.length;
  }

  // Now we know the layout: ftyp + moov + mdat
  const mdatContentSize = mdatContents.reduce((s, c) => s + c.length, 0);
  const mdatTotalSize = 8 + mdatContentSize;
  const mdatStartInFile = ftypData.length + moovSize;

  // Adjust stco offsets in the moov — they currently point relative to combined mdat start
  // Need to add mdatStartInFile + 8 (mdat header) to each
  // Walk through moov to find all stco boxes and adjust
  const moovBoxesFinal = scanBoxes(newMoov, 8, newMoov.length);
  for (const trak of moovBoxesFinal.filter((b) => b.type === "trak")) {
    const stcoBox = findBox(
      newMoov,
      scanBoxes(newMoov, trak.start + trak.hdr, trak.start + trak.size),
      "mdia",
      "minf",
      "stbl",
      "stco"
    );
    if (stcoBox) {
      const base = stcoBox.start + stcoBox.hdr;
      const count = readU32(newMoov, base + 4);
      for (let i = 0; i < count; i++) {
        const pos = base + 8 + i * 4;
        const currentVal = readU32(newMoov, pos);
        writeU32(newMoov, pos, currentVal + mdatStartInFile + 8);
      }
    }
  }

  // Build mdat
  const mdatHeader = new Uint8Array(8);
  writeU32(mdatHeader, 0, mdatTotalSize);
  mdatHeader.set(makeBoxType("mdat"), 4);

  // Assemble final file
  const totalSize = ftypData.length + moovSize + mdatTotalSize;
  const output = new Uint8Array(totalSize);
  let pos = 0;
  output.set(ftypData, pos);
  pos += ftypData.length;
  output.set(newMoov, pos);
  pos += moovSize;
  output.set(mdatHeader, pos);
  pos += 8;
  for (const content of mdatContents) {
    output.set(content, pos);
    pos += content.length;
  }

  return output;
}

// ===== RETRY HELPER =====

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, delayMs = 1000): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
      }
    }
  }
  throw lastError!;
}

// ===== MAIN HANDLER =====

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

  let runId: string;
  try {
    const body = await req.json();
    runId = body.run_id;
  } catch {
    return json({ error: "run_id required" }, 400);
  }

  async function log(level: string, message: string, data?: unknown) {
    await supabase
      .from("run_logs")
      .insert({ run_id: runId, level: level as any, message, data: data ? (data as any) : null });
  }

  async function updateRun(updates: Record<string, unknown>) {
    await supabase.from("runs").update(updates).eq("id", runId);
  }

  try {
    const { data: run } = await supabase.from("runs").select("*").eq("id", runId).single();
    if (!run) return json({ error: "Run not found" }, 404);
    if (run.status !== "running") return json({ status: "not_running" });

    const { data: project } = await supabase.from("projects").select("*").eq("id", run.project_id).single();
    if (!project) {
      await log("error", "Project not found");
      await updateRun({ status: "failed", error_message: "Project not found" });
      return json({ error: "Project not found" }, 404);
    }

    // ===== STEP 4: STITCH =====
    if (run.current_step === "stitch") {
      await log("info", "Step 4/7: Stitching video clips...");
      try {
        const { data: clipAssets } = await supabase
          .from("assets")
          .select("*, scenes!inner(scene_index)")
          .eq("run_id", runId)
          .eq("type", "clip")
          .order("scene_index", { referencedTable: "scenes", ascending: true });

        const completedClips = (clipAssets || []).filter(
          (a: any) => (a.metadata as any)?.status === "completed"
        );

        if (completedClips.length === 0) {
          await log("warn", "No completed clips — skipping stitch.");
        } else {
          // Download all clips concurrently (batch of 3)
          const clipBuffers: Uint8Array[] = [];
          for (let i = 0; i < completedClips.length; i += 3) {
            const batch = completedClips.slice(i, i + 3);
            const buffers = await Promise.all(
              batch.map(async (clip: any) => {
                const { data: urlData } = supabase.storage
                  .from("project-assets")
                  .getPublicUrl(clip.supabase_path);
                const resp = await withRetry(() => fetch(urlData.publicUrl));
                return new Uint8Array(await resp.arrayBuffer());
              })
            );
            clipBuffers.push(...buffers);
          }

          let finalVideo: Uint8Array;
          if (clipBuffers.length === 1) {
            finalVideo = clipBuffers[0];
            await log("info", "Single clip — using directly as final video.");
          } else {
            await log("info", `Concatenating ${clipBuffers.length} clips via MP4 box-level merge...`);
            try {
              finalVideo = concatenateMP4(clipBuffers);
              await log("info", `MP4 concatenation succeeded. Output: ${(finalVideo.length / 1024 / 1024).toFixed(1)}MB`);
            } catch (concatErr) {
              await log("warn", `MP4 concatenation failed: ${concatErr.message} — using first clip as fallback.`);
              finalVideo = clipBuffers[0];
            }
          }

          const finalPath = `${project.id}/final/${runId}/final-video.mp4`;
          const { error: upErr } = await supabase.storage
            .from("project-assets")
            .upload(finalPath, finalVideo, { contentType: "video/mp4", upsert: true });

          if (!upErr) {
            await supabase.from("assets").insert({
              supabase_path: finalPath,
              type: "final_video" as any,
              run_id: runId,
              metadata: {
                scene_count: completedClips.length,
                source_clips: completedClips.map((c: any) => c.supabase_path),
                size_bytes: finalVideo.length,
              },
            });
            await log("info", "Final video uploaded successfully.");
          } else {
            await log("error", `Final video upload failed: ${upErr.message}`);
          }
        }
      } catch (err) {
        await log("warn", `Stitch step failed: ${err.message} — continuing.`);
      }

      await updateRun({ current_step: "metadata", progress_pct: 75 });
    }

    // ===== STEP 5: THUMBNAIL =====
    if (run.current_step === "metadata" || run.current_step === "stitch") {
      // Generate thumbnail from the first scene's keyframe or AI
      await log("info", "Step 5/7: Generating thumbnail & metadata...");

      // Thumbnail: use the first keyframe as thumbnail
      try {
        const { data: keyframeAssets } = await supabase
          .from("assets")
          .select("supabase_path")
          .eq("run_id", runId)
          .eq("type", "keyframe")
          .limit(1);

        if (keyframeAssets && keyframeAssets.length > 0) {
          const { data: srcUrl } = supabase.storage
            .from("project-assets")
            .getPublicUrl(keyframeAssets[0].supabase_path);
          const imgResp = await fetch(srcUrl.publicUrl);
          const imgBytes = new Uint8Array(await imgResp.arrayBuffer());

          const thumbPath = `${project.id}/thumbnails/${runId}/thumbnail.jpg`;
          const { error: thumbErr } = await supabase.storage
            .from("project-assets")
            .upload(thumbPath, imgBytes, { contentType: "image/jpeg", upsert: true });

          if (!thumbErr) {
            await supabase.from("assets").insert({
              supabase_path: thumbPath,
              type: "thumbnail" as any,
              run_id: runId,
              metadata: { source: "keyframe" },
            });
            await log("info", "Thumbnail created from keyframe.");
          }
        }
      } catch (err) {
        await log("warn", `Thumbnail generation failed: ${err.message}`);
      }

      // Metadata: AI-generated title, description, hashtags
      try {
        const { data: scenes } = await supabase
          .from("scenes")
          .select("scene_title, scene_description")
          .eq("run_id", runId)
          .order("scene_index");

        const scenesSummary =
          scenes?.map((s: any) => `${s.scene_title}: ${s.scene_description}`).join("\n") || "";

        const aiResp = await withRetry(() =>
          fetch(AI_GATEWAY, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${LOVABLE_API_KEY}`,
            },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash",
              messages: [
                {
                  role: "system",
                  content:
                    "You are a social media content expert. Generate engaging metadata for a short-form video post.",
                },
                {
                  role: "user",
                  content: `Generate a title, description, and hashtags for this video:\n\nSeries: ${
                    project.series_prompt || project.title
                  }\nScenes:\n${scenesSummary}`,
                },
              ],
              tools: [
                {
                  type: "function",
                  function: {
                    name: "generate_metadata",
                    description: "Generate video post metadata",
                    parameters: {
                      type: "object",
                      properties: {
                        title: { type: "string", description: "Catchy video title (max 100 chars)" },
                        description: {
                          type: "string",
                          description: "Engaging video description (max 500 chars)",
                        },
                        hashtags: {
                          type: "array",
                          items: { type: "string" },
                          description: "Relevant hashtags without # prefix",
                        },
                      },
                      required: ["title", "description", "hashtags"],
                      additionalProperties: false,
                    },
                  },
                },
              ],
              tool_choice: { type: "function", function: { name: "generate_metadata" } },
            }),
          })
        );

        const metaResult = await aiResp.json();
        const metaToolCall = metaResult.choices?.[0]?.message?.tool_calls?.[0];
        if (metaToolCall) {
          const metadata = JSON.parse(metaToolCall.function.arguments);
          await updateRun({ generated_metadata: metadata });
          await log("info", "Metadata generated", metadata);
        }
      } catch (err) {
        await log("warn", `Metadata generation failed: ${err.message}`);
      }

      await updateRun({ current_step: "publish", progress_pct: 90 });
    }

    // ===== STEP 6: PUBLISH =====
    await log("info", "Step 6/7: Publishing...");
    if (!project.uploadpost_api_key_encrypted || !project.uploadpost_api_key_configured) {
      await log("warn", "Upload-Post API key not configured — skipping publish.");
    } else {
      try {
        // Get final video or first clip
        const { data: finalAssets } = await supabase
          .from("assets")
          .select("supabase_path")
          .eq("run_id", runId)
          .eq("type", "final_video")
          .limit(1);

        let videoPath: string | null = null;
        if (finalAssets && finalAssets.length > 0) {
          videoPath = finalAssets[0].supabase_path;
        } else {
          const { data: clips } = await supabase
            .from("assets")
            .select("supabase_path, metadata")
            .eq("run_id", runId)
            .eq("type", "clip")
            .order("created_at");
          const clip = clips?.find((a: any) => (a.metadata as any)?.status === "completed");
          videoPath = clip?.supabase_path || null;
        }

        if (!videoPath) {
          await log("warn", "No video found — skipping publish.");
        } else {
          const { data: urlData } = supabase.storage.from("project-assets").getPublicUrl(videoPath);
          const videoUrl = urlData.publicUrl;

          // Get freshly generated metadata
          const { data: freshRun } = await supabase
            .from("runs")
            .select("generated_metadata")
            .eq("id", runId)
            .single();
          const metadata = (freshRun?.generated_metadata as any) || {};
          const title = metadata.title || project.title || "Untitled Video";
          const description = metadata.description || "";
          const hashtags = metadata.hashtags || [];
          const hashtagStr = hashtags.map((h: string) => `#${h}`).join(" ");
          const fullDescription = description + (hashtagStr ? `\n\n${hashtagStr}` : "");

          // Platform settings
          const platforms = project.publish_platforms as Record<string, boolean>;
          const enabledPlatforms = Object.entries(platforms)
            .filter(([_, enabled]) => enabled)
            .map(([platform]) => platform);
          const publishDefaults = (project.publish_defaults as Record<string, any>) || {};

          if (enabledPlatforms.length === 0) {
            await log("warn", "No platforms enabled — skipping publish.");
          } else {
            const { data: publishJob } = await supabase
              .from("publish_jobs")
              .insert({ run_id: runId, status: "submitted" as const })
              .select()
              .single();

            const apiKey = project.uploadpost_api_key_encrypted!;
            const formData = new FormData();
            formData.append("video", videoUrl);
            formData.append("title", title);
            formData.append("description", fullDescription);
            formData.append("async_upload", "true");

            if (project.uploadpost_profile_username) {
              formData.append("user", project.uploadpost_profile_username);
            }

            for (const platform of enabledPlatforms) {
              formData.append("platform[]", platform);
            }

            // Platform-specific settings
            for (const platform of enabledPlatforms) {
              const defaults = publishDefaults[platform] || {};
              for (const [key, value] of Object.entries(defaults)) {
                if (value !== undefined && value !== null && value !== "") {
                  formData.append(key, String(value));
                }
              }
            }

            await log("info", `Publishing to: ${enabledPlatforms.join(", ")}`, { videoUrl, title });

            const uploadResp = await withRetry(() =>
              fetch("https://api.upload-post.com/api/upload", {
                method: "POST",
                headers: { Authorization: `Apikey ${apiKey}` },
                body: formData,
              })
            );

            const uploadResult = await uploadResp.json();
            await log("info", "Upload-Post response", uploadResult);

            if (uploadResp.ok && uploadResult.request_id) {
              await supabase
                .from("publish_jobs")
                .update({
                  uploadpost_request_id: uploadResult.request_id,
                  uploadpost_job_id: uploadResult.job_id || null,
                  status: "polling" as const,
                })
                .eq("id", publishJob!.id);
              await log("info", `Upload-Post submitted: ${uploadResult.request_id}`);
            } else {
              await supabase
                .from("publish_jobs")
                .update({ status: "failed" as const, platform_results: uploadResult })
                .eq("id", publishJob!.id);
              await log("error", `Upload-Post failed: ${JSON.stringify(uploadResult)}`);
            }
          }
        }
      } catch (err) {
        await log("error", `Publish step failed: ${err.message}`);
      }
    }

    // ===== DONE =====
    await updateRun({
      current_step: "done",
      status: "completed",
      progress_pct: 100,
      finished_at: new Date().toISOString(),
    });
    await log("info", "Pipeline completed successfully! 🎉");

    return json({ status: "completed", run_id: runId });
  } catch (err) {
    await log("error", `Finalize-video failed: ${err.message}`);
    await updateRun({
      status: "failed",
      error_message: `Finalize failed: ${err.message}`,
      finished_at: new Date().toISOString(),
    });
    return json({ error: err.message }, 500);
  }
});
