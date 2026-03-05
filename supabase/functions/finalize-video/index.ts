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

function getMdia(data: Uint8Array, trak: Box): Box | null {
  const trakChildren = scanBoxes(data, trak.start + trak.hdr, trak.start + trak.size);
  return trakChildren.find((b) => b.type === "mdia") || null;
}

function concatenateMP4(files: Uint8Array[]): Uint8Array {
  if (files.length === 0) throw new Error("No files to concatenate");
  if (files.length === 1) return files[0];

  const parsed = files.map(parseFile);
  const first = parsed[0];

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
      moovParts.push(rebuiltTraks[trakIndex++]);
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

          let finalVideo: Uint8Array;
          if (clipBuffers.length === 1) {
            finalVideo = clipBuffers[0];
            await log("info", "Single clip — using directly as final video.");
          } else {
            await log("info", `Concatenating ${clipBuffers.length} clips via MP4 remuxer...`);
            try {
              finalVideo = concatenateMP4(clipBuffers);
              await log("info", `MP4 remux succeeded. Output: ${(finalVideo.length / 1024 / 1024).toFixed(1)}MB`);
            } catch (concatErr) {
              await log("warn", `MP4 remux failed: ${concatErr.message} — using first clip as fallback.`);
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
                concat_method: clipBuffers.length > 1 ? "mp4_remux" : "single_clip",
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

      // AI metadata generation
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
          const title = metadata.title || project.title || "Untitled Video";
          const description = metadata.description || "";
          const hashtags = metadata.hashtags || [];
          const hashtagStr = hashtags.map((h: string) => `#${h}`).join(" ");
          const fullDescription = description + (hashtagStr ? `\n\n${hashtagStr}` : "");

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
