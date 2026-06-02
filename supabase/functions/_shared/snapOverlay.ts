// Snap-overlay PNG renderer (Deno / Supabase Edge).
//
// Produces a transparent PNG of an iOS-style Snapchat overlay pill — rounded
// translucent dark band + white Inter text + inline color emojis (Twemoji,
// Twitter's open MIT-licensed set, used because Apple Color Emoji is not
// licensed for redistribution). The PNG is composited onto the hook clip
// in finalize-video via ffmpeg's `overlay` filter — drawtext can't render
// color emojis, so we go through this PNG-overlay pipeline instead.
//
// Approach: build an SVG string with the pill + text + <image> tags for
// each emoji (Twemoji PNG bytes inlined as base64 data URIs so resvg never
// needs to fetch anything at render time), then rasterize via resvg-js.
//
// The renderer fetches Inter + the Twemoji PNGs from jsdelivr on first
// call and caches them in module state for subsequent renders in the same
// instance. If a Twemoji codepoint isn't recognized, it falls through as
// monochrome text (resvg's font fallback).

import { Resvg } from "https://esm.sh/@resvg/resvg-js@2.6.2";

// Twemoji codepoints we currently use across the live POV-hook variants.
// Adding new emojis to a variant requires adding their codepoint stem here.
// Codepoint → Twemoji 72x72 PNG path on jsdelivr.
const KNOWN_EMOJIS: Record<string, string> = {
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

const TWEMOJI_BASE = "https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/72x72";
const INTER_URL = "https://cdn.jsdelivr.net/npm/@fontsource/inter/files/inter-latin-400-normal.woff";

// Module-level caches — populated on first call, reused for the lifetime
// of the edge function container.
const emojiPngCache = new Map<string, string>(); // codepoint → base64 PNG
let interFontBytes: Uint8Array | null = null;

async function getEmojiDataUri(codepoint: string): Promise<string | null> {
  if (emojiPngCache.has(codepoint)) return emojiPngCache.get(codepoint)!;
  const resp = await fetch(`${TWEMOJI_BASE}/${codepoint}.png`);
  if (!resp.ok) return null;
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const b64 = btoa(String.fromCharCode(...bytes));
  const uri = `data:image/png;base64,${b64}`;
  emojiPngCache.set(codepoint, uri);
  return uri;
}

async function getInterFontBytes(): Promise<Uint8Array> {
  if (interFontBytes) return interFontBytes;
  const resp = await fetch(INTER_URL);
  if (!resp.ok) throw new Error(`Failed to fetch Inter font: ${resp.status}`);
  interFontBytes = new Uint8Array(await resp.arrayBuffer());
  return interFontBytes;
}

type Run =
  | { kind: "text"; text: string }
  | { kind: "emoji"; codepoint: string };

function splitRuns(text: string): Run[] {
  const runs: Run[] = [];
  let buf = "";
  // Iterating the string by code points (for...of) handles surrogate pairs.
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

function escapeSvgText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Width estimate for an Inter Regular glyph at the given font size.
// Inter's average advance is ~0.52 em for mixed lowercase, ~0.58 em for
// uppercase. We use 0.52 for general text (matches our Pillow spike).
function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.52;
}

export interface SnapRenderOpts {
  text: string;
  /** PNG nominal font size in pixels. Default 64. */
  fontSize?: number;
  /** Background opacity 0..1. Default 0.55. */
  bandAlpha?: number;
  /** Corner radius as a fraction of pill height. Default 0.30. */
  radiusFactor?: number;
  /** Horizontal padding inside the pill, as a fraction of fontSize. Default 0.55. */
  padHFactor?: number;
  /** Vertical padding inside the pill, as a fraction of fontSize. Default 0.32. */
  padVFactor?: number;
  /** Emoji size relative to text size. Default 1.05. */
  emojiScale?: number;
}

/**
 * Render the snap-overlay pill as a transparent PNG.
 * Returns the PNG bytes (Uint8Array) and the rasterized dimensions.
 */
export async function renderSnapPng(
  opts: SnapRenderOpts,
): Promise<{ png: Uint8Array; width: number; height: number }> {
  const fontSize = opts.fontSize ?? 64;
  const bandAlpha = opts.bandAlpha ?? 0.55;
  const radiusFactor = opts.radiusFactor ?? 0.30;
  const padHFactor = opts.padHFactor ?? 0.55;
  const padVFactor = opts.padVFactor ?? 0.32;
  const emojiScale = opts.emojiScale ?? 1.05;

  const runs = splitRuns(opts.text);
  const emojiSize = Math.round(fontSize * emojiScale);

  // Measure each run's width.
  const widths = runs.map((r) =>
    r.kind === "text" ? estimateTextWidth(r.text, fontSize) : emojiSize + 4
  );
  const contentW = widths.reduce((s, w) => s + w, 0);

  const textH = Math.round(fontSize * 1.18);
  const padH = Math.round(fontSize * padHFactor);
  const padV = Math.round(fontSize * padVFactor);
  const pillW = Math.round(contentW + 2 * padH);
  const pillH = Math.round(textH + 2 * padV);

  // Small transparent margin around the pill so the PNG doesn't clip the
  // shadow / rounded corners on composition.
  const margin = 12;
  const svgW = pillW + 2 * margin;
  const svgH = pillH + 2 * margin;
  const radius = Math.round(pillH * radiusFactor);

  // Pre-fetch all needed emoji data URIs in parallel.
  const emojiUris = await Promise.all(
    runs.map((r) => r.kind === "emoji" ? getEmojiDataUri(r.codepoint) : Promise.resolve(null)),
  );

  // Build SVG body.
  const parts: string[] = [];
  parts.push(
    `<rect x="${margin}" y="${margin}" width="${pillW}" height="${pillH}" rx="${radius}" ry="${radius}" fill="rgba(0,0,0,${bandAlpha})"/>`,
  );

  let cursorX = margin + padH;
  // Text baseline so the visible glyphs sit centered in the pill. Inter at
  // 1em font-size has roughly 0.78em ascent — y is the baseline.
  const baselineY = margin + padV + Math.round(textH * 0.78);
  const emojiY = margin + padV + Math.round((textH - emojiSize) / 2);

  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const w = widths[i];
    if (r.kind === "text") {
      const safe = escapeSvgText(r.text);
      parts.push(
        `<text x="${cursorX}" y="${baselineY}" font-family="Inter, sans-serif" font-size="${fontSize}" font-weight="400" fill="white" xml:space="preserve">${safe}</text>`,
      );
    } else {
      const uri = emojiUris[i];
      if (uri) {
        parts.push(
          `<image x="${cursorX + 2}" y="${emojiY}" width="${emojiSize}" height="${emojiSize}" href="${uri}"/>`,
        );
      }
    }
    cursorX += w;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">${parts.join("")}</svg>`;

  const fontBytes = await getInterFontBytes();
  const resvg = new Resvg(svg, {
    background: "rgba(0,0,0,0)",
    fitTo: { mode: "width", value: svgW },
    font: {
      fontBuffers: [fontBytes],
      loadSystemFonts: false,
      defaultFontFamily: "Inter",
    },
  });
  const pngData = resvg.render();
  const png = pngData.asPng();
  const { width, height } = pngData;
  pngData.free();
  resvg.free();
  return { png, width, height };
}
