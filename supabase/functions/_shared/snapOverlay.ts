// Snap-caption ffmpeg-layout helper (Deno / Supabase Edge).
//
// Builds the exact filter_complex fragments that finalize-video sends to
// Rendi for a snap caption with inline iOS emojis. No PNG round-trip: text
// is rendered by ffmpeg `drawtext`, color emojis by ffmpeg `overlay` of the
// Apple Color Emoji PNGs (one per codepoint, sourced from Supabase Storage
// at `overlays/apple-emoji/<codepoint>.png`).
//
// Per-run x positions are measured client-side with `opentype.js` over the
// same Inter Regular TTF we ship to Rendi as `in_font_snap`. Same font +
// same size = same advance widths as ffmpeg's drawtext renderer, so the
// layout lands pixel-accurate without a measure pass on the Rendi side.
//
// If a snap's text + emojis won't fit at the requested font size with the
// configured side margin, the helper auto-shrinks the font in 2 px steps
// until it fits (or hits `minFontSize`). All filter parts are wrapped with
// the caller-supplied `enableExpr` so the snap appears only during the
// hook window.

// @deno-types="https://esm.sh/opentype.js@1.3.4/dist/opentype.d.ts"
import opentype from "https://esm.sh/opentype.js@1.3.4";
import { mediaPublicUrl } from "./r2.ts";

// Codepoints currently used across the live POV-hook variants. Adding a new
// emoji to a variant requires (a) adding its stem here AND (b) uploading
// the Apple PNG to Supabase Storage at overlays/apple-emoji/<stem>.png.
export const KNOWN_EMOJIS: Record<string, string> = {
  "\u{1f480}": "1f480", // 💀 skull
  "\u{1f6a8}": "1f6a8", // 🚨 siren
  "\u{1f910}": "1f910", // 🤐 zipper-mouth
  "\u{1f62d}": "1f62d", // 😭 loudly crying
  "\u{1f440}": "1f440", // 👀 eyes
  "\u{1f928}": "1f928", // 🤨 raised eyebrow
  "\u{1f60d}": "1f60d", // 😍
  "\u{1f602}": "1f602", // 😂
  "\u{1fae0}": "1fae0", // 🫠 melting face
  "\u{1f633}": "1f633", // 😳 flushed
  "\u{1f622}": "1f622", // 😢
};

// Inter Regular — the snap-caption text font. Sourced from Supabase Storage
// at fonts/Inter-Regular.ttf (uploaded once, out of band) so we don't depend
// on an external CDN. Cached at module scope across invocations in the same
// edge function container.
let interFont: any = null;

async function getInterFont(): Promise<any> {
  if (interFont) return interFont;
  const url = mediaPublicUrl("fonts/Inter-Regular.ttf");
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch Inter font from ${url}: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  interFont = (opentype as any).parse(buf);
  return interFont;
}

type Run =
  | { kind: "text"; text: string }
  | { kind: "emoji"; codepoint: string };

function splitRuns(text: string): Run[] {
  const runs: Run[] = [];
  let buf = "";
  for (const ch of text) {
    if (KNOWN_EMOJIS[ch]) {
      if (buf) { runs.push({ kind: "text", text: buf }); buf = ""; }
      runs.push({ kind: "emoji", codepoint: KNOWN_EMOJIS[ch] });
    } else {
      buf += ch;
    }
  }
  if (buf) runs.push({ kind: "text", text: buf });
  return runs;
}

// Mirrors the existing escapeFFmpegDrawtextText() in finalize-video.
// Apostrophes drop because ffmpeg's filter parser treats `'` as a quote
// delimiter and the multi-level backslash escape is brittle.
function escapeDrawtextValue(s: string): string {
  return s
    .replace(/['"\[\]]/g, "")
    .replace(/,/g, "")
    .replace(/%/g, "pct")
    .replace(/\\/g, "")
    .replace(/:/g, " -")
    .replace(/ /g, "\\ ");
}

export interface SnapCaptionInput {
  /** The snap text (may contain known emojis inline). */
  text: string;
  /** Requested font size in pixels (auto-shrinks if too wide). Default 48. */
  fontSize?: number;
  /** Final video frame width in px. */
  frameW: number;
  /** Final video frame height in px. */
  frameH: number;
  /**
   * Vertical position of the band CENTER, as a percent measured from the
   * BOTTOM of the frame (0 = bottom, 100 = top). Matches the snap_overlay
   * config convention. Default 30 (=70% from top).
   */
  positionPct?: number;
  /** Band background opacity 0..1. Default 0.55. */
  bandAlpha?: number;
  /** Pixel padding around each emoji slot. Default 8. */
  emojiPad?: number;
  /** Min horizontal margin from each frame edge. Default 40. */
  sideMargin?: number;
  /** Auto-shrink lower bound. Default 28. */
  minFontSize?: number;
  /**
   * ffmpeg `enable=` expression so the snap appears only during the hook
   * window. e.g. `between(t\\,0\\,4)` (commas already filter-escaped).
   */
  enableExpr: string;
  /** Starting video label (the chain input). e.g. `concatv`. */
  inputVideoLabel: string;
  /** Index of the snap font input (Inter) in the Rendi -i input list. */
  fontInputIndex: number;
  /**
   * Maps an emoji codepoint stem to its index in the Rendi -i input list.
   * The caller is responsible for adding `in_emoji_<stem>` to inputFiles
   * BEFORE invoking the layout helper so the indices line up.
   */
  emojiInputIndex: (codepoint: string) => number;
  /**
   * Starting filter-index for label naming. The helper emits labels
   * `snap_v{startIdx}..snap_v{startIdx+N-1}` so they won't collide with
   * the surrounding filter graph. Default 0.
   */
  startIdx?: number;
}

export interface SnapCaptionResult {
  /** ffmpeg filter_complex fragments. Concatenate into the final graph. */
  filterParts: string[];
  /** The final output video label after the snap chain. */
  outputVideoLabel: string;
  /** Codepoint stems the caller MUST register as in_emoji_<stem> inputs. */
  emojiCodepoints: string[];
  /** Actual font size used (may be lower than requested due to auto-shrink). */
  fontSize: number;
  /** Band geometry, for callers that want to log / debug. */
  bandY: number;
  bandH: number;
}

/**
 * Build the snap-caption filter chain. Does NOT mutate inputFiles or run
 * ffmpeg — pure layout/string-building. Caller splices `filterParts` into
 * its filter_complex.
 */
export async function buildSnapCaptionFilter(
  opts: SnapCaptionInput,
): Promise<SnapCaptionResult> {
  const requestedFontSize = opts.fontSize ?? 48;
  const positionPct = opts.positionPct ?? 30;
  const bandAlpha = opts.bandAlpha ?? 0.55;
  const emojiPad = opts.emojiPad ?? 8;
  const sideMargin = opts.sideMargin ?? 40;
  const minFontSize = opts.minFontSize ?? 28;
  const startIdx = opts.startIdx ?? 0;

  const runs = splitRuns(opts.text);
  const font = await getInterFont();

  // Auto-shrink so the composition fits inside frameW - 2*sideMargin.
  const availableW = opts.frameW - 2 * sideMargin;
  let fontSize = requestedFontSize;
  let widths: number[] = [];
  let totalW = 0;
  let emojiSize = 0;
  while (fontSize >= minFontSize) {
    emojiSize = fontSize + 4;
    widths = runs.map((r) =>
      r.kind === "text"
        ? Math.round(font.getAdvanceWidth(r.text, fontSize))
        : emojiSize + emojiPad
    );
    totalW = widths.reduce((s, w) => s + w, 0);
    if (totalW <= availableW) break;
    fontSize -= 2;
  }
  if (fontSize < minFontSize) {
    fontSize = minFontSize;
    emojiSize = fontSize + 4;
    widths = runs.map((r) =>
      r.kind === "text"
        ? Math.round(font.getAdvanceWidth(r.text, fontSize))
        : emojiSize + emojiPad
    );
    totalW = widths.reduce((s, w) => s + w, 0);
  }

  // Absolute x positions, centered as a group inside the band.
  const startX = Math.round((opts.frameW - totalW) / 2);
  const positions: number[] = [];
  let cursorX = startX;
  for (const w of widths) {
    positions.push(cursorX);
    cursorX += w;
  }

  // Band geometry — same logic as the existing snap preset.
  const estTextH = Math.round(fontSize * 1.18);
  const padV = Math.max(6, Math.round(fontSize * 0.30));
  const bandH = estTextH + 2 * padV;
  // positionPct convention: 0 = bottom, 100 = top. Convert to a top-down y.
  const bandCenterY = Math.round(opts.frameH * (1 - positionPct / 100));
  const bandY = bandCenterY - Math.round(bandH / 2);

  // Build filter parts.
  const filterParts: string[] = [];
  let idx = startIdx;
  let current = opts.inputVideoLabel;

  // 1) Band — full-width drawbox, time-gated to the hook window.
  const bandLabel = `snap_v${idx++}`;
  filterParts.push(
    `[${current}]drawbox=enable='${opts.enableExpr}':x=0:y=${bandY}:w=iw:h=${bandH}:color=black@${bandAlpha}:t=fill[${bandLabel}]`,
  );
  current = bandLabel;

  // 2) Per-run filters.
  const emojiCodepoints: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const x = positions[i];
    if (r.kind === "text") {
      const safe = escapeDrawtextValue(r.text);
      if (!safe) continue;
      const yExpr = `${bandCenterY}-text_h/2`;
      const out = `snap_v${idx++}`;
      filterParts.push(
        `[${current}]drawtext=enable='${opts.enableExpr}':fontfile={{in_font_snap}}:text=${safe}:fontsize=${fontSize}:fontcolor=white:x=${x}:y=${yExpr}:borderw=0[${out}]`,
      );
      current = out;
    } else {
      emojiCodepoints.push(r.codepoint);
      const emojiInputIdx = opts.emojiInputIndex(r.codepoint);
      const scaled = `snap_e${idx++}`;
      filterParts.push(
        `[${emojiInputIdx}:v]scale=${emojiSize}:${emojiSize}:flags=lanczos,format=rgba[${scaled}]`,
      );
      const out = `snap_v${idx++}`;
      const emojiY = bandCenterY - Math.round(emojiSize / 2);
      filterParts.push(
        `[${current}][${scaled}]overlay=enable='${opts.enableExpr}':x=${x + Math.floor(emojiPad / 2)}:y=${emojiY}[${out}]`,
      );
      current = out;
    }
  }

  return {
    filterParts,
    outputVideoLabel: current,
    emojiCodepoints,
    fontSize,
    bandY,
    bandH,
  };
}
