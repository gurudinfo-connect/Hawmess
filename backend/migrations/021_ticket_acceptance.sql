-- Assignee acceptance + progress updates.
-- acceptance: NULL = not required (assignee is admin/HR or ticket unassigned), 'pending' = waiting for the employee, 'accepted', 'declined' (employee refused; ticket is back in the queue).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS acceptance TEXT CHECK (acceptance IN ('pending','accepted','declined'));
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS acceptance_note TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS progress INT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100);
CREATE INDEX IF NOT EXISTS idx_tickets_acceptance ON tickets(company_id, acceptance);

-- Every assignee action on a ticket (assigned / accepted / declined / reassigned / progress) so the admin can follow it.
-- The ticket keeps the same id and ticket_no for its whole life, whoever is working on it.
CREATE TABLE IF NOT EXISTS ticket_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,      -- who did it
  to_user_id UUID REFERENCES users(id) ON DELETE SET NULL,   -- for assigned / reassigned: the new assignee
  type TEXT NOT NULL CHECK (type IN ('assigned','accepted','declined','reassigned','progress')),
  note TEXT, progress INT, status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ticket_updates ON ticket_updates(ticket_id, created_at);
