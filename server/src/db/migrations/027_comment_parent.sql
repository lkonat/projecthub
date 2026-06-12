-- Threaded replies on project conversations. A reply is just a comment with a
-- parent_id pointing at the comment it answers; top-level comments have NULL.
-- ON DELETE CASCADE so deleting a comment removes its replies along with it.
ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
