-- Attribute comments to their author so shared projects (owner + assignees all
-- commenting) show who said what, and so authors can delete their own comments.
-- Nullable: pre-existing comments have no recorded author, and deleting a user
-- nulls the column rather than removing their comments.
ALTER TABLE comments ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id);
