import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildResolvedPromptConfig, type PromptConfig } from "../_shared/promptConfig.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

// Compute scale factor based on video resolution relative to 540p baseline
function getResolutionScale(pikaResolution: string): number {
  // Overlay values are authored for 540p. Scale proportionally for higher resolutions.
  const heightMap: Record<string, number> = { "540p": 540, "720p": 720, "1080p": 1080 };
  const targetHeight = heightMap[pikaResolution] || 540;
  return targetHeight / 540;
}

// Wrap text to fit within ~70% of a 9:16 frame width
// Estimates chars per line based on font size vs frame width (assumes 540p baseline width = 304px for 9:16)
function wrapOverlayText(text: string, fontSize: number, scale = 1): string {
  const frameWidth = Math.round(304 * scale); // 9:16 at 540p height
  const maxWidth = frameWidth * 0.70;
  // Approximate: each uppercase char in Anton ≈ 0.6 * fontSize width
  const charWidth = fontSize * 0.6;
  const maxChars = Math.max(8, Math.floor(maxWidth / charWidth));
  
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";
  
  for (const word of words) {
    if (currentLine.length === 0) {
      currentLine = word;
    } else if ((currentLine + " " + word).length <= maxChars) {
      currentLine += " " + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  
  return lines.join("\n");
}

// Map overlay position to FFmpeg drawtext x/y
function getFFmpegPosition(position: string, fontSize: number, scale = 1): string {
  const pad = Math.round(20 * scale);
  const topPad = Math.round(160 * scale);
  const map: Record<string, string> = {
    top_left: `x=${pad}:y=${topPad}`,
    top_center: `x=(w-text_w)/2:y=${topPad}`,
    top_right: `x=w-text_w-${pad}:y=${topPad}`,
    center: `x=(w-text_w)/2:y=(h-text_h)/2`,
    bottom_left: `x=${pad}:y=h-text_h-${pad}`,
    bottom_center: `x=(w-text_w)/2:y=h-text_h-${pad}`,
    bottom_right: `x=w-text_w-${pad}:y=h-text_h-${pad}`,
  };
  return map[position] || map.bottom_center;
}

// Map overlay position to FFmpeg overlay filter x:y expressions
function getFFmpegOverlayPosition(position: string, scale = 1): string {
  const pad = Math.round(20 * scale);
  const topPad = Math.round(160 * scale);
  const map: Record<string, string> = {
    top_left: `x=${pad}:y=${topPad}`,
    top_center: `x=(main_w-overlay_w)/2:y=${topPad}`,
    top_right: `x=main_w-overlay_w-${pad}:y=${topPad}`,
    center: `x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2`,
    bottom_left: `x=${pad}:y=main_h-overlay_h-${pad}`,
    bottom_center: `x=(main_w-overlay_w)/2:y=main_h-overlay_h-${pad}`,
    bottom_right: `x=main_w-overlay_w-${pad}:y=main_h-overlay_h-${pad}`,
  };
  return map[position] || map.bottom_center;
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ===== PRODUCTION MP4 CONCATENATION =====
// Handles: stts, stsz, stsc, stco/co64, stss, ctts, sdtp
// Updates: mvhd, tkhd, mdhd durations
// Validates: track count, codec consistency

function readU32(d: Uint8Array, o: number): number {
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
}

function readU16(d: Uint8Array, o: number): number {
  return ((d[o] << 8) | d[o + 1]) >>> 0;
}

function writeU32(d: Uint8Array, o: number, v: number) {
  d[o] = (v >>> 24) & 0xff;
  d[o + 1] = (v >>> 16) & 0xff;
  d[o + 2] = (v >>> 8) & 0xff;
  d[o + 3] = v & 0xff;
}

function writeU16(d: Uint8Array, o: number, v: number) {
  d[o] = (v >>> 8) & 0xff;
  d[o + 1] = v & 0xff;
}

function readU64(d: Uint8Array, o: number): number {
  // JS can't handle full 64-bit, but for reasonable file sizes this is fine
  const hi = readU32(d, o);
  const lo = readU32(d, o + 4);
  return hi * 0x100000000 + lo;
}

function writeU64(d: Uint8Array, o: number, v: number) {
  writeU32(d, o, Math.floor(v / 0x100000000));
  writeU32(d, o + 4, v >>> 0);
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
  hdr: number; // header size (8 or 16 for extended)
}

function scanBoxes(data: Uint8Array, from: number, to: number): Box[] {
  const result: Box[] = [];
  let pos = from;
  while (pos + 8 <= to) {
    let size = readU32(data, pos);
    const type = boxType(data, pos + 4);
    let hdr = 8;
    if (size === 1 && pos + 16 <= to) {
      // 64-bit extended size
      size = readU64(data, pos + 8);
      hdr = 16;
    }
    if (size === 0) size = to - pos; // box extends to end
    if (size < 8 || pos + size > to) break;
    result.push({ type, start: pos, size, hdr });
    pos += size;
  }
  return result;
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "dinf", "edts", "udta"]);

// ---- Track type detection ----
function getHandlerType(data: Uint8Array, trak: Box): string | null {
  const trakChildren = scanBoxes(data, trak.start + trak.hdr, trak.start + trak.size);
  const mdia = trakChildren.find((b) => b.type === "mdia");
  if (!mdia) return null;
  const mdiaChildren = scanBoxes(data, mdia.start + mdia.hdr, mdia.start + mdia.size);
  const hdlr = mdiaChildren.find((b) => b.type === "hdlr");
  if (!hdlr) return null;
  // handler_type is at offset 8 after fullbox header (version+flags=4, pre_defined=4)
  return boxType(data, hdlr.start + hdlr.hdr + 8);
}

function isVideoTrack(data: Uint8Array, trak: Box): boolean {
  return getHandlerType(data, trak) === "vide";
}

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

// ---- Fullbox version/flags reader ----
function fullboxVersion(data: Uint8Array, box: Box): number {
  return data[box.start + box.hdr]; // version byte after box header
}

// ---- Sample table parsers ----

function parseStts(data: Uint8Array, box: Box): number[][] {
  const base = box.start + box.hdr;
  const count = readU32(data, base + 4);
  const entries: number[][] = [];
  for (let i = 0; i < count; i++) {
    entries.push([readU32(data, base + 8 + i * 8), readU32(data, base + 8 + i * 8 + 4)]);
  }
  return entries;
}

function parseCtts(data: Uint8Array, box: Box): { version: number; entries: number[][] } {
  const base = box.start + box.hdr;
  const version = data[base]; // version 0: unsigned offsets, version 1: signed
  const count = readU32(data, base + 4);
  const entries: number[][] = [];
  for (let i = 0; i < count; i++) {
    entries.push([readU32(data, base + 8 + i * 8), readU32(data, base + 8 + i * 8 + 4)]);
  }
  return { version, entries };
}

function parseStsz(data: Uint8Array, box: Box): { sampleSize: number; count: number; sizes: number[] } {
  const base = box.start + box.hdr;
  const sampleSize = readU32(data, base + 4);
  const count = readU32(data, base + 8);
  const sizes: number[] = [];
  if (sampleSize === 0) {
    for (let i = 0; i < count; i++) sizes.push(readU32(data, base + 12 + i * 4));
  }
  return { sampleSize, count, sizes };
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

function parseCo64(data: Uint8Array, box: Box): number[] {
  const base = box.start + box.hdr;
  const count = readU32(data, base + 4);
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(readU64(data, base + 8 + i * 8));
  return offsets;
}

function parseStss(data: Uint8Array, box: Box): number[] {
  const base = box.start + box.hdr;
  const count = readU32(data, base + 4);
  const samples: number[] = [];
  for (let i = 0; i < count; i++) samples.push(readU32(data, base + 8 + i * 4));
  return samples;
}

function parseSdtp(data: Uint8Array, box: Box, sampleCount: number): Uint8Array {
  const base = box.start + box.hdr + 4; // version + flags
  return data.slice(base, base + sampleCount);
}

// ---- Get duration from mdhd ----
function parseMdhd(data: Uint8Array, box: Box): { version: number; timescale: number; duration: number } {
  const base = box.start + box.hdr;
  const version = data[base];
  if (version === 0) {
    return { version, timescale: readU32(data, base + 12), duration: readU32(data, base + 16) };
  } else {
    return { version, timescale: readU32(data, base + 20), duration: readU64(data, base + 24) };
  }
}

function parseTkhd(data: Uint8Array, box: Box): { version: number; duration: number } {
  const base = box.start + box.hdr;
  const version = data[base];
  if (version === 0) {
    return { version, duration: readU32(data, base + 20) };
  } else {
    return { version, duration: readU64(data, base + 28) };
  }
}

function parseMvhd(data: Uint8Array, box: Box): { version: number; timescale: number; duration: number } {
  const base = box.start + box.hdr;
  const version = data[base];
  if (version === 0) {
    return { version, timescale: readU32(data, base + 12), duration: readU32(data, base + 16) };
  } else {
    return { version, timescale: readU32(data, base + 20), duration: readU64(data, base + 24) };
  }
}

// ---- Sample table builders ----

function buildFullBox(type: string, version: number, flags: number, payload: Uint8Array): Uint8Array {
  const size = 8 + 4 + payload.length;
  const buf = new Uint8Array(size);
  writeU32(buf, 0, size);
  buf.set(makeBoxType(type), 4);
  buf[8] = version;
  buf[9] = (flags >> 16) & 0xff;
  buf[10] = (flags >> 8) & 0xff;
  buf[11] = flags & 0xff;
  buf.set(payload, 12);
  return buf;
}

function buildStts(entries: number[][]): Uint8Array {
  const payload = new Uint8Array(4 + entries.length * 8);
  writeU32(payload, 0, entries.length);
  for (let i = 0; i < entries.length; i++) {
    writeU32(payload, 4 + i * 8, entries[i][0]);
    writeU32(payload, 4 + i * 8 + 4, entries[i][1]);
  }
  return buildFullBox("stts", 0, 0, payload);
}

function buildCtts(version: number, entries: number[][]): Uint8Array {
  const payload = new Uint8Array(4 + entries.length * 8);
  writeU32(payload, 0, entries.length);
  for (let i = 0; i < entries.length; i++) {
    writeU32(payload, 4 + i * 8, entries[i][0]);
    writeU32(payload, 4 + i * 8 + 4, entries[i][1]);
  }
  return buildFullBox("ctts", version, 0, payload);
}

function buildStsz(sampleSize: number, sizes: number[]): Uint8Array {
  const hasIndividual = sampleSize === 0;
  const payload = new Uint8Array(8 + (hasIndividual ? sizes.length * 4 : 0));
  writeU32(payload, 0, sampleSize);
  writeU32(payload, 4, hasIndividual ? sizes.length : sizes.length || 0);
  if (hasIndividual) {
    for (let i = 0; i < sizes.length; i++) writeU32(payload, 8 + i * 4, sizes[i]);
  }
  return buildFullBox("stsz", 0, 0, payload);
}

function buildStsc(entries: number[][]): Uint8Array {
  const payload = new Uint8Array(4 + entries.length * 12);
  writeU32(payload, 0, entries.length);
  for (let i = 0; i < entries.length; i++) {
    const o = 4 + i * 12;
    writeU32(payload, o, entries[i][0]);
    writeU32(payload, o + 4, entries[i][1]);
    writeU32(payload, o + 8, entries[i][2]);
  }
  return buildFullBox("stsc", 0, 0, payload);
}

function buildCo64(offsets: number[]): Uint8Array {
  // Always use co64 to handle large files safely
  const payload = new Uint8Array(4 + offsets.length * 8);
  writeU32(payload, 0, offsets.length);
  for (let i = 0; i < offsets.length; i++) writeU64(payload, 4 + i * 8, offsets[i]);
  return buildFullBox("co64", 0, 0, payload);
}

function buildStss(samples: number[]): Uint8Array {
  const payload = new Uint8Array(4 + samples.length * 4);
  writeU32(payload, 0, samples.length);
  for (let i = 0; i < samples.length; i++) writeU32(payload, 4 + i * 4, samples[i]);
  return buildFullBox("stss", 0, 0, payload);
}

function buildSdtp(entries: Uint8Array): Uint8Array {
  return buildFullBox("sdtp", 0, 0, entries);
}

// ---- Duration helpers ----

function totalDurationFromStts(entries: number[][]): number {
  return entries.reduce((sum, [count, delta]) => sum + count * delta, 0);
}

function getSampleCount(data: Uint8Array, stbl: Box): number {
  const children = scanBoxes(data, stbl.start + stbl.hdr, stbl.start + stbl.size);
  const stszBox = children.find((b) => b.type === "stsz");
  if (!stszBox) return 0;
  return readU32(data, stszBox.start + stszBox.hdr + 8);
}

function getChunkCount(data: Uint8Array, stbl: Box): number {
  const children = scanBoxes(data, stbl.start + stbl.hdr, stbl.start + stbl.size);
  const stcoBox = children.find((b) => b.type === "stco");
  if (stcoBox) return readU32(data, stcoBox.start + stcoBox.hdr + 4);
  const co64Box = children.find((b) => b.type === "co64");
  if (co64Box) return readU32(data, co64Box.start + co64Box.hdr + 4);
  return 0;
}

function getChunkOffsets(data: Uint8Array, stbl: Box): number[] {
  const children = scanBoxes(data, stbl.start + stbl.hdr, stbl.start + stbl.size);
  const stcoBox = children.find((b) => b.type === "stco");
  if (stcoBox) return parseStco(data, stcoBox);
  const co64Box = children.find((b) => b.type === "co64");
  if (co64Box) return parseCo64(data, co64Box);
  return [];
}

// ---- Rebuild container with child replacements ----

function rebuildContainer(
  data: Uint8Array,
  container: Box,
  replacements: Map<string, Uint8Array>,
  removeTypes?: Set<string>
): Uint8Array {
  const children = scanBoxes(data, container.start + container.hdr, container.start + container.size);
  const parts: Uint8Array[] = [];

  for (const child of children) {
    if (removeTypes?.has(child.type)) continue;
    if (replacements.has(child.type)) {
      parts.push(replacements.get(child.type)!);
    } else if (CONTAINERS.has(child.type)) {
      parts.push(rebuildContainer(data, child, replacements, removeTypes));
    } else {
      parts.push(data.slice(child.start, child.start + child.size));
    }
  }

  // Add any new boxes that weren't replacements of existing ones
  // (e.g., adding ctts or sdtp that didn't exist in the first file)
  for (const [type, boxData] of replacements) {
    const exists = children.some((c) => c.type === type);
    if (!exists && !CONTAINERS.has(type)) {
      // Check if this is a stbl-level box we want to add
      const stblTypes = new Set(["stts", "stsc", "stsz", "stco", "co64", "stss", "ctts", "sdtp"]);
      if (stblTypes.has(type) && container.type === "stbl") {
        parts.push(boxData);
      }
    }
  }

  const contentSize = parts.reduce((s, p) => s + p.length, 0);
  const totalSize = 8 + contentSize;
  const result = new Uint8Array(totalSize);
  writeU32(result, 0, totalSize);
  result.set(makeBoxType(container.type), 4);
  let offset = 8;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// ---- Update duration in mdhd ----
function updateMdhd(data: Uint8Array, box: Box, newDuration: number): Uint8Array {
  const out = data.slice(box.start, box.start + box.size);
  const base = box.hdr;
  const version = out[base];
  if (version === 0) {
    writeU32(out, base + 16, newDuration);
  } else {
    writeU64(out, base + 24, newDuration);
  }
  return out;
}

// ---- Update duration in tkhd ----
function updateTkhd(data: Uint8Array, box: Box, newDuration: number): Uint8Array {
  const out = data.slice(box.start, box.start + box.size);
  const base = box.hdr;
  const version = out[base];
  if (version === 0) {
    writeU32(out, base + 20, newDuration);
  } else {
    writeU64(out, base + 28, newDuration);
  }
  return out;
}

// ---- Update duration in mvhd ----
function updateMvhd(data: Uint8Array, box: Box, newDuration: number): Uint8Array {
  const out = data.slice(box.start, box.start + box.size);
  const base = box.hdr;
  const version = out[base];
  if (version === 0) {
    writeU32(out, base + 16, newDuration);
  } else {
    writeU64(out, base + 24, newDuration);
  }
  return out;
}

// ---- Get codec info from stsd for validation ----
function getCodecFourCC(data: Uint8Array, stbl: Box): string | null {
  const children = scanBoxes(data, stbl.start + stbl.hdr, stbl.start + stbl.size);
  const stsd = children.find((b) => b.type === "stsd");
  if (!stsd) return null;
  const base = stsd.start + stsd.hdr + 8; // skip version/flags + entry count
  if (base + 4 > stsd.start + stsd.size) return null;
  // Read first sample entry size then fourcc
  return boxType(data, base + 4);
}

// ===== MAIN CONCATENATION =====

interface ParsedFile {
  data: Uint8Array;
  boxes: Box[];
  moov: Box;
  mdat: Box | null;
  trakBoxes: Box[];
}

function parseFile(data: Uint8Array): ParsedFile {
  const boxes = scanBoxes(data, 0, data.length);
  const moov = boxes.find((b) => b.type === "moov");
  if (!moov) throw new Error("No moov box found");
  const mdat = boxes.find((b) => b.type === "mdat") || null;
  const moovChildren = scanBoxes(data, moov.start + moov.hdr, moov.start + moov.size);
  const trakBoxes = moovChildren.filter((b) => b.type === "trak");
  return { data, boxes, moov, mdat, trakBoxes };
}

function getStbl(data: Uint8Array, trak: Box): Box | null {
  const trakChildren = scanBoxes(data, trak.start + trak.hdr, trak.start + trak.size);
  return findBox(data, trakChildren, "mdia", "minf", "stbl");
}

function hasAudioTrack(mp4Data: Uint8Array): boolean {
  try {
    const parsed = parseFile(mp4Data);
    return parsed.trakBoxes.some((trak) => getHandlerType(parsed.data, trak) === "soun");
  } catch {
    return false;
  }
}

function getMdia(data: Uint8Array, trak: Box): Box | null {
  const trakChildren = scanBoxes(data, trak.start + trak.hdr, trak.start + trak.size);
  return trakChildren.find((b) => b.type === "mdia") || null;
}

function concatenateMP4(files: Uint8Array[], opts?: { videoOnly?: boolean }): Uint8Array {
  if (files.length === 0) throw new Error("No files to concatenate");
  const videoOnly = opts?.videoOnly ?? false;

  // For single file with videoOnly, strip non-video tracks
  if (files.length === 1 && !videoOnly) return files[0];

  const parsed = files.map((f, idx) => {
    try {
      return parseFile(f);
    } catch (e) {
      throw new Error(`Failed to parse file ${idx}: ${e.message}`);
    }
  });
  const first = parsed[0];

  // Track the original trak boxes from file 0 before filtering (needed for moov rebuild)
  const originalFirstTraks = [...first.trakBoxes];

  // Filter to video-only tracks if requested
  if (videoOnly) {
    for (const p of parsed) {
      p.trakBoxes = p.trakBoxes.filter((trak) => isVideoTrack(p.data, trak));
    }
  }

  // Validate: all files must have at least one track
  for (let f = 0; f < parsed.length; f++) {
    if (!parsed[f].trakBoxes || parsed[f].trakBoxes.length === 0) {
      throw new Error(`File ${f} has no ${videoOnly ? "video " : ""}tracks`);
    }
  }

  // Validate: all files must have the same number of tracks
  const trackCount = first.trakBoxes.length;
  for (let f = 1; f < parsed.length; f++) {
    if (parsed[f].trakBoxes.length !== trackCount) {
      throw new Error(`Track count mismatch: file 0 has ${trackCount}, file ${f} has ${parsed[f].trakBoxes.length}`);
    }
  }

  // Validate codecs match across files
  for (let t = 0; t < trackCount; t++) {
    const firstStbl = getStbl(first.data, first.trakBoxes[t]);
    if (!firstStbl) continue;
    const firstCodec = getCodecFourCC(first.data, firstStbl);
    for (let f = 1; f < parsed.length; f++) {
      const stbl = getStbl(parsed[f].data, parsed[f].trakBoxes[t]);
      if (!stbl) continue;
      const codec = getCodecFourCC(parsed[f].data, stbl);
      if (firstCodec && codec && firstCodec !== codec) {
        throw new Error(`Codec mismatch in track ${t}: ${firstCodec} vs ${codec}`);
      }
    }
  }

  // Extract ftyp from first file
  const ftypBox = first.boxes.find((b) => b.type === "ftyp");
  const ftypData = ftypBox ? first.data.slice(ftypBox.start, ftypBox.start + ftypBox.size) : new Uint8Array(0);

  // Combine mdat content from all files
  const mdatContents: Uint8Array[] = [];
  const mdatOffsets: number[] = []; // cumulative offset of each file's mdat content
  let mdatPos = 0;
  for (const p of parsed) {
    mdatOffsets.push(mdatPos);
    if (p.mdat) {
      const content = p.data.slice(p.mdat.start + p.mdat.hdr, p.mdat.start + p.mdat.size);
      mdatContents.push(content);
      mdatPos += content.length;
    }
  }

  // For each track, merge sample tables across all files
  const perTrackReplacements: Map<string, Uint8Array>[] = [];
  const perTrackDurations: number[] = []; // in track timescale units
  const perTrackTimescales: number[] = [];

  for (let t = 0; t < trackCount; t++) {
    let mergedStts: number[][] = [];
    let mergedCtts: number[][] = [];
    let hasCtts = false;
    let cttsVersion = 0;
    let mergedSampleSize = -1; // -1 = unset
    let mergedSizes: number[] = [];
    let mergedStsc: number[][] = [];
    let mergedStco: number[] = []; // relative to combined mdat start
    let mergedStss: number[] = [];
    let hasStss = false;
    let mergedSdtp = new Uint8Array(0);
    let hasSdtp = false;

    let cumulativeSamples = 0;
    let cumulativeChunks = 0;
    let timescale = 0;

    for (let f = 0; f < parsed.length; f++) {
      const p = parsed[f];
      if (t >= p.trakBoxes.length) continue;
      const stbl = getStbl(p.data, p.trakBoxes[t]);
      if (!stbl) continue;
      const children = scanBoxes(p.data, stbl.start + stbl.hdr, stbl.start + stbl.size);

      // Get timescale from mdhd
      if (f === 0) {
        const mdia = getMdia(p.data, p.trakBoxes[t]);
        if (mdia) {
          const mdiaChildren = scanBoxes(p.data, mdia.start + mdia.hdr, mdia.start + mdia.size);
          const mdhdBox = mdiaChildren.find((b) => b.type === "mdhd");
          if (mdhdBox) {
            const mdhd = parseMdhd(p.data, mdhdBox);
            timescale = mdhd.timescale;
          }
        }
      }

      const fileSampleCount = getSampleCount(p.data, stbl);
      const fileChunkCount = getChunkCount(p.data, stbl);

      // stts
      const sttsBox = children.find((b) => b.type === "stts");
      if (sttsBox) mergedStts.push(...parseStts(p.data, sttsBox));

      // ctts
      const cttsBox = children.find((b) => b.type === "ctts");
      if (cttsBox) {
        hasCtts = true;
        const parsed = parseCtts(p.data, cttsBox);
        cttsVersion = Math.max(cttsVersion, parsed.version);
        mergedCtts.push(...parsed.entries);
      } else if (hasCtts && fileSampleCount > 0) {
        // If previous files had ctts but this one doesn't, add zero offsets
        mergedCtts.push([fileSampleCount, 0]);
      }

      // stsz
      const stszBox = children.find((b) => b.type === "stsz");
      if (stszBox) {
        const parsed = parseStsz(p.data, stszBox);
        if (mergedSampleSize === -1) {
          // First file
          mergedSampleSize = parsed.sampleSize;
          mergedSizes = [...parsed.sizes];
        } else if (parsed.sampleSize !== mergedSampleSize || mergedSampleSize === 0) {
          // Different sizes or already variable — need per-sample
          if (mergedSampleSize !== 0 && mergedSizes.length === 0) {
            // Expand previous constant size to individual entries
            mergedSizes = new Array(cumulativeSamples).fill(mergedSampleSize);
          }
          mergedSampleSize = 0;
          if (parsed.sampleSize !== 0 && parsed.sizes.length === 0) {
            mergedSizes.push(...new Array(parsed.count).fill(parsed.sampleSize));
          } else {
            mergedSizes.push(...parsed.sizes);
          }
        } else {
          // Same constant sample size, just extend count
          mergedSizes.push(...parsed.sizes);
        }
      }

      // stsc — adjust firstChunk by cumulative chunk count
      const stscBox = children.find((b) => b.type === "stsc");
      if (stscBox) {
        const entries = parseStsc(p.data, stscBox);
        for (const e of entries) {
          mergedStsc.push([e[0] + cumulativeChunks, e[1], e[2]]);
        }
      }

      // stco/co64 — convert to relative-to-mdat offsets
      const origMdatStart = p.mdat ? p.mdat.start + p.mdat.hdr : 0;
      const chunkOffsets = getChunkOffsets(p.data, stbl);
      for (const off of chunkOffsets) {
        mergedStco.push((off - origMdatStart) + mdatOffsets[f]);
      }

      // stss
      const stssBox = children.find((b) => b.type === "stss");
      if (stssBox) {
        hasStss = true;
        const samples = parseStss(p.data, stssBox);
        for (const s of samples) mergedStss.push(s + cumulativeSamples);
      }

      // sdtp
      const sdtpBox = children.find((b) => b.type === "sdtp");
      if (sdtpBox) {
        hasSdtp = true;
        const entries = parseSdtp(p.data, sdtpBox, fileSampleCount);
        const combined = new Uint8Array(mergedSdtp.length + entries.length);
        combined.set(mergedSdtp);
        combined.set(entries, mergedSdtp.length);
        mergedSdtp = combined;
      }

      cumulativeSamples += fileSampleCount;
      cumulativeChunks += fileChunkCount;
    }

    // Compact stts: merge adjacent entries with same delta
    const compactedStts: number[][] = [];
    for (const [count, delta] of mergedStts) {
      if (compactedStts.length > 0 && compactedStts[compactedStts.length - 1][1] === delta) {
        compactedStts[compactedStts.length - 1][0] += count;
      } else {
        compactedStts.push([count, delta]);
      }
    }

    // Build replacement boxes
    const replacements = new Map<string, Uint8Array>();
    replacements.set("stts", buildStts(compactedStts));
    if (hasCtts) replacements.set("ctts", buildCtts(cttsVersion, mergedCtts));
    // For constant sample size, pass count via a properly-sized placeholder array
    if (mergedSampleSize > 0) {
      replacements.set("stsz", buildStsz(mergedSampleSize, new Array(cumulativeSamples).fill(mergedSampleSize)));
    } else {
      replacements.set("stsz", buildStsz(0, mergedSizes));
    }
    replacements.set("stsc", buildStsc(mergedStsc));
    replacements.set("co64", buildCo64(mergedStco)); // always use co64 for safety
    if (hasStss) replacements.set("stss", buildStss(mergedStss));
    if (hasSdtp) replacements.set("sdtp", buildSdtp(mergedSdtp));

    perTrackReplacements.push(replacements);
    perTrackDurations.push(totalDurationFromStts(compactedStts));
    perTrackTimescales.push(timescale);
  }

  // Build new traks with merged stbl + updated durations
  const rebuiltTraks: Uint8Array[] = [];
  for (let t = 0; t < trackCount; t++) {
    const trak = first.trakBoxes[t];
    const trakChildren = scanBoxes(first.data, trak.start + trak.hdr, trak.start + trak.size);
    const replacements = new Map(perTrackReplacements[t]);

    // Update mdhd duration
    const mdia = trakChildren.find((b) => b.type === "mdia");
    if (mdia) {
      const mdiaChildren = scanBoxes(first.data, mdia.start + mdia.hdr, mdia.start + mdia.size);
      const mdhdBox = mdiaChildren.find((b) => b.type === "mdhd");
      if (mdhdBox) {
        replacements.set("mdhd", updateMdhd(first.data, mdhdBox, perTrackDurations[t]));
      }
    }

    // Update tkhd duration (convert to movie timescale)
    const tkhdBox = trakChildren.find((b) => b.type === "tkhd");
    if (tkhdBox) {
      const moovChildren = scanBoxes(first.data, first.moov.start + first.moov.hdr, first.moov.start + first.moov.size);
      const mvhdBox = moovChildren.find((b) => b.type === "mvhd");
      if (mvhdBox) {
        const mvhd = parseMvhd(first.data, mvhdBox);
        const trackDurInMovieTimescale = perTrackTimescales[t] > 0
          ? Math.round(perTrackDurations[t] * mvhd.timescale / perTrackTimescales[t])
          : perTrackDurations[t];
        replacements.set("tkhd", updateTkhd(first.data, tkhdBox, trackDurInMovieTimescale));
      }
    }

    // Remove stco (replaced by co64) and edts (contains elst with original
    // clip duration that would truncate playback to just the first clip)
    const removeTypes = new Set(["stco", "edts"]);
    const rebuilt = rebuildContainer(first.data, trak, replacements, removeTypes);
    rebuiltTraks.push(rebuilt);
  }

  // Rebuild moov with new traks and updated mvhd duration
  const moovChildren = scanBoxes(first.data, first.moov.start + first.moov.hdr, first.moov.start + first.moov.size);
  const moovParts: Uint8Array[] = [];
  let trakIndex = 0;

  // Build a set of original trak start positions that were kept (not filtered out)
  const keptTrakStarts = new Set(first.trakBoxes.map(t => t.start));

  // Calculate max duration across tracks for mvhd
  const mvhdBox = moovChildren.find((b) => b.type === "mvhd");
  let mvhdTimescale = 1000;
  if (mvhdBox) {
    mvhdTimescale = parseMvhd(first.data, mvhdBox).timescale;
  }
  let maxMovieDuration = 0;
  for (let t = 0; t < trackCount; t++) {
    const dur = perTrackTimescales[t] > 0
      ? Math.round(perTrackDurations[t] * mvhdTimescale / perTrackTimescales[t])
      : perTrackDurations[t];
    maxMovieDuration = Math.max(maxMovieDuration, dur);
  }

  for (const child of moovChildren) {
    if (child.type === "trak") {
      if (keptTrakStarts.has(child.start)) {
        // This trak was kept (not filtered) — use the rebuilt version
        if (trakIndex < rebuiltTraks.length) {
          moovParts.push(rebuiltTraks[trakIndex++]);
        }
      }
      // else: this trak was filtered out (e.g. audio in videoOnly mode) — skip it
    } else if (child.type === "mvhd" && mvhdBox) {
      moovParts.push(updateMvhd(first.data, mvhdBox, maxMovieDuration));
    } else {
      moovParts.push(first.data.slice(child.start, child.start + child.size));
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

  // Layout: ftyp + moov + mdat
  const mdatContentSize = mdatContents.reduce((s, c) => s + c.length, 0);
  const mdatTotalSize = 8 + mdatContentSize;
  const mdatStartInFile = ftypData.length + moovSize;

  // Adjust co64 offsets: add mdatStartInFile + 8 (mdat header)
  const finalMoovBoxes = scanBoxes(newMoov, 8, newMoov.length);
  for (const trak of finalMoovBoxes.filter((b) => b.type === "trak")) {
    const trakChildren = scanBoxes(newMoov, trak.start + trak.hdr, trak.start + trak.size);
    const co64Box = findBox(newMoov, trakChildren, "mdia", "minf", "stbl", "co64");
    if (co64Box) {
      const base = co64Box.start + co64Box.hdr;
      const count = readU32(newMoov, base + 4);
      for (let i = 0; i < count; i++) {
        const pos = base + 8 + i * 8;
        const currentVal = readU64(newMoov, pos);
        writeU64(newMoov, pos, currentVal + mdatStartInFile + 8);
      }
    }
  }

  // Build mdat header
  const mdatHeader = new Uint8Array(8);
  writeU32(mdatHeader, 0, mdatTotalSize);
  mdatHeader.set(makeBoxType("mdat"), 4);

  // Assemble final file
  const totalSize = ftypData.length + moovSize + mdatTotalSize;
  const output = new Uint8Array(totalSize);
  let pos = 0;
  output.set(ftypData, pos); pos += ftypData.length;
  output.set(newMoov, pos); pos += moovSize;
  output.set(mdatHeader, pos); pos += 8;
  for (const content of mdatContents) {
    output.set(content, pos);
    pos += content.length;
  }

  return output;
}

// ===== MP3 FRAME PARSER & AUDIO MUXER =====

const MP3_BITRATES_V1_L3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
const MP3_SAMPLERATES_V1 = [44100, 48000, 32000];

interface MP3FrameInfo { offset: number; size: number; sampleRate: number; channels: number; bitrate: number; }

function parseMP3Frames(data: Uint8Array): MP3FrameInfo[] {
  const frames: MP3FrameInfo[] = [];
  let pos = 0;
  // Skip ID3v2 tag if present
  if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
    const tagSize = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f);
    pos = 10 + tagSize;
  }
  while (pos + 4 <= data.length) {
    // Sync word: 0xFFE0 (11 bits)
    if (data[pos] !== 0xFF || (data[pos+1] & 0xE0) !== 0xE0) { pos++; continue; }
    const b1 = data[pos+1], b2 = data[pos+2];
    const version = (b1 >> 3) & 3; // 3=MPEG1
    const layer = (b1 >> 1) & 3;   // 1=Layer III
    if (version !== 3 || layer !== 1) { pos++; continue; } // Only MPEG1 Layer III
    const bitrateIdx = (b2 >> 4) & 0xF;
    const srIdx = (b2 >> 2) & 3;
    const padding = (b2 >> 1) & 1;
    if (bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) { pos++; continue; }
    const bitrate = MP3_BITRATES_V1_L3[bitrateIdx] * 1000;
    const sampleRate = MP3_SAMPLERATES_V1[srIdx];
    const channels = ((data[pos+3] >> 6) & 3) === 3 ? 1 : 2;
    const frameSize = Math.floor(144 * bitrate / sampleRate) + padding;
    if (pos + frameSize > data.length) break;
    frames.push({ offset: pos, size: frameSize, sampleRate, channels, bitrate });
    pos += frameSize;
  }
  return frames;
}

function buildEsdsBox(sampleRate: number, channels: number): Uint8Array {
  // ES_Descriptor for MP3 (objectTypeIndication = 0x6B = MPEG-1 Audio)
  const esds = new Uint8Array([
    0x00, 0x00, 0x00, 0x00, // version + flags
    // ES_Descriptor tag=3, length
    0x03, 0x19,
    0x00, 0x01, // ES_ID = 1
    0x00,       // streamDependence=0, URL=0, OCR=0, priority=0
    // DecoderConfigDescriptor tag=4, length
    0x04, 0x11,
    0x6B,       // objectTypeIndication = 0x6B (MPEG-1 Audio)
    0x15,       // streamType=5 (audio), upstream=0, reserved=1 => 0x15
    0x00, 0x00, 0x00, // bufferSizeDB
    0x00, 0x00, 0x00, 0x00, // maxBitrate (will be filled)
    0x00, 0x00, 0x00, 0x00, // avgBitrate (will be filled)
    // DecoderSpecificInfo tag=5, length=0
    0x05, 0x00,
    // SLConfigDescriptor tag=6, length=1
    0x06, 0x01,
    0x02, // predefined=2
  ]);
  const size = esds.length + 8;
  const box = new Uint8Array(size);
  writeU32(box, 0, size);
  box.set(makeBoxType("esds"), 4);
  box.set(esds, 8);
  return box;
}

function buildAudioSampleEntry(sampleRate: number, channels: number): Uint8Array {
  // mp4a sample entry: 6 bytes reserved + 2 data_ref_index + 8 reserved + 2 channels + 2 sampleSize + 4 reserved + 4 sampleRate(fixed16.16) + esds
  const esds = buildEsdsBox(sampleRate, channels);
  const entrySize = 8 + 6 + 2 + 8 + 2 + 2 + 4 + 4 + esds.length;
  const entry = new Uint8Array(entrySize);
  writeU32(entry, 0, entrySize);
  entry.set(makeBoxType("mp4a"), 4);
  // 6 bytes reserved (zeros) at offset 8
  writeU16(entry, 14, 1); // data_reference_index = 1
  // 8 bytes reserved at offset 16
  writeU16(entry, 24, channels);
  writeU16(entry, 26, 16); // sampleSize = 16 bits
  // 4 bytes reserved at offset 28
  writeU32(entry, 32, sampleRate << 16); // fixed-point 16.16
  entry.set(esds, 36);
  return entry;
}

function buildStsdAudio(sampleRate: number, channels: number): Uint8Array {
  const sampleEntry = buildAudioSampleEntry(sampleRate, channels);
  const payloadSize = 4 + sampleEntry.length; // entry_count + entry
  const payload = new Uint8Array(payloadSize);
  writeU32(payload, 0, 1); // entry_count = 1
  payload.set(sampleEntry, 4);
  return buildFullBox("stsd", 0, 0, payload);
}

function buildSmhd(): Uint8Array {
  // Sound media header: version(1) + flags(3) + balance(2) + reserved(2) = 8 bytes payload
  return buildFullBox("smhd", 0, 0, new Uint8Array(4));
}

function buildDinf(): Uint8Array {
  // dinf > dref with one url entry
  const urlBox = buildFullBox("url ", 0, 1, new Uint8Array(0)); // self-contained flag
  const drefPayload = new Uint8Array(4 + urlBox.length);
  writeU32(drefPayload, 0, 1); // entry_count
  drefPayload.set(urlBox, 4);
  const dref = buildFullBox("dref", 0, 0, drefPayload);
  
  const dinfSize = 8 + dref.length;
  const dinf = new Uint8Array(dinfSize);
  writeU32(dinf, 0, dinfSize);
  dinf.set(makeBoxType("dinf"), 4);
  dinf.set(dref, 8);
  return dinf;
}

function buildHdlrAudio(): Uint8Array {
  // hdlr: version+flags(4) + pre_defined(4) + handler_type(4) + reserved(12) + name
  const name = new TextEncoder().encode("SoundHandler\0");
  const payload = new Uint8Array(4 + 4 + 12 + name.length);
  payload.set(makeBoxType("soun"), 4); // handler_type
  payload.set(name, 20);
  return buildFullBox("hdlr", 0, 0, payload);
}

function muxMP3IntoMP4(videoMP4: Uint8Array, mp3Data: Uint8Array, videoDurationSec: number): Uint8Array {
  const frames = parseMP3Frames(mp3Data);
  if (frames.length === 0) throw new Error("No valid MP3 frames found");
  
  const sampleRate = frames[0].sampleRate;
  const channels = frames[0].channels;
  const samplesPerFrame = 1152; // MPEG-1 Layer III
  
  // Trim MP3 to match video duration
  const maxFrames = Math.ceil(videoDurationSec * sampleRate / samplesPerFrame);
  const usedFrames = frames.slice(0, maxFrames);
  
  // Collect audio data
  let audioDataSize = 0;
  const frameSizes: number[] = [];
  for (const f of usedFrames) {
    frameSizes.push(f.size);
    audioDataSize += f.size;
  }
  const audioData = new Uint8Array(audioDataSize);
  let writePos = 0;
  for (const f of usedFrames) {
    audioData.set(mp3Data.slice(f.offset, f.offset + f.size), writePos);
    writePos += f.size;
  }
  
  // Parse existing video MP4
  const parsed = parseFile(videoMP4);
  const moovChildren = scanBoxes(parsed.data, parsed.moov.start + parsed.moov.hdr, parsed.moov.start + parsed.moov.size);
  
  // Get movie timescale from mvhd
  const mvhdBox = moovChildren.find((b) => b.type === "mvhd");
  const mvhdInfo = mvhdBox ? parseMvhd(parsed.data, mvhdBox) : { timescale: 1000, version: 0, duration: 0 };
  const movieTimescale = mvhdInfo.timescale;
  
  // Audio duration in audio timescale
  const audioDuration = usedFrames.length * samplesPerFrame;
  // Audio duration in movie timescale
  const audioDurMovie = Math.round(audioDuration * movieTimescale / sampleRate);
  
  // Build audio stbl
  const stsd = buildStsdAudio(sampleRate, channels);
  const stts = buildStts([[usedFrames.length, samplesPerFrame]]);
  const stsz = buildStsz(0, frameSizes);
  // One chunk containing all samples
  const stsc = buildStsc([[1, usedFrames.length, 1]]);
  // co64 offset will be fixed up later
  const co64 = buildCo64([0]); // placeholder
  
  // Build stbl
  const stblParts = [stsd, stts, stsz, stsc, co64];
  const stblContentSize = stblParts.reduce((s, p) => s + p.length, 0);
  const stbl = new Uint8Array(8 + stblContentSize);
  writeU32(stbl, 0, 8 + stblContentSize);
  stbl.set(makeBoxType("stbl"), 4);
  let sOff = 8;
  for (const p of stblParts) { stbl.set(p, sOff); sOff += p.length; }
  
  // Build minf
  const smhd = buildSmhd();
  const dinf = buildDinf();
  const minfParts = [smhd, dinf, stbl];
  const minfSize = 8 + minfParts.reduce((s, p) => s + p.length, 0);
  const minf = new Uint8Array(minfSize);
  writeU32(minf, 0, minfSize);
  minf.set(makeBoxType("minf"), 4);
  let mOff = 8;
  for (const p of minfParts) { minf.set(p, mOff); mOff += p.length; }
  
  // Build mdhd (audio timescale = sampleRate)
  const mdhdPayload = new Uint8Array(24); // version 0
  // creation_time=0, modification_time=0 (8 bytes)
  writeU32(mdhdPayload, 8, sampleRate); // timescale
  writeU32(mdhdPayload, 12, audioDuration); // duration
  const mdhd = buildFullBox("mdhd", 0, 0, mdhdPayload);
  
  // Build hdlr
  const hdlr = buildHdlrAudio();
  
  // Build mdia
  const mdiaParts = [mdhd, hdlr, minf];
  const mdiaSize = 8 + mdiaParts.reduce((s, p) => s + p.length, 0);
  const mdia = new Uint8Array(mdiaSize);
  writeU32(mdia, 0, mdiaSize);
  mdia.set(makeBoxType("mdia"), 4);
  let dOff = 8;
  for (const p of mdiaParts) { mdia.set(p, dOff); dOff += p.length; }
  
  // Build tkhd (version 0 layout after version+flags):
  // creation_time(4)[0] modification_time(4)[4] track_ID(4)[8] reserved(4)[12]
  // duration(4)[16] reserved(8)[20] layer(2)[28] alt_group(2)[30]
  // volume(2)[32] reserved(2)[34] matrix(36)[36..71] width(4)[72] height(4)[76]
  const tkhdPayload = new Uint8Array(80);
  // flags = 3 (track enabled + in movie)
  writeU32(tkhdPayload, 8, 2); // track_ID = 2 (assuming video is 1)
  writeU32(tkhdPayload, 16, audioDurMovie); // duration
  writeU16(tkhdPayload, 32, 0x0100); // volume = 1.0
  // unity matrix at offset 36
  writeU32(tkhdPayload, 36, 0x00010000);  // matrix[0]
  writeU32(tkhdPayload, 52, 0x00010000);  // matrix[4]
  writeU32(tkhdPayload, 68, 0x40000000);  // matrix[8]
  const tkhd = buildFullBox("tkhd", 0, 3, tkhdPayload);
  
  // Build audio trak
  const trakParts = [tkhd, mdia];
  const trakSize = 8 + trakParts.reduce((s, p) => s + p.length, 0);
  const audioTrak = new Uint8Array(trakSize);
  writeU32(audioTrak, 0, trakSize);
  audioTrak.set(makeBoxType("trak"), 4);
  let tOff = 8;
  for (const p of trakParts) { audioTrak.set(p, tOff); tOff += p.length; }
  
  // Now rebuild: ftyp + moov(existing children + audioTrak) + mdat(existing + audioData)
  const ftypBox = parsed.boxes.find((b) => b.type === "ftyp");
  const ftypData = ftypBox ? parsed.data.slice(ftypBox.start, ftypBox.start + ftypBox.size) : new Uint8Array(0);
  
  // Get existing mdat
  const existingMdat = parsed.mdat;
  const existingMdatContent = existingMdat 
    ? parsed.data.slice(existingMdat.start + existingMdat.hdr, existingMdat.start + existingMdat.size)
    : new Uint8Array(0);
  
  // Rebuild moov: copy all existing children + add audio trak
  const newMoovParts: Uint8Array[] = [];
  for (const child of moovChildren) {
    newMoovParts.push(parsed.data.slice(child.start, child.start + child.size));
  }
  newMoovParts.push(audioTrak);
  
  const newMoovContentSize = newMoovParts.reduce((s, p) => s + p.length, 0);
  const newMoovSize = 8 + newMoovContentSize;
  const newMoov = new Uint8Array(newMoovSize);
  writeU32(newMoov, 0, newMoovSize);
  newMoov.set(makeBoxType("moov"), 4);
  let moovOff = 8;
  for (const part of newMoovParts) { newMoov.set(part, moovOff); moovOff += part.length; }
  
  // New mdat = existing content + audio data
  const newMdatContentSize = existingMdatContent.length + audioData.length;
  const newMdatSize = 8 + newMdatContentSize;
  const mdatStartInFile = ftypData.length + newMoovSize;
  
  // Fix up audio co64: audio data starts at mdatStartInFile + 8 + existingMdatContent.length
  const audioMdatOffset = mdatStartInFile + 8 + existingMdatContent.length;
  
  // Find the audio trak's co64 in newMoov and fix it
  const newMoovBoxes = scanBoxes(newMoov, 8, newMoov.length);
  const traks = newMoovBoxes.filter((b) => b.type === "trak");
  const lastTrak = traks[traks.length - 1]; // our audio trak
  if (lastTrak) {
    const trakCh = scanBoxes(newMoov, lastTrak.start + lastTrak.hdr, lastTrak.start + lastTrak.size);
    const audioCo64 = findBox(newMoov, trakCh, "mdia", "minf", "stbl", "co64");
    if (audioCo64) {
      const base = audioCo64.start + audioCo64.hdr;
      writeU64(newMoov, base + 8, audioMdatOffset);
    }
  }
  
  // Also fix existing video track co64/stco offsets (they reference old positions)
  // The original file might have ANY layout (ftyp+moov+mdat or ftyp+mdat+moov etc.)
  // So we use the actual mdat position from the parsed file, not an assumed layout.
  const oldMdatContentStart = existingMdat ? existingMdat.start + existingMdat.hdr : 0;
  const newMdatContentStart = mdatStartInFile + 8; // after ftyp + newMoov + mdat header
  
  for (let i = 0; i < traks.length - 1; i++) {
    const trak = traks[i];
    const trakCh = scanBoxes(newMoov, trak.start + trak.hdr, trak.start + trak.size);
    const co64Box = findBox(newMoov, trakCh, "mdia", "minf", "stbl", "co64");
    if (co64Box) {
      const base = co64Box.start + co64Box.hdr;
      const count = readU32(newMoov, base + 4);
      for (let j = 0; j < count; j++) {
        const pos = base + 8 + j * 8;
        const current = readU64(newMoov, pos);
        // Rebase: subtract old mdat content start, add new mdat content start
        const relativeOffset = current - oldMdatContentStart;
        writeU64(newMoov, pos, newMdatContentStart + relativeOffset);
      }
    }
    const stcoBox = findBox(newMoov, trakCh, "mdia", "minf", "stbl", "stco");
    if (stcoBox) {
      const base = stcoBox.start + stcoBox.hdr;
      const count = readU32(newMoov, base + 4);
      for (let j = 0; j < count; j++) {
        const pos = base + 8 + j * 4;
        const current = readU32(newMoov, pos);
        const relativeOffset = current - oldMdatContentStart;
        writeU32(newMoov, pos, (newMdatContentStart + relativeOffset) >>> 0);
      }
    }
  }
  
  // Build final file
  const totalSize = ftypData.length + newMoovSize + newMdatSize;
  const output = new Uint8Array(totalSize);
  let outPos = 0;
  output.set(ftypData, outPos); outPos += ftypData.length;
  output.set(newMoov, outPos); outPos += newMoovSize;
  // mdat header
  writeU32(output, outPos, newMdatSize);
  output.set(makeBoxType("mdat"), outPos + 4);
  outPos += 8;
  output.set(existingMdatContent, outPos); outPos += existingMdatContent.length;
  output.set(audioData, outPos);
  
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

// ===== FAL.AI COMPOSE HELPER =====

function tryParseJson(raw: string): any {
  const cleaned = raw.trim().replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const jsonStart = cleaned.search(/[\{\[]/);
  const jsonEnd = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error("No JSON found in response");
  }
  return JSON.parse(cleaned.substring(jsonStart, jsonEnd + 1));
}

function extractFalVideoUrl(payload: any, depth = 0, parentKey = ""): string | null {
  if (!payload || depth > 8) return null;

  const lowerParentKey = parentKey.toLowerCase();
  const keyHintsVideo =
    lowerParentKey.includes("video") ||
    lowerParentKey.includes("output") ||
    lowerParentKey.includes("result") ||
    lowerParentKey.includes("file") ||
    lowerParentKey.includes("media") ||
    lowerParentKey.includes("url");

  if (typeof payload === "string") {
    if (!payload.startsWith("http")) return null;
    const lower = payload.toLowerCase();
    if (
      lower.includes(".mp4") ||
      lower.includes(".mov") ||
      lower.includes(".webm") ||
      lower.includes(".m3u8") ||
      keyHintsVideo
    ) {
      return payload;
    }
    return null;
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = extractFalVideoUrl(item, depth + 1, parentKey);
      if (found) return found;
    }
    return null;
  }

  if (typeof payload === "object") {
    const mime = String(payload.content_type || payload.mime_type || payload.type || "").toLowerCase();
    if (mime.startsWith("video/") && typeof payload.url === "string" && payload.url.startsWith("http")) {
      return payload.url;
    }

    const direct = payload.video_url || payload.videoUrl || payload.url || payload.video?.url;
    if (typeof direct === "string" && direct.startsWith("http")) {
      const lowerDirect = direct.toLowerCase();
      if (
        lowerDirect.includes(".mp4") ||
        lowerDirect.includes(".mov") ||
        lowerDirect.includes(".webm") ||
        lowerDirect.includes(".m3u8") ||
        keyHintsVideo ||
        mime.startsWith("video/")
      ) {
        return direct;
      }
    }

    for (const [k, v] of Object.entries(payload)) {
      const found = extractFalVideoUrl(v, depth + 1, k);
      if (found) return found;
    }
  }

  return null;
}

async function runFalCompose(
  falKey: string,
  tracks: any[],
  log: (level: string, message: string, data?: unknown) => Promise<void>
): Promise<Uint8Array | null> {
  const falResp = await withRetry(() =>
    fetch("https://queue.fal.run/fal-ai/ffmpeg-api/compose", {
      method: "POST",
      headers: {
        Authorization: `Key ${falKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tracks }),
    })
  );

  const falRespText = await falResp.text();
  await log("info", `fal.ai compose response status=${falResp.status}, body preview: ${falRespText.substring(0, 300)}`);
  if (!falResp.ok) {
    throw new Error(`Compose failed (${falResp.status}): ${falRespText.substring(0, 500)}`);
  }

  let falResult: any;
  try {
    falResult = tryParseJson(falRespText);
  } catch (parseErr) {
    throw new Error(`Failed to parse fal.ai response: ${(parseErr as Error).message}`);
  }

  const directUrl = extractFalVideoUrl(falResult);
  if (directUrl) {
    const directResp = await fetch(directUrl);
    if (!directResp.ok) throw new Error(`Failed downloading composed video: ${directResp.status}`);
    return new Uint8Array(await directResp.arrayBuffer());
  }

  if (!falResult.request_id) {
    throw new Error("Compose response missing request_id and video URL.");
  }

  const pollStatusUrl = falResult.status_url || `https://queue.fal.run/fal-ai/ffmpeg-api/requests/${falResult.request_id}/status`;
  const pollResponseUrl = falResult.response_url || `https://queue.fal.run/fal-ai/ffmpeg-api/requests/${falResult.request_id}`;

  for (let poll = 0; poll < 30; poll++) {
    await new Promise((r) => setTimeout(r, 2000));
    const statusResp = await fetch(pollStatusUrl, { headers: { Authorization: `Key ${falKey}` } });
    const statusText = await statusResp.text();
    let statusData: any;
    try {
      statusData = tryParseJson(statusText);
    } catch {
      throw new Error(`Bad compose status response: ${statusText.substring(0, 200)}`);
    }

    if (statusData.status === "FAILED") {
      throw new Error(`Compose failed: ${JSON.stringify(statusData)}`);
    }

    const statusVideoUrl = extractFalVideoUrl(statusData);
    if (statusVideoUrl) {
      const overlaidResp = await fetch(statusVideoUrl);
      if (!overlaidResp.ok) throw new Error(`Failed downloading composed video: ${overlaidResp.status}`);
      return new Uint8Array(await overlaidResp.arrayBuffer());
    }

    if (statusData.status === "COMPLETED") {
      let resultUrl: string | null = extractFalVideoUrl(statusData);

      // Some queue responses mark COMPLETED before response_url payload is hydrated.
      // Retry a few times before failing hard.
      for (let attempt = 0; attempt < 8 && !resultUrl; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1200));
        const resultResp = await fetch(pollResponseUrl, { headers: { Authorization: `Key ${falKey}` } });
        const resultText = await resultResp.text();
        let resultData: any;
        try {
          resultData = tryParseJson(resultText);
        } catch {
          throw new Error(`Bad compose result response: ${resultText.substring(0, 200)}`);
        }
        resultUrl = extractFalVideoUrl(resultData);
        if (!resultUrl && attempt === 0) {
          await log("warn", `Compose completed but response payload had no video URL yet; retrying. Preview: ${resultText.substring(0, 240)}`);
        }
      }

      if (!resultUrl) throw new Error("Compose completed without video URL.");
      const overlaidResp = await fetch(resultUrl);
      if (!overlaidResp.ok) throw new Error(`Failed downloading composed video: ${overlaidResp.status}`);
      return new Uint8Array(await overlaidResp.arrayBuffer());
    }
  }

  throw new Error("FFmpeg compose timed out");
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
    if (run.current_step === "done") return json({ status: "already_completed" });

    // Idempotency: check if final video already exists
    const { data: existingFinal } = await supabase
      .from("assets")
      .select("id")
      .eq("run_id", runId)
      .eq("type", "final_video")
      .limit(1);
    if (existingFinal && existingFinal.length > 0 && run.current_step !== "stitch") {
      // Final video exists and we're past stitch — skip to where we are
      await log("info", "Final video already exists, skipping stitch step.");
    }

    const { data: project } = await supabase.from("projects").select("*").eq("id", run.project_id).single();
    if (!project) {
      await log("error", "Project not found");
      await updateRun({ status: "failed", error_message: "Project not found" });
      return json({ error: "Project not found" }, 404);
    }

    // ===== STEP 4: STITCH =====
    if (run.current_step === "stitch") {
      // Atomic lock: only the first caller proceeds. Use progress_pct as CAS guard.
      const { data: lockRows } = await supabase
        .from("runs")
        .update({ progress_pct: 55 })
        .eq("id", runId)
        .eq("current_step", "stitch")
        .eq("progress_pct", run.progress_pct)
        .select("id");
      if (!lockRows || lockRows.length === 0) {
        await log("info", "Stitch step already claimed by another execution — skipping.");
        return json({ status: "already_processing" });
      }

      await log("info", "Step 4/7: Stitching video clips...");
      try {
        // Fetch scenes in order, then match clips by scene_id to guarantee correct ordering
        const { data: orderedScenes } = await supabase
          .from("scenes")
          .select("id, scene_index")
          .eq("run_id", runId)
          .order("scene_index", { ascending: true });

        const { data: clipAssets } = await supabase
          .from("assets")
          .select("*")
          .eq("run_id", runId)
          .eq("type", "clip");

        // Build a map of scene_id -> clip, then order by scene_index
        const clipBySceneId = new Map<string, any>();
        for (const clip of (clipAssets || [])) {
          if ((clip.metadata as any)?.status === "completed" && clip.scene_id) {
            clipBySceneId.set(clip.scene_id, clip);
          }
        }
        const completedClips = (orderedScenes || [])
          .map((s: any) => clipBySceneId.get(s.id))
          .filter(Boolean);

        if (completedClips.length === 0) {
          await log("warn", "No completed clips — skipping stitch.");
        } else {
          // Download all clips (batch of 3 for memory management)
          const clipBuffers: Uint8Array[] = [];
          for (let i = 0; i < completedClips.length; i += 3) {
            const batch = completedClips.slice(i, i + 3);
            const buffers = await Promise.all(
              batch.map(async (clip: any) => {
                const { data: urlData } = supabase.storage
                  .from("project-assets")
                  .getPublicUrl(clip.supabase_path);
                const resp = await withRetry(() => fetch(urlData.publicUrl));
                if (!resp.ok) throw new Error(`Failed to download clip: ${resp.status}`);
                return new Uint8Array(await resp.arrayBuffer());
              })
            );
            clipBuffers.push(...buffers);
            await log("debug", `Downloaded batch ${Math.floor(i / 3) + 1}/${Math.ceil(completedClips.length / 3)}`);
          }

          const hasSelectedTrack = !!(project as any).selected_track_id;
          
          let finalVideo: Uint8Array;
          if (clipBuffers.length === 1) {
            // Single clip: if selected track exists, strip to video-only to remove generator audio
            if (hasSelectedTrack) {
              try {
                finalVideo = concatenateMP4(clipBuffers, { videoOnly: true });
                await log("info", "Single clip — stripped to video-only for music mux.");
              } catch (stripErr) {
                await log("warn", `Single clip strip failed: ${stripErr.message} — using original.`);
                finalVideo = clipBuffers[0];
              }
            } else {
              finalVideo = clipBuffers[0];
              await log("info", "Single clip — using directly as final video.");
            }
          } else {
            await log("info", `Concatenating ${clipBuffers.length} clips via MP4 remuxer...`);
            try {
              finalVideo = concatenateMP4(clipBuffers, { videoOnly: hasSelectedTrack });
              await log("info", `MP4 remux succeeded${hasSelectedTrack ? " (video-only)" : ""}. Output: ${(finalVideo.length / 1024 / 1024).toFixed(1)}MB`);
            } catch (concatErr) {
              await log("warn", `MP4 remux failed: ${concatErr.message} — using first clip as fallback.`);
              finalVideo = clipBuffers[0];
            }
          }

          // Resolve selected track once (used by compose and mux fallback)
          let selectedTrack: { supabase_path: string; title: string } | null = null;
          let selectedTrackUrl: string | null = null;
          if (hasSelectedTrack) {
            const { data: track } = await supabase
              .from("tracks")
              .select("supabase_path, title")
              .eq("id", (project as any).selected_track_id)
              .single();
            if (!track) {
              throw new Error("Selected track not found.");
            }
            selectedTrack = track;
            selectedTrackUrl = supabase.storage.from("project-assets").getPublicUrl(track.supabase_path).data.publicUrl;
          }

          // ── POST-PRODUCTION via Rendi (raw FFmpeg commands) ──
          // Single FFmpeg command handles overlays + audio in one pass.
          // Fallback: local muxMP3IntoMP4 if Rendi fails for audio.
          const RENDI_API_KEY = Deno.env.get("RENDI_API_KEY");
          const FAL_KEY = Deno.env.get("FAL_KEY"); // kept for backward compat
          const videoDurationSec = completedClips.length * (project.clip_duration_sec || 5);

          try {
            const { data: overlays } = await supabase
              .from("overlays")
              .select("*")
              .eq("project_id", project.id)
              .order("sort_order");

            const imageOverlays = (overlays || []).filter((o: any) => o.overlay_type === "image" && o.image_path);
            // Explode ai_sequence overlays into individual text overlay entries
            const rawTextOverlays = (overlays || []).filter((o: any) => o.overlay_type === "text" && o.content_mode !== "ai_sequence" && o.content_text);
            const seqOverlays = (overlays || []).filter((o: any) => o.overlay_type === "text" && o.content_mode === "ai_sequence" && o.content_text);
            const explodedSeqOverlays: any[] = [];
            for (const seqOv of seqOverlays) {
              try {
                const frames: Array<{ text: string; start_pct: number; end_pct: number }> = JSON.parse(seqOv.content_text);
                for (const frame of frames) {
                  if (frame.text && typeof frame.start_pct === "number" && typeof frame.end_pct === "number") {
                    explodedSeqOverlays.push({
                      ...seqOv,
                      content_text: frame.text,
                      start_pct: frame.start_pct,
                      end_pct: frame.end_pct,
                    });
                  }
                }
              } catch {
                // If content_text isn't valid JSON, skip this overlay
              }
            }
            const textOverlays = [...rawTextOverlays, ...explodedSeqOverlays];
            const hasOverlays = imageOverlays.length > 0 || textOverlays.length > 0;
            const resScale = getResolutionScale((project as any).pika_resolution || "540p");
            const needsPostProd = hasOverlays || hasSelectedTrack;

            const tempCleanupPaths: string[] = [];

            if (needsPostProd && RENDI_API_KEY) {
              await log("info", `Rendi post-production: ${textOverlays.length} text overlay(s), ${imageOverlays.length} image overlay(s), music=${hasSelectedTrack ? "yes" : "no"}`);

              // Upload base video for Rendi access
              const tempVideoPath = `${project.id}/final/${runId}/pre-rendi-${Date.now()}.mp4`;
              await supabase.storage
                .from("project-assets")
                .upload(tempVideoPath, finalVideo, { contentType: "video/mp4", upsert: true });
              tempCleanupPaths.push(tempVideoPath);
              const { data: tempVideoUrl } = supabase.storage.from("project-assets").getPublicUrl(tempVideoPath);

              // Build input_files map for Rendi
              const inputFiles: Record<string, string> = {
                in_video: tempVideoUrl.publicUrl,
              };

              // Add Anton font for text overlays (condensed bold, social-media / game-style)
              const FONT_URL = "https://esdnydtcheytbrwonlqh.supabase.co/storage/v1/object/public/project-assets/fonts%2FAnton-Regular.ttf";
              if (textOverlays.length > 0) {
                inputFiles["in_font"] = FONT_URL;
              }

              let imgInputIdx = 0;
              for (const imgOv of imageOverlays) {
                if (!imgOv.image_path) continue;
                const { data: imgUrl } = supabase.storage.from("project-assets").getPublicUrl(imgOv.image_path);
                const key = `in_img${imgInputIdx}`;
                inputFiles[key] = imgUrl.publicUrl;
                imgInputIdx++;
              }

              // Add audio input if selected
              if (hasSelectedTrack && selectedTrackUrl) {
                inputFiles["in_audio"] = selectedTrackUrl;
              }

              // Resolve real ffmpeg input indexes from the sorted input key order used in inputArgs
              const sortedInputKeys = Object.keys(inputFiles).sort();
              // Media inputs exclude font (font is referenced via fontfile=, not -i)
              const mediaInputKeys = sortedInputKeys.filter((k) => k !== "in_font");
              const getInputIndex = (key: string): number => mediaInputKeys.indexOf(key);
              const videoInputIdx = getInputIndex("in_video");

              // Build FFmpeg filter_complex
              const filterParts: string[] = [];
              let currentVideoLabel = `${videoInputIdx}:v`;
              let filterIdx = 0;

              // Image overlays: chain overlay filters
              for (let i = 0; i < imageOverlays.length; i++) {
                const imgOv = imageOverlays[i];
                const startSec = (imgOv.start_pct / 100) * videoDurationSec;
                const endSec = (imgOv.end_pct / 100) * videoDurationSec;
                const imageInputIdx = getInputIndex(`in_img${i}`);
                const outLabel = `v${filterIdx}`;
                const scaledImgLabel = `img_s${i}`;

                // Position mapping for image overlays
                const pos = getFFmpegOverlayPosition(imgOv.position, resScale);

                // Scale image overlay proportionally to resolution (authored at 540p baseline)
                if (resScale !== 1) {
                  filterParts.push(
                    `[${imageInputIdx}:v]scale=iw*${resScale.toFixed(2)}:ih*${resScale.toFixed(2)}:flags=lanczos[${scaledImgLabel}]`
                  );
                  filterParts.push(
                    `[${currentVideoLabel}][${scaledImgLabel}]overlay=${pos}:enable='between(t,${startSec.toFixed(1)},${endSec.toFixed(1)})'[${outLabel}]`
                  );
                } else {
                  filterParts.push(
                    `[${currentVideoLabel}][${imageInputIdx}:v]overlay=${pos}:enable='between(t,${startSec.toFixed(1)},${endSec.toFixed(1)})'[${outLabel}]`
                  );
                }
                currentVideoLabel = outLabel;
                filterIdx++;
              }

              // Text overlays: use drawtext filter (no external files needed)
              for (const textOv of textOverlays) {
                const rawText = (textOv.content_text || "");
                const fontSize = Math.round((textOv.font_size || 48) * resScale);
                const wrappedText = wrapOverlayText(rawText, fontSize, resScale);
                const text = wrappedText.replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/\n/g, "\\n");
                const fontSize = Math.round((textOv.font_size || 48) * resScale);
                const fontColor = textOv.font_color || "#FFFFFF";
                const startSec = (textOv.start_pct / 100) * videoDurationSec;
                const endSec = (textOv.end_pct / 100) * videoDurationSec;
                const outLabel = `v${filterIdx}`;

                // Position mapping for drawtext
                const posStr = getFFmpegPosition(textOv.position, fontSize, resScale);

                // Build drawtext with background box
                const bgColor = textOv.bg_color || "rgba(0,0,0,0.5)";
                // Convert rgba to ffmpeg box color format
                let boxColor = "black@0.5";
                const rgbaMatch = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
                if (rgbaMatch) {
                  const r = parseInt(rgbaMatch[1]).toString(16).padStart(2, "0");
                  const g = parseInt(rgbaMatch[2]).toString(16).padStart(2, "0");
                  const b = parseInt(rgbaMatch[3]).toString(16).padStart(2, "0");
                  const a = rgbaMatch[4] ? parseFloat(rgbaMatch[4]) : 1;
                  boxColor = `0x${r}${g}${b}@${a}`;
                }

                const scaledBoxBorder = Math.round(10 * resScale);

                // Reference Anton font file — thick black outline, white fill (game/social style)
                const fontFileRef = `fontfile={{in_font}}`;

                // Thick black outline scaled to resolution (≈6px at 540p)
                const borderW = Math.max(3, Math.round(6 * resScale));
                filterParts.push(
                  `[${currentVideoLabel}]drawtext=text='${text}':${fontFileRef}:fontsize=${fontSize}:fontcolor=${fontColor}:borderw=${borderW}:bordercolor=black:${posStr}:box=1:boxcolor=${boxColor}:boxborderw=${scaledBoxBorder}:enable='between(t,${startSec.toFixed(1)},${endSec.toFixed(1)})'[${outLabel}]`
                );
                currentVideoLabel = outLabel;
                filterIdx++;
              }

              // Build the full FFmpeg command
              let ffmpegCmd: string;
              const inputArgs = mediaInputKeys
                .map((k) => `-i {{${k}}}`)
                .join(" ");

              if (filterParts.length > 0) {
                const filterComplex = filterParts.join(";");
                if (hasSelectedTrack && selectedTrackUrl) {
                  const audioInputIdx = getInputIndex("in_audio");
                  ffmpegCmd = `${inputArgs} -filter_complex "${filterComplex}" -map "[${currentVideoLabel}]" -map ${audioInputIdx}:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -shortest -movflags +faststart {{out_1}}`;
                } else {
                  // Keep original clip audio when no replacement music track is selected
                  ffmpegCmd = `${inputArgs} -filter_complex "${filterComplex}" -map "[${currentVideoLabel}]" -map ${videoInputIdx}:a? -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -movflags +faststart {{out_1}}`;
                }
              } else if (hasSelectedTrack && selectedTrackUrl) {
                // No overlays, just audio merge
                const audioInputIdx = getInputIndex("in_audio");
                ffmpegCmd = `${inputArgs} -map ${videoInputIdx}:v -map ${audioInputIdx}:a -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart {{out_1}}`;
              } else {
                // Nothing to do
                ffmpegCmd = "";
              }

              if (ffmpegCmd) {
                await log("info", `Rendi FFmpeg command: ${ffmpegCmd.substring(0, 200)}...`);

                try {
                  // Submit to Rendi
                  const rendiResp = await withRetry(() =>
                    fetch("https://api.rendi.dev/v1/run-ffmpeg-command", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "X-API-KEY": RENDI_API_KEY,
                      },
                      body: JSON.stringify({
                        ffmpeg_command: ffmpegCmd,
                        input_files: inputFiles,
                        output_files: { out_1: "output.mp4" },
                        max_command_run_seconds: 60,
                        vcpu_count: 8,
                      }),
                    })
                  );

                  if (!rendiResp.ok) {
                    const errText = await rendiResp.text();
                    throw new Error(`Rendi submit failed (${rendiResp.status}): ${errText.substring(0, 300)}`);
                  }

                  const { command_id } = await rendiResp.json();
                  await log("info", `Rendi command submitted: ${command_id}`);

                  // Poll for completion
                  let rendiSuccess = false;
                  for (let poll = 0; poll < 60; poll++) {
                    await new Promise((r) => setTimeout(r, 3000));
                    const pollResp = await fetch(`https://api.rendi.dev/v1/commands/${command_id}`, {
                      headers: { "X-API-KEY": RENDI_API_KEY },
                    });
                    if (!pollResp.ok) {
                      await log("warn", `Rendi poll failed: ${pollResp.status}`);
                      continue;
                    }
                    const pollData = await pollResp.json();

                    if (pollData.status === "SUCCESS") {
                      const outputUrl = pollData.output_files?.out_1?.storage_url;
                      if (!outputUrl) {
                        throw new Error("Rendi succeeded but no output URL found.");
                      }
                      const dlResp = await fetch(outputUrl);
                      if (!dlResp.ok) throw new Error(`Rendi output download failed: ${dlResp.status}`);
                      finalVideo = new Uint8Array(await dlResp.arrayBuffer());
                      rendiSuccess = true;
                      await log("info", `Rendi post-production succeeded. Size: ${(finalVideo.length / 1024 / 1024).toFixed(1)}MB, hasAudio=${hasAudioTrack(finalVideo)}`);
                      break;
                    }

                    if (pollData.status === "FAILED" || pollData.status === "ERROR") {
                      throw new Error(`Rendi command failed: ${JSON.stringify(pollData).substring(0, 300)}`);
                    }

                    // Still processing, continue polling
                  }

                  if (!rendiSuccess) {
                    throw new Error("Rendi command timed out after 3 minutes.");
                  }
                } catch (rendiErr) {
                  await log("warn", `Rendi failed: ${(rendiErr as Error).message} — falling back to local processing.`);

                  // Fallback: local mux for audio (overlays are lost but audio is preserved)
                  if (hasSelectedTrack && selectedTrackUrl) {
                    try {
                      const mp3Resp = await withRetry(() => fetch(selectedTrackUrl!));
                      if (!mp3Resp.ok) throw new Error(`Download failed: ${mp3Resp.status}`);
                      const mp3Bytes = new Uint8Array(await mp3Resp.arrayBuffer());
                      finalVideo = muxMP3IntoMP4(finalVideo, mp3Bytes, videoDurationSec);
                      await log("info", `Local MP3 mux fallback succeeded. Size: ${(finalVideo.length / 1024 / 1024).toFixed(1)}MB`);
                    } catch (localErr) {
                      await log("error", `Local MP3 mux also failed: ${(localErr as Error).message}`);
                    }
                  }
                }
              }
            } else if (needsPostProd && !RENDI_API_KEY) {
              await log("warn", "RENDI_API_KEY not set — attempting local audio mux only (overlays skipped).");
              if (hasSelectedTrack && selectedTrackUrl) {
                try {
                  const mp3Resp = await withRetry(() => fetch(selectedTrackUrl!));
                  if (mp3Resp.ok) {
                    const mp3Bytes = new Uint8Array(await mp3Resp.arrayBuffer());
                    finalVideo = muxMP3IntoMP4(finalVideo, mp3Bytes, videoDurationSec);
                    await log("info", `Local MP3 mux succeeded. Size: ${(finalVideo.length / 1024 / 1024).toFixed(1)}MB`);
                  }
                } catch (localErr) {
                  await log("error", `Local MP3 mux failed: ${(localErr as Error).message}`);
                }
              }
            }

            // Hard guarantee: when a selected track exists, final candidate must contain audio.
            if (hasSelectedTrack && selectedTrackUrl) {
              if (!hasAudioTrack(finalVideo)) {
                // One last try with local mux
                await log("warn", "Final candidate has no audio — last-resort local MP3 mux.");
                try {
                  const mp3Resp = await withRetry(() => fetch(selectedTrackUrl!));
                  if (!mp3Resp.ok) throw new Error(`Download failed: ${mp3Resp.status}`);
                  const mp3Bytes = new Uint8Array(await mp3Resp.arrayBuffer());
                  finalVideo = muxMP3IntoMP4(finalVideo, mp3Bytes, videoDurationSec);
                  await log("info", `Last-resort local mux succeeded. hasAudio=${hasAudioTrack(finalVideo)}`);
                } catch (lastErr) {
                  await log("error", `Last-resort local mux failed: ${(lastErr as Error).message}`);
                }
              }
              if (!hasAudioTrack(finalVideo)) {
                throw new Error("Selected music track is configured, but final output still has no audio after all attempts.");
              }
            }

            // Cleanup temp files
            if (tempCleanupPaths.length > 0) {
              await supabase.storage.from("project-assets").remove(tempCleanupPaths);
            }
          } catch (composeStepErr) {
            if (hasSelectedTrack) {
              throw composeStepErr;
            }
            await log("warn", `Post-production step failed: ${(composeStepErr as Error).message} — continuing with stitched video.`);
          }

          const finalPath = `${project.id}/final/${runId}/final-video-${Date.now()}.mp4`;
          const { error: upErr } = await supabase.storage
            .from("project-assets")
            .upload(finalPath, finalVideo, { contentType: "video/mp4", upsert: false });

          if (!upErr) {
            await supabase.from("assets").delete().eq("run_id", runId).eq("type", "final_video");

            await supabase.from("assets").insert({
              supabase_path: finalPath,
              type: "final_video" as any,
              run_id: runId,
              metadata: {
                scene_count: completedClips.length,
                source_clips: completedClips.map((c: any) => c.supabase_path),
                size_bytes: finalVideo.length,
                concat_method: clipBuffers.length > 1 ? "mp4_remux" : "single_clip",
                music_track: hasSelectedTrack ? (project as any).selected_track_id : null,
              },
            });
            await log("info", "Final video uploaded successfully.");
          } else {
            throw new Error(`Final video upload failed: ${upErr.message}`);
          }
        }
      } catch (err) {
        const stitchError = `Stitch step failed: ${err.message}`;
        await log("error", stitchError);
        await updateRun({
          status: "failed",
          error_message: stitchError,
          finished_at: new Date().toISOString(),
        });
        return json({ error: stitchError }, 500);
      }

      await updateRun({ current_step: "metadata", progress_pct: 75 });
    }

    // ===== STEP 5: THUMBNAIL & METADATA =====
    if (run.current_step === "metadata" || run.current_step === "stitch") {
      await log("info", "Step 5/7: Generating thumbnail & metadata...");

      // Thumbnail from first keyframe
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

      // AI per-platform metadata generation
      try {
        const runMetadata = (run.generated_metadata as any) || {};
        const resolvedConfig: PromptConfig = runMetadata.resolved_prompt_config || buildResolvedPromptConfig(project);
        const metaConfig = resolvedConfig.metadata;

        const { data: scenes } = await supabase
          .from("scenes")
          .select("scene_title, scene_description")
          .eq("run_id", runId)
          .order("scene_index");

        const scenesSummary =
          scenes?.map((s: any) => `${s.scene_title}: ${s.scene_description}`).join("\n") || "";

        const conceptPrompt = resolvedConfig.global.concept_prompt || project.series_prompt || project.title;

        const enabledPlatforms = Object.entries((project.publish_platforms as Record<string, boolean>) || {})
          .filter(([_, enabled]) => enabled)
          .map(([platform]) => platform);

        // Platform-specific metadata guidelines
        const platformGuidelines: Record<string, string> = {
          instagram: `INSTAGRAM REELS metadata rules:
- The "title" field IS the first line of the caption (the hook). Max 125 characters. Make it curiosity-driven or outcome-focused. Use keywords naturally (IG search indexes captions).
- Good hook structures: curiosity ("Nobody tells you this about..."), result ("How I..."), problem ("If your... aren't working, do this").
- The "description" is the caption body. Use 2-3 short paragraphs. Include search keywords naturally. End with a CTA ("Follow for more", "Save this for later").
- Hashtags: 3-8 total. Mix: 2 niche, 2 medium, 1-2 broad. NO #fyp #viral #explore.
- Total caption (title + description + hashtags) should be 100-200 characters ideally.`,

          tiktok: `TIKTOK metadata rules:
- The "title" IS the first line of the caption. Include the exact search phrase users would type. Use question or problem-solution style.
- TikTok SEO ranks videos by: caption keywords, on-screen text, voice transcription. Keywords are critical.
- The "description" is the rest of the caption. Keep it short (80-150 chars total). Use natural keyword phrases.
- Hashtags: 3-5 max. Mix: 1 niche, 1 industry, 1 broad, optionally 1 trending. NO #fyp #viral #xyzbca — these no longer boost reach.`,

          youtube: `YOUTUBE SHORTS metadata rules:
- The "title" is a formal title field. 40-60 characters. Include the main search keyword. Make it curiosity-driven.
- Good formats: "3 AI Tools That Save You Hours", "The Truth About...", "How I Made..."
- Avoid generic titles like "Watch This!!" or "Crazy Video".
- The "description" helps search indexing. Write 1-2 sentences. Include the main keyword again.
- Hashtags: 3-5. Always include #shorts.
- YouTube reads: video transcript, title keywords, engagement signals.`,

          facebook: `FACEBOOK REELS metadata rules:
- The "title" is the first line. Be clear and descriptive (not cryptic). Include topic keywords.
- Example: "3 mistakes people make when buying their first house"
- The "description" should be 1-2 sentences explaining the reel. Include keywords Facebook search can index.
- Hashtags: 3-5.
- Facebook prioritizes watch time, shares, and comments. Metadata helps classification, not virality.`,
        };

        const UNIVERSAL_RULES = `
CRITICAL RULES FOR ALL PLATFORMS:
- NEVER include anything that makes the content seem AI-generated. No mentions of AI, algorithms, prompts, or generated content.
- Write as a human creator sharing authentic content.
- First line = hook. Put the keyword at the beginning. Shorter is always better.
- Use the viral caption formula: HOOK → CONTEXT → CTA.
- Hook formats that work: Question, Mistake, Secret, List, Result.
- Each platform's metadata must feel native to that platform — NOT copy-pasted across platforms.`;

        const platformsToGenerate = enabledPlatforms.length > 0
          ? enabledPlatforms
          : ["instagram", "tiktok", "youtube", "facebook"];

        const platformProperties: Record<string, any> = {};
        for (const p of platformsToGenerate) {
          platformProperties[p] = {
            type: "object",
            properties: {
              title: { type: "string", description: `Platform-optimized title/hook for ${p}` },
              description: { type: "string", description: `Platform-optimized description/caption body for ${p}` },
              hashtags: { type: "array", items: { type: "string" }, description: `Hashtags without # prefix for ${p}` },
            },
            required: ["title", "description", "hashtags"],
          };
        }

        const perPlatformGuidelines = platformsToGenerate
          .map(p => platformGuidelines[p] || `${p.toUpperCase()}: Generate appropriate title, description, and hashtags.`)
          .join("\n\n");

        // Also allow custom metadata prompts from config to augment (not replace) the platform rules
        const customInstructions = [
          metaConfig.title_prompt ? `Additional title guidance: ${metaConfig.title_prompt}` : "",
          metaConfig.description_prompt ? `Additional description guidance: ${metaConfig.description_prompt}` : "",
          metaConfig.hashtag_prompt ? `Additional hashtag guidance: ${metaConfig.hashtag_prompt}` : "",
        ].filter(Boolean).join("\n");

        const metadataPromptMessages = [
          {
            role: "system",
            content: `You are an elite social media content strategist who writes platform-native metadata. You write as a human creator — never as AI. Your captions feel authentic, engaging, and perfectly tuned for each platform's algorithm and culture.${UNIVERSAL_RULES}`,
          },
          {
            role: "user",
            content: `Generate platform-specific metadata for this video. Each platform MUST get uniquely optimized content — do NOT reuse the same text across platforms.

VIDEO CONCEPT: ${conceptPrompt}

SCENES:
${scenesSummary}

=== PLATFORM-SPECIFIC GUIDELINES ===
${perPlatformGuidelines}

${customInstructions ? `=== ADDITIONAL INSTRUCTIONS ===\n${customInstructions}` : ""}

Generate metadata for these platforms: ${platformsToGenerate.join(", ")}`,
          },
        ];

        await log("debug", "🔵 AI CALL → model=google/gemini-2.5-flash, tool=generate_platform_metadata", {
          platforms: platformsToGenerate,
          messages: metadataPromptMessages.map(m => ({
            role: m.role,
            content: m.content.length > 500 ? m.content.substring(0, 500) + "…[truncated]" : m.content,
          })),
        });

        const aiResp = await withRetry(() =>
          fetch(AI_GATEWAY, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${LOVABLE_API_KEY}`,
            },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash",
              messages: metadataPromptMessages,
              tools: [
                {
                  type: "function",
                  function: {
                    name: "generate_platform_metadata",
                    description: "Generate per-platform video post metadata",
                    parameters: {
                      type: "object",
                      properties: platformProperties,
                      required: platformsToGenerate,
                      additionalProperties: false,
                    },
                  },
                },
              ],
              tool_choice: { type: "function", function: { name: "generate_platform_metadata" } },
            }),
          })
        );

        const metaResult = await aiResp.json();
        const metaToolCall = metaResult.choices?.[0]?.message?.tool_calls?.[0];

        await log("debug", "🟢 AI RESP ← model=google/gemini-2.5-flash", {
          tool_call: metaToolCall ? {
            name: metaToolCall.function?.name,
            args_preview: metaToolCall.function?.arguments?.substring(0, 800),
          } : null,
          finish_reason: metaResult?.choices?.[0]?.finish_reason,
          usage: metaResult?.usage,
        });

        if (metaToolCall) {
          const platformMetadata = JSON.parse(metaToolCall.function.arguments);
          // Store per-platform metadata AND keep a fallback title/description from the first platform
          const firstPlatform = platformsToGenerate[0];
          const fallback = platformMetadata[firstPlatform] || {};
          await updateRun({
            generated_metadata: {
              ...runMetadata,
              title: fallback.title || project.title,
              description: fallback.description || "",
              hashtags: fallback.hashtags || [],
              platform_metadata: platformMetadata,
            },
          });
          await log("info", "Per-platform metadata generated", { platforms: Object.keys(platformMetadata) });
        }
      } catch (err) {
        await log("warn", `Metadata generation failed: ${err.message}`);
      }

      await updateRun({ current_step: "publish", progress_pct: 90 });
    }

    // ===== STEP 6: PUBLISH =====
    // Idempotency: skip if publish job already exists
    const { data: existingJobs } = await supabase
      .from("publish_jobs")
      .select("id")
      .eq("run_id", runId)
      .limit(1);
    if (existingJobs && existingJobs.length > 0) {
      await log("info", "Publish job already exists — skipping duplicate publish.");
    } else if (!project.uploadpost_api_key_encrypted || !project.uploadpost_api_key_configured) {
      await log("warn", "Upload-Post API key not configured — skipping publish.");
    } else {
      try {
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

          const { data: freshRun } = await supabase
            .from("runs")
            .select("generated_metadata")
            .eq("id", runId)
            .single();
          const metadata = (freshRun?.generated_metadata as any) || {};
          const platformMetadata = metadata.platform_metadata || {};
          // Fallback for backward compatibility
          const fallbackTitle = metadata.title || project.title || "Untitled Video";
          const fallbackDescription = metadata.description || "";
          const fallbackHashtags = metadata.hashtags || [];

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

            // Build per-platform metadata, falling back to generic if platform-specific not available
            const getPlatformMeta = (platform: string) => {
              const pm = platformMetadata[platform];
              if (pm) {
                const hashtags = (pm.hashtags || []).map((h: string) => `#${h}`).join(" ");
                return {
                  title: pm.title || fallbackTitle,
                  description: (pm.description || fallbackDescription) + (hashtags ? `\n\n${hashtags}` : ""),
                };
              }
              const hashtagStr = fallbackHashtags.map((h: string) => `#${h}`).join(" ");
              return {
                title: fallbackTitle,
                description: fallbackDescription + (hashtagStr ? `\n\n${hashtagStr}` : ""),
              };
            };

            // If all platforms share the same Upload-Post request, we use the first platform's metadata
            // But since Upload-Post accepts one title/description, we send separate requests per platform
            // for truly personalized metadata. Group platforms with identical metadata to minimize API calls.
            const metaByPlatform = enabledPlatforms.map(p => ({ platform: p, ...getPlatformMeta(p) }));

            // Group platforms by identical title+description to batch API calls
            const metaGroups = new Map<string, { title: string; description: string; platforms: string[] }>();
            for (const pm of metaByPlatform) {
              const key = `${pm.title}|||${pm.description}`;
              if (metaGroups.has(key)) {
                metaGroups.get(key)!.platforms.push(pm.platform);
              } else {
                metaGroups.set(key, { title: pm.title, description: pm.description, platforms: [pm.platform] });
              }
            }

            await log("info", `Publishing to ${enabledPlatforms.length} platforms in ${metaGroups.size} batch(es)`, {
              videoUrl,
              groups: [...metaGroups.values()].map(g => ({ platforms: g.platforms, title: g.title.substring(0, 80) })),
            });

            let lastRequestId: string | null = null;
            let lastJobId: string | null = null;
            let anySuccess = false;

            for (const group of metaGroups.values()) {
              const formData = new FormData();
              formData.append("video", videoUrl);
              formData.append("title", group.title);
              formData.append("description", group.description);
              formData.append("async_upload", "true");

              if (project.uploadpost_profile_username) {
                formData.append("user", project.uploadpost_profile_username);
              }

              for (const platform of group.platforms) {
                formData.append("platform[]", platform);
              }

              for (const platform of group.platforms) {
                const defaults = publishDefaults[platform] || {};
                for (const [key, value] of Object.entries(defaults)) {
                  if (value !== undefined && value !== null && value !== "") {
                    formData.append(key, String(value));
                  }
                }
              }

              const uploadResp = await withRetry(() =>
                fetch("https://api.upload-post.com/api/upload", {
                  method: "POST",
                  headers: { Authorization: `Apikey ${apiKey}` },
                  body: formData,
                })
              );

              const uploadResult = await uploadResp.json();
              await log("info", `Upload-Post response for [${group.platforms.join(",")}]`, uploadResult);

              if (uploadResp.ok && uploadResult.request_id) {
                lastRequestId = uploadResult.request_id;
                lastJobId = uploadResult.job_id || null;
                anySuccess = true;
              } else {
                await log("error", `Upload-Post failed for [${group.platforms.join(",")}]: ${JSON.stringify(uploadResult)}`);
              }
            }

            if (anySuccess && lastRequestId) {
              await supabase
                .from("publish_jobs")
                .update({
                  uploadpost_request_id: lastRequestId,
                  uploadpost_job_id: lastJobId,
                  status: "polling" as const,
                })
                .eq("id", publishJob!.id);
              await log("info", `Upload-Post submitted: ${lastRequestId}`);
            } else {
              await supabase
                .from("publish_jobs")
                .update({ status: "failed" as const, platform_results: { error: "All platform submissions failed" } })
                .eq("id", publishJob!.id);
              await log("error", "All Upload-Post submissions failed.");
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

    // Send success notification email
    try {
      const notifyUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-notification`;
      await fetch(notifyUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ run_id: runId, type: "completed" }),
      });
    } catch (notifyErr) {
      console.error("Notification send error:", notifyErr);
    }

    return json({ status: "completed", run_id: runId });
  } catch (err) {
    await log("error", `Finalize-video failed: ${err.message}`);
    await updateRun({
      status: "failed",
      error_message: `Finalize failed: ${err.message}`,
      finished_at: new Date().toISOString(),
    });

    // Send error notification email
    try {
      const notifyUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-notification`;
      await fetch(notifyUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ run_id: runId, type: "error", error_message: err.message }),
      });
    } catch (notifyErr) {
      console.error("Notification send error:", notifyErr);
    }

    return json({ error: err.message }, 500);
  }
});
