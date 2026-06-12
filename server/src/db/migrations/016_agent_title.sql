-- Agents: a human-friendly `title`, and dropping the redundant `name`.
--
-- An agent's UNIQUE name is its `slug` (the registry name, e.g. 'cancel-impact')
-- — already UNIQUE here and enforced by the in-memory registry, so no two agents
-- can share a name. The old `name` column was just a copy of `slug`; replace it
-- with `title`, a free-form display label (e.g. 'Cancel Impact Analyst') shown in
-- the UI and used as the default assignee label.

ALTER TABLE agents ADD COLUMN title TEXT;

-- Seed the title from the old name so existing rows keep a label.
UPDATE agents SET title = name WHERE title IS NULL;

-- The redundant column is gone; `slug` remains the unique identifier.
ALTER TABLE agents DROP COLUMN name;
