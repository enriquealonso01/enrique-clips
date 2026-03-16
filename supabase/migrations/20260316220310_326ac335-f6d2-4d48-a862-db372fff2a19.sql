
UPDATE projects
SET prompt_config_json = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        prompt_config_json,
        '{global,rules}',
        (prompt_config_json->'global'->'rules') || '["Every frame of every scene must show active visible labor: workers hauling, lifting, chiseling, hammering, stacking, or moving materials. There must never be a moment where the construction site appears idle or static.", "Construction machinery and workforce appropriate to the era must always be visibly in motion: carts rolling, cranes turning, ropes pulling, scaffolds being climbed, animals hauling loads. The site must feel alive with coordinated activity at all times.", "Between any two consecutive frames, there must be obvious measurable structural change: new wall sections risen, new scaffold levels added, new materials deposited, new architectural elements placed. Stagnant or near-duplicate frames are never acceptable."]'::jsonb
      ),
      '{motion,motion_rules}',
      (prompt_config_json->'motion'->'motion_rules') || '["Every clip must show constant bustling construction activity with dozens of workers, animals, or machines visibly in motion throughout the entire duration. The site must never appear quiet, empty, or paused.", "Construction progress must be dramatically visible within each individual clip: walls must grow higher, scaffolding must spread, materials must accumulate, structures must visibly advance. No clip should end looking nearly the same as it started.", "Workers and crews must be performing diverse simultaneous tasks across the site: some hauling, some building, some scaffolding, some finishing. The construction must feel like a coordinated large-scale operation with many moving parts at once.", "Avoid any period of low activity or calm. Even transition moments must show material transport, site preparation, or active labor. The energy level must remain high and the pace must feel relentless throughout every second of footage."]'::jsonb
    ),
    '{planning,viral_pacing_rules}',
    (prompt_config_json->'planning'->'viral_pacing_rules') || '["No scene may depict a calm, quiet, or low-activity construction site. Every scene must be packed with visible workers, movement, material flow, and obvious structural advancement happening simultaneously across the entire site.", "The construction must feel relentless and fast-paced. Between every pair of consecutive scenes, the structural difference must be dramatic and unmistakable, as if weeks or months of intense labor occurred."]'::jsonb
  ),
  '{planning,scene_progression_rules}',
  (prompt_config_json->'planning'->'scene_progression_rules') || '["Every scene transition must show massive structural change. If the previous scene showed foundations, the next must show walls clearly risen. If walls were rising, the next must show significant vertical progress or new architectural elements. Incremental near-duplicate progress is not acceptable."]'::jsonb
)
WHERE id = '0cf531fe-c4b5-49b3-a6fe-5e82e7240f4e';
