-- Role-based access control: roles (admin / employee / sales_person), ownership columns, leads, follow-ups, tasks, notes.
-- Roles live in the existing `roles` table (name = admin | employee | sales_person; legacy accountant/manager/viewer still work as full-access staff).

-- legacy 'sales' role becomes 'sales_person' (its users keep working; permissions are re-seeded)
UPDATE roles SET name = 'sales_person' WHERE name = 'sales' AND NOT EXISTS (SELECT 1 FROM roles WHERE name = 'sales_person');

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo TEXT;

-- ownership / assignment
ALTER TABLE customers ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS assigned_employee_id UUID REFERENCES users(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS assigned_salesperson_id UUID REFERENCES users(id);
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS created_by_role TEXT;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES users(id);
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS salesperson_id UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_customers_emp ON customers(assigned_employee_id);
CREATE INDEX IF NOT EXISTS idx_customers_sales ON customers(assigned_salesperson_id);
CREATE INDEX IF NOT EXISTS idx_quotations_emp ON quotations(employee_id);
CREATE INDEX IF NOT EXISTS idx_quotations_sales ON quotations(salesperson_id);
CREATE INDEX IF NOT EXISTS idx_quotations_created_by ON quotations(created_by);

-- audit log: who (role), which module, human-readable description
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS module TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS description TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  seq BIGSERIAL,
  name TEXT NOT NULL,
  company_name TEXT,
  phone TEXT,
  email TEXT,
  service_interested TEXT,
  source TEXT,
  expected_value NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','follow_up','quotation_sent','negotiation','converted','lost')),
  salesperson_id UUID REFERENCES users(id),
  created_by UUID REFERENCES users(id),
  follow_up_date DATE,
  notes TEXT,
  customer_id UUID REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_sales ON leads(salesperson_id);

CREATE TABLE IF NOT EXISTS follow_ups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id),           -- the salesperson who owns the follow-up
  customer_id UUID REFERENCES customers(id),
  lead_id UUID REFERENCES leads(id),
  follow_up_date DATE NOT NULL,
  follow_up_time TIME,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','rescheduled','cancelled')),
  next_follow_up_date DATE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_followups_owner ON follow_ups(owner_id, follow_up_date);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  customer_id UUID REFERENCES customers(id),
  description TEXT,
  assigned_to UUID REFERENCES users(id),
  created_by UUID REFERENCES users(id),
  assigned_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','cancelled')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assigned_to, status);

CREATE TABLE IF NOT EXISTS customer_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_notes_customer ON customer_notes(customer_id, created_at DESC);
