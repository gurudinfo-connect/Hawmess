-- Lead workflow for employees: assigned -> accepted -> follow-ups / responses (forwarded to admin) -> converted / lost.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS employee_assigned_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS employee_accepted_at TIMESTAMPTZ;
-- leads already assigned before this migration: treat the assignment time as the lead's last update
UPDATE leads SET employee_assigned_at = updated_at WHERE employee_id IS NOT NULL AND employee_assigned_at IS NULL;

CREATE TABLE IF NOT EXISTS lead_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('assigned','accepted','declined','follow_up','response')),
  response TEXT CHECK (response IN ('interested','wants_quotation','call_back_later','no_response','not_interested')),
  note TEXT,
  next_follow_up_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_updates_lead ON lead_updates(lead_id, created_at DESC);
