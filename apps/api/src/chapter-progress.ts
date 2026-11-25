// Move progress to the same relative point in a replacement Chapter, or shift it by the
// duration delta if the listener is past that Chapter. Run this before publishing the new row,
// in the same D1 batch. A new Chapter never changes a waiting listener's position.
export const remapChapterProgress = `
  WITH old AS (
    SELECT c.duration_ms AS length,
      COALESCE((SELECT SUM(duration_ms) FROM chapters
                WHERE episode_id = c.episode_id AND idx < c.idx), 0) AS start
    FROM chapters c JOIN episodes e ON e.id = c.episode_id
    WHERE c.episode_id = ?1 AND c.idx = ?2 AND c.duration_ms <> ?3
      AND e.lease_hash = ?4 AND e.job_state = 'Running'
  ), moved AS (
    SELECT CASE
      WHEN p.position_ms >= old.start + old.length THEN p.position_ms + ?3 - old.length
      WHEN p.position_ms > old.start THEN old.start + ROUND((p.position_ms - old.start) * 1.0 * ?3 / old.length)
      ELSE p.position_ms END AS position
    FROM progress p CROSS JOIN old WHERE p.episode_id = ?1
  )
  UPDATE progress SET position_ms = (SELECT position FROM moved), updated_at = MAX(updated_at, ?5)
  WHERE episode_id = ?1 AND position_ms <> (SELECT position FROM moved)
`
