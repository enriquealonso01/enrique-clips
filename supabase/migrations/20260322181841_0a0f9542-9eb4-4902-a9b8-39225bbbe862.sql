UPDATE projects SET prompt_config_json = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        prompt_config_json::jsonb,
        '{keyframes,prompt_template}',
        to_jsonb('Generate a high-quality {aspect_ratio} photorealistic vertical image for this scene''s END frame. This is keyframe K{scene_index} of {total_scenes}.

=== PAIRED KEYFRAME SYSTEM ===
CRITICAL: Keyframes are generated in PAIRS. Each pair focuses on ONE specific section/area of the construction site.
- ODD keyframes (K1, K3, K5...): Show the section BEFORE major construction — scaffolding arriving, workers setting up, materials being delivered. The area is recognizable but unfinished for this phase.
- EVEN keyframes (K2, K4, K6...): Show the SAME section AFTER intensive construction — walls risen, arches completed, that section visibly transformed by labor.
- K3 shifts to a DIFFERENT section of the site from a NEW camera angle, showing it in its pre-work state.
- This creates a natural rhythm: arrive at area → watch it get built → move to next area → watch it get built.

=== CAMERA ANGLE ===
Each pair (K1-K2, K3-K4, K5-K6...) uses a UNIQUE camera vantage point DRAMATICALLY different from the previous pair. The transition between pairs must feel like a drone flying smoothly to a new position. Include visual continuity cues (same landmark silhouette, same horizon features, same weather/lighting) so the viewer understands the camera TRAVELED to the new angle.

Vantage points: (A) High aerial ~60 degrees (B) Ground-level ~15 degrees (C) Mid-height frontal ~30 degrees (D) Side/rear elevated ~45 degrees (E) Close structural detail (F) Distant panoramic overview

=== ANTI-SPLIT-SCREEN ===
ABSOLUTELY FORBIDDEN: divided frames, split screens, multi-panel layouts, before/after comparisons, stacked images, side-by-side views, triptychs, diptychs, collages, montages, film strips. The ENTIRE canvas must be ONE seamless photorealistic scene from ONE camera position. If the image contains any horizontal or vertical dividing lines creating separate panels, it is WRONG.

=== ALWAYS ACTIVE CONSTRUCTION ===
Every keyframe must show ACTIVE construction labor. Workers hauling stone, climbing scaffolds, operating cranes, chiseling, hammering, laying bricks, pulling ropes, driving carts. The site must feel alive. NEVER an idle or empty site.

=== GLOBAL CONCEPT ===
{concept_prompt}

=== STYLE BIBLE ===
{style_bible}

=== SCENE END FRAME GOAL ===
{end_keyframe_prompt}

=== COMPOSITION RULES ===
{composition_rules}

=== CONTINUITY RULES ===
{continuity_rules}

=== GLOBAL RULES ===
{global_rules}

SINGLE UNDIVIDED photorealistic image. ONE camera angle. Active construction labor throughout. No text, captions, logos, labels, or watermarks.'::text)
      ),
      '{keyframes,composition_rules}',
      '["The ENTIRE canvas must be ONE SINGLE CONTINUOUS SCENE — never divided, split, stacked, or showing multiple views.", "ABSOLUTELY FORBIDDEN: split screens, multi-panel layouts, before/after comparisons, stacked images, side-by-side views, triptychs, diptychs, collages, montages, film strips, or any composition dividing the frame into sections. Any horizontal or vertical line creating separate panels means the image is WRONG.", "Use a vertical 9:16 composition.", "CAMERA PAIR ROTATION: K1-K2 share one angle, K3-K4 a completely different angle, K5-K6 another. Within each pair the camera is IDENTICAL — only construction progress changes.", "Vantage points between pairs must be DRAMATICALLY different: high aerial, ground-level, mid-height frontal, side/rear elevated, close structural detail, distant panoramic.", "Between pairs the transition must feel like a drone smoothly traveling to the new position. Include recognizable anchor features confirming it is the same site.", "Workers, crews, carts, animals, scaffolds, cranes, ramps, and materials must be actively working in EVERY keyframe.", "The landmark should grow readably scene by scene despite changing camera angles.", "Show enough site context to communicate scale and place."]'::jsonb
    ),
    '{keyframes,continuity_rules}',
    '["Keep the same site, geography, terrain, and anchor features — the LOCATION never changes, only the camera ANGLE changes every 2 scenes.", "Between angle changes, include recognizable landmark features so the viewer understands the drone traveled to a new position rather than teleporting.", "No object may appear that was not present or under construction in the previous keyframe. New elements must emerge through visible labor, not magically.", "Preserve historical era consistency.", "Keep architecture faithful to the same real landmark throughout.", "Each keyframe must visibly evolve from the previous one in construction progress, even when the camera angle shifts.", "ODD keyframes show a section with early/preparatory work; EVEN keyframes show that same section significantly advanced — the paired before/after rhythm.", "Consecutive keyframes must never be near-duplicates.", "The completed landmark must be recognizable by the final keyframe.", "Active construction labor must be visible in EVERY keyframe without exception."]'::jsonb
  ),
  '{planning,scene_progression_rules}',
  '["Maintain strict historical and temporal continuity.", "PAIRED SCENE STRUCTURE: Plan scenes in pairs. Each pair focuses on a specific section or phase. Scene 1: workers arriving and beginning work on that section. Scene 2: same section significantly advanced. Scene 3: shift to a DIFFERENT section from a NEW camera angle.", "Do not skip to impossible build states without intermediate structural logic.", "All construction methods must remain faithful to the chosen years.", "Keep the same site and geography.", "Permanent anchor features must stay consistent.", "The structure must grow logically.", "Every scene transition must show massive structural change in the focused section.", "Every 2 scenes, the camera perspective shifts — the shift must feel like a drone traveling to the new position, smooth and motivated, not a jump-cut.", "The same camera perspective must never persist for more than 2 consecutive scenes.", "No new structural elements may appear without being shown under construction first.", "Every scene must show dozens of active workers — the site is never calm or idle."]'::jsonb
)
WHERE id = '0cf531fe-c4b5-49b3-a6fe-5e82e7240f4e';