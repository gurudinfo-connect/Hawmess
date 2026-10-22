-- Every task gets an auto-generated, human-friendly number (shown as TSK-00001), same approach as leads (LD-00001).
-- BIGSERIAL back-fills existing tasks automatically and numbers every new task atomically.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_seq ON tasks(seq);
CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by);
