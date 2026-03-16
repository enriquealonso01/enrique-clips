
UPDATE projects
SET prompt_config_json = jsonb_set(
  jsonb_set(
    prompt_config_json,
    '{planning,viral_pacing_rules}',
    (prompt_config_json->'planning'->'viral_pacing_rules') || '["Every 2 scenes, the camera angle must shift to a distinctly different perspective (e.g., from aerial wide to ground-level, from frontal to side angle, from distant overview to close detail). The same camera angle must never persist for more than 2 consecutive scenes.", "Camera angle transitions must be smooth and motivated: use slow pan, gradual tilt, or orbital drift to naturally arrive at the new perspective. No jarring jump-cuts or sudden teleportation between angles."]'::jsonb
  ),
  '{motion,camera_rules}',
  (prompt_config_json->'motion'->'camera_rules') || '["Every 2nd scene must introduce a new camera angle relative to the previous pair. Alternate between perspectives such as: elevated wide shot, mid-level three-quarter angle, ground-level looking up, close detail shot, or slow orbital sweep.", "When transitioning to a new camera angle, the camera movement within the clip must smoothly guide the viewer into the new perspective using gradual panning, tilting, or orbiting motions. The shift must feel cinematic and intentional, never abrupt."]'::jsonb
)
WHERE id = '0cf531fe-c4b5-49b3-a6fe-5e82e7240f4e';
