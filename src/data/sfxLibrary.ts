// Curated royalty-free sound-effect library for opening-hook audio experiments.
//
// Source: Mixkit (https://mixkit.co) under the Mixkit Free License — free for
// commercial use, no attribution required. This license profile is intentional:
// trending pop audio from outside a licensed collection can trigger copyright
// claims that strip Facebook Reels monetization, so every clip here is royalty-free.
//
// Files live in Cloudflare R2 under the "sfx/" prefix (NOT Supabase Storage);
// mediaUrl() in src/lib/media.ts resolves each r2Key to a public URL.
//
// Each group maps to the channel + hook role it was picked for — see the audio-hook
// recommendations (whoosh = reveal, soil-thud = SBB first dig, water-wet = Pool
// Rescue restoration, typewriter = ManCave hook text, counter-tick = Dream Backyard
// day counter, etc.). The numeric id is the Mixkit source id (also the filename suffix).

export interface SfxItem {
  /** Mixkit source id (also the filename suffix) */
  id: string;
  /** Human-readable label (Mixkit title) */
  label: string;
  /** R2 object key — resolve to a public URL with mediaUrl() */
  r2Key: string;
}

export interface SfxGroup {
  slug: string;
  title: string;
  /** Channel(s) this group is intended for */
  channel: string;
  /** The hook role it plays */
  role: string;
  items: SfxItem[];
}

const item = (slug: string, id: string, label: string): SfxItem => ({
  id,
  label,
  r2Key: `sfx/${slug}/${slug}-${id}.mp3`,
});

export const SFX_LIBRARY: SfxGroup[] = [
  {
    slug: "whoosh-reveal",
    title: "Whoosh / reveal transition",
    channel: "ManCave Pro · general",
    role: "Reveal/transition accent — e.g. the secret panel swinging open",
    items: [
      item("whoosh-reveal", "1489", "Air whoosh"),
      item("whoosh-reveal", "1490", "Fast whoosh transition"),
      item("whoosh-reveal", "1492", "Cinematic whoosh fast transition"),
      item("whoosh-reveal", "1474", "Transition windy swoosh"),
      item("whoosh-reveal", "3115", "Fast transitions swoosh"),
    ],
  },
  {
    slug: "impact-hit",
    title: "Impact / hit",
    channel: "general · all channels",
    role: "Punctuate the reveal moment (lands on the first frame, never after)",
    items: [
      item("impact-hit", "788", "Big cinematic impact"),
      item("impact-hit", "1143", "Cinematic whoosh deep impact"),
      item("impact-hit", "784", "Reverse cinematic impact trailer"),
      item("impact-hit", "2908", "Movie trailer epic impact"),
      item("impact-hit", "2150", "Impact of a blow"),
    ],
  },
  {
    slug: "riser-swell",
    title: "Riser / swell",
    channel: "general",
    role: "Build anticipation into the reveal (tonal, keyed — not a generic whoosh)",
    items: [
      item("riser-swell", "678", "Trailer cinematic suspense swell"),
      item("riser-swell", "2671", "Mysterious long swell"),
      item("riser-swell", "794", "Tech choir cinematic riser"),
      item("riser-swell", "2674", "Heavenly swell"),
      item("riser-swell", "682", "Cinematic deep drums suspense swell"),
    ],
  },
  {
    slug: "soil-thud",
    title: "Soil / earth thud",
    channel: "Secret Backyard Builds",
    role: "Frame-1 weight on the first dig — earthy, never a synthetic braam",
    items: [
      item("soil-thud", "756", "Falling hit on gravel"),
      item("soil-thud", "2498", "Body impact falling into the sand"),
      item("soil-thud", "2182", "Wood hard hit"),
      item("soil-thud", "757", "Falling hit"),
      item("soil-thud", "751", "Falling on tree leaves"),
    ],
  },
  {
    slug: "typewriter-key",
    title: "Typewriter / keystroke",
    channel: "ManCave Pro",
    role: "Hook-text 'stamp' or type-on accent (fits ManCave's phone-POV intro)",
    items: [
      item("typewriter-key", "1386", "Keyboard typing"),
      item("typewriter-key", "1125", "Typewriter soft click"),
      item("typewriter-key", "1119", "Hard typewriter click"),
      item("typewriter-key", "1382", "Mechanical typewriter single hit"),
      item("typewriter-key", "1368", "Typewriter return bell"),
    ],
  },
  {
    slug: "latch-lock",
    title: "Latch / lock / panel",
    channel: "ManCave Pro",
    role: "Secret-entrance click + panel open (the curiosity-payoff sound)",
    items: [
      item("latch-lock", "2849", "Shut and lock"),
      item("latch-lock", "187", "Old medieval door lock"),
      item("latch-lock", "2854", "Quick lock sound"),
      item("latch-lock", "195", "Creaky door open"),
      item("latch-lock", "1523", "Heavy sliding door"),
    ],
  },
  {
    slug: "counter-tick",
    title: "Counter tick / ding",
    channel: "Dream Backyard Daily",
    role: "Day-counter tick/stamp synced to the 'Day X' number appearing",
    items: [
      item("counter-tick", "1061", "Clock ticker single"),
      item("counter-tick", "1059", "Tick tock clock close up"),
      item("counter-tick", "1056", "Ticking timer"),
      item("counter-tick", "235", "Explainer video game reveal"),
      item("counter-tick", "938", "Uplifting bells notification"),
    ],
  },
  {
    slug: "water-wet",
    title: "Water / wet / spray",
    channel: "Pool Rescue Lab",
    role: "Restoration money-sound: splash / pour / running water / wet scoop",
    items: [
      item("water-wet", "1311", "Water splash"),
      item("water-wet", "2826", "Pouring water in a glass"),
      item("water-wet", "1323", "Running water"),
      item("water-wet", "1264", "Rain splashing"),
      item("water-wet", "1883", "Soap dispenser press squish"),
    ],
  },
  {
    slug: "dig-build",
    title: "Dig / groundwork / build",
    channel: "Secret Backyard Builds",
    role: "Digging + build sounds (debris, hammer, wood, saw)",
    items: [
      item("dig-build", "400", "Stones and rocks falling"),
      item("dig-build", "830", "Hammer hit on wood"),
      item("dig-build", "388", "Falling bricks"),
      item("dig-build", "3141", "Small wood plank pile drop"),
      item("dig-build", "827", "Hand saw tool on wood"),
    ],
  },
];
