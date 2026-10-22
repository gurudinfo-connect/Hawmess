-- Employee reactions to tasks (and direct lead status changes) are recorded so the admin dashboard can show them.
CREATE TABLE IF NOT EXISTS task_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('assigned','status_change','note')),
  status TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_updates_task ON task_updates(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_updates_company ON task_updates(company_id, created_at DESC);

-- lead_updates gets a 'status_change' type (employee moved the lead's status / edited notes without logging a response)
ALTER TABLE lead_updates DROP CONSTRAINT IF EXISTS lead_updates_type_check;
ALTER TABLE lead_updates ADD CONSTRAINT lead_updates_type_check CHECK (type IN ('assigned','accepted','declined','follow_up','response','status_change'));
