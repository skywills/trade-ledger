-- Earlier releases retained the rejection decision ID on its run. Recover the
-- pending cards that existed at rejection time, preserving accepted and later cards.
WITH rejected_runs AS (
  SELECT r.id, MAX(d.created_at) AS rejected_at
  FROM ai_runs r, json_each(r.decision_references_json) ref
  JOIN decisions d ON d.id = ref.value AND d.kind = 'rejection'
  GROUP BY r.id
),
recovered AS (
  SELECT r.id, json_group_array(json(
    CASE WHEN json_extract(card.value, '$.accepted') = 0
      AND json_extract(card.value, '$.submittedAt') <= rr.rejected_at
      THEN json_set(card.value, '$.rejected', json('true')) ELSE card.value END
  ) ORDER BY card.key) AS cards
  FROM ai_runs r JOIN rejected_runs rr ON rr.id = r.id,
       json_each(r.proposal_json, '$.proposals') card
  GROUP BY r.id
)
UPDATE ai_runs AS r SET
  proposal_json = json_set(r.proposal_json, '$.proposals', json(recovered.cards)),
  status = CASE
    WHEN EXISTS (SELECT 1 FROM json_each(recovered.cards) p WHERE NOT json_extract(p.value, '$.accepted') AND NOT coalesce(json_extract(p.value, '$.rejected'), 0)) THEN r.status
    WHEN NOT EXISTS (SELECT 1 FROM json_each(recovered.cards) p WHERE json_extract(p.value, '$.rejected')) THEN r.status
    WHEN EXISTS (SELECT 1 FROM json_each(recovered.cards) p WHERE json_extract(p.value, '$.accepted')) THEN 'reviewed'
    ELSE 'rejected' END
FROM recovered WHERE recovered.id = r.id;
