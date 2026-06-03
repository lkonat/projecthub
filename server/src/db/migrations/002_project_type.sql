ALTER TABLE projects ADD COLUMN type TEXT;
CREATE INDEX IF NOT EXISTS idx_projects_type ON projects(type);
