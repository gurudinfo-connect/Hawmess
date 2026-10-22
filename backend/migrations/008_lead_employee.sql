-- Leads can also be assigned (by an admin) to an employee, who then works the lead from "My Leads".
ALTER TABLE leads ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_leads_employee ON leads(employee_id);
