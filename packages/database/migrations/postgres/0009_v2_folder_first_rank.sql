-- Folder-first default ordering for v2 sibling groups.
--
-- Migration 0006 copies legacy Project ranks onto folders and leaves Task ranks
-- untouched, so backfilled siblings can interleave a Task above a Folder of the
-- same status. Section 7.2 of the v2 spec requires that a freshly migrated
-- parent shows its Folders before its root Tasks, while still leaving rank as
-- the sole basis for user-driven manual ordering.
--
-- This migration renumbers each active sibling group so that every Folder gets
-- a lower rank than every Task under the same parent. Status is the primary
-- sort key, so within any status group this yields Folder-first ordering
-- without preventing the user from later dragging a Task above a Folder.
--
-- Relative order inside each kind is preserved so no user intent is lost, and
-- deleted rows are left alone (they are not rendered in the tree).
WITH ranked AS (
  SELECT
    f.id,
    f.owner_id,
    f.parent_folder_id,
    row_number() OVER (
      PARTITION BY f.owner_id, f.parent_folder_id
      ORDER BY f.rank, f.id
    ) AS position
  FROM folders AS f
  WHERE f.deleted_at IS NULL
)
UPDATE folders AS f
SET rank = ranked.position * 1024
FROM ranked
WHERE f.id = ranked.id
  AND f.rank <> ranked.position * 1024;

-- Place every active Task after the last Folder of the same parent, keeping the
-- existing Task order. Parents with no Folder start Tasks at 1024.
WITH folder_ceiling AS (
  SELECT owner_id, parent_folder_id, MAX(rank) AS max_rank
  FROM folders
  WHERE deleted_at IS NULL
  GROUP BY owner_id, parent_folder_id
),
ranked AS (
  SELECT
    t.id,
    COALESCE(c.max_rank, 0) + row_number() OVER (
      PARTITION BY t.owner_id, t.parent_folder_id
      ORDER BY t.rank, t.id
    ) * 1024 AS next_rank
  FROM tasks AS t
  LEFT JOIN folder_ceiling AS c
    ON c.owner_id = t.owner_id
   AND c.parent_folder_id IS NOT DISTINCT FROM t.parent_folder_id
  WHERE t.deleted_at IS NULL
)
UPDATE tasks AS t
SET rank = ranked.next_rank
FROM ranked
WHERE t.id = ranked.id
  AND t.rank <> ranked.next_rank;
