-- MBS Accounting Schema (PostgreSQL)
-- All monetary values stored as NUMERIC(18,2). All accounting math is done server-side.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============ COMPANIES & USERS ============
CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  legal_name TEXT,
  gstin TEXT,
  pan TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  country TEXT DEFAULT 'India',
  pincode TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  currency TEXT NOT NULL DEFAULT 'INR',
  logo_url TEXT,
  bank_details TEXT,
  invoice_footer TEXT,
  default_terms TEXT,
  fiscal_year_start_month INT NOT NULL DEFAULT 4, -- April for India
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE, -- admin, accountant, manager, sales, viewer
  permissions JSONB NOT NULL DEFAULT '[]' -- array of permission strings
);

CREATE TABLE company_users (
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INT NOT NULL REFERENCES roles(id),
  PRIMARY KEY (company_id, user_id)
);

-- ============ FISCAL PERIODS ============
CREATE TABLE fiscal_years (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL, -- e.g. 26-27
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  lock_date DATE,
  tax_lock_date DATE,
  UNIQUE(company_id, code)
);

-- ============ CHART OF ACCOUNTS ============
CREATE TABLE account_types (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE, -- asset, liability, equity, income, expense
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit','credit'))
);

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type_id INT NOT NULL REFERENCES account_types(id),
  is_receivable BOOLEAN NOT NULL DEFAULT false,
  is_payable BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(company_id, code)
);

CREATE TABLE journals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL, -- sale, purchase, bank, cash, general
  default_debit_account_id UUID REFERENCES accounts(id),
  default_credit_account_id UUID REFERENCES accounts(id),
  UNIQUE(company_id, code)
);

CREATE TABLE journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  journal_id UUID NOT NULL REFERENCES journals(id),
  entry_date DATE NOT NULL,
  reference TEXT,
  narration TEXT,
  source_type TEXT, -- 'invoice','payment','credit_note','debit_note','bill','manual'
  source_id UUID,
  posted BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id)
);

CREATE TABLE journal_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id),
  partner_type TEXT, -- 'customer' | 'vendor' | null
  partner_id UUID,
  debit NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit NUMERIC(18,2) NOT NULL DEFAULT 0,
  description TEXT,
  reconciled BOOLEAN NOT NULL DEFAULT false,
  CHECK (debit >= 0 AND credit >= 0)
);

-- ============ TAXES ============
CREATE TABLE tax_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL -- e.g. "GST 5%"
);

CREATE TABLE taxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tax_group_id UUID REFERENCES tax_groups(id),
  name TEXT NOT NULL, -- "GST 5% S" (sale) / "GST 5% P" (purchase)
  rate NUMERIC(6,3) NOT NULL, -- total rate e.g 5.000
  scope TEXT NOT NULL CHECK (scope IN ('sale','purchase')),
  split_type TEXT NOT NULL DEFAULT 'intra' CHECK (split_type IN ('intra','inter')), -- intra=CGST+SGST, inter=IGST
  price_included BOOLEAN NOT NULL DEFAULT false,
  cgst_account_id UUID REFERENCES accounts(id),
  sgst_account_id UUID REFERENCES accounts(id),
  igst_account_id UUID REFERENCES accounts(id),
  is_active BOOLEAN NOT NULL DEFAULT true
);

-- ============ PAYMENT TERMS ============
CREATE TABLE payment_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL, -- "15 Days"
  days INT NOT NULL DEFAULT 0
);

-- ============ INVOICE SEQUENCES ============
CREATE TABLE invoice_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL, -- INV, QT, PAY, CN, DN, BILL, SELF
  fiscal_year_code TEXT NOT NULL,
  prefix TEXT NOT NULL,
  next_number INT NOT NULL DEFAULT 1,
  padding INT NOT NULL DEFAULT 4,
  UNIQUE(company_id, doc_type, fiscal_year_code)
);

-- ============ SERVICE CATALOG ============
CREATE TABLE service_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);

CREATE TABLE services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category_id UUID REFERENCES service_categories(id),
  code TEXT,
  name TEXT NOT NULL,
  description TEXT,
  sac_hsn TEXT,
  default_price NUMERIC(18,2) NOT NULL DEFAULT 0,
  default_tax_id UUID REFERENCES taxes(id),
  unit TEXT NOT NULL DEFAULT 'unit',
  income_account_id UUID REFERENCES accounts(id),
  purchase_account_id UUID REFERENCES accounts(id),
  default_invoice_description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ CUSTOMERS & VENDORS ============
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  company_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  country TEXT DEFAULT 'India',
  pincode TEXT,
  gstin TEXT,
  pan TEXT,
  customer_type TEXT DEFAULT 'individual',
  payment_term_id UUID REFERENCES payment_terms(id),
  currency TEXT NOT NULL DEFAULT 'INR',
  receivable_account_id UUID REFERENCES accounts(id),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  company_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  gstin TEXT,
  pan TEXT,
  payment_term_id UUID REFERENCES payment_terms(id),
  currency TEXT NOT NULL DEFAULT 'INR',
  payable_account_id UUID REFERENCES accounts(id),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ INVOICES ============
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number TEXT, -- assigned on post
  customer_id UUID NOT NULL REFERENCES customers(id),
  invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE,
  payment_term_id UUID REFERENCES payment_terms(id),
  reference TEXT,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','partially_paid','in_payment','paid','overdue','cancelled')),
  untaxed_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(18,2) NOT NULL DEFAULT 0,
  amount_due NUMERIC(18,2) NOT NULL DEFAULT 0,
  notes TEXT,
  terms TEXT,
  journal_entry_id UUID REFERENCES journal_entries(id),
  fiscal_year_code TEXT,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id)
);

CREATE TABLE invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id),
  account_id UUID REFERENCES accounts(id),
  description TEXT NOT NULL,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
  unit_price NUMERIC(18,2) NOT NULL DEFAULT 0,
  discount_percent NUMERIC(6,2) NOT NULL DEFAULT 0,
  tax_id UUID REFERENCES taxes(id),
  line_subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  line_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0
);

-- ============ VENDOR BILLS ============
CREATE TABLE vendor_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number TEXT,
  vendor_id UUID NOT NULL REFERENCES vendors(id),
  bill_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE,
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','partially_paid','paid','overdue','cancelled')),
  untaxed_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(18,2) NOT NULL DEFAULT 0,
  amount_due NUMERIC(18,2) NOT NULL DEFAULT 0,
  journal_entry_id UUID REFERENCES journal_entries(id),
  fiscal_year_code TEXT,
  attachment_document_id UUID,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vendor_bill_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id UUID NOT NULL REFERENCES vendor_bills(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id),
  account_id UUID REFERENCES accounts(id),
  description TEXT NOT NULL,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
  unit_price NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_id UUID REFERENCES taxes(id),
  line_subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  line_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(18,2) NOT NULL DEFAULT 0
);

-- ============ PAYMENTS ============
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  partner_type TEXT NOT NULL CHECK (partner_type IN ('customer','vendor')),
  partner_id UUID NOT NULL,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(18,2) NOT NULL,
  method TEXT NOT NULL DEFAULT 'bank', -- cash, bank, upi, cheque, card, online, other
  reference TEXT,
  notes TEXT,
  journal_entry_id UUID REFERENCES journal_entries(id),
  fiscal_year_code TEXT,
  is_reversed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES invoices(id),
  bill_id UUID REFERENCES vendor_bills(id),
  amount NUMERIC(18,2) NOT NULL
);

-- ============ CREDIT / DEBIT NOTES ============
CREATE TABLE credit_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number TEXT,
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  reason TEXT,
  note_date DATE NOT NULL DEFAULT CURRENT_DATE,
  untaxed_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
  journal_entry_id UUID REFERENCES journal_entries(id),
  fiscal_year_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE credit_note_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id UUID NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
  unit_price NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_id UUID REFERENCES taxes(id),
  line_subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  line_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(18,2) NOT NULL DEFAULT 0
);

CREATE TABLE debit_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number TEXT,
  party_type TEXT NOT NULL CHECK (party_type IN ('customer','vendor')),
  invoice_id UUID REFERENCES invoices(id),
  bill_id UUID REFERENCES vendor_bills(id),
  party_id UUID NOT NULL,
  reason TEXT,
  note_date DATE NOT NULL DEFAULT CURRENT_DATE,
  untaxed_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
  journal_entry_id UUID REFERENCES journal_entries(id),
  fiscal_year_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ DOCUMENTS ============
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  related_entity_type TEXT NOT NULL, -- 'customer','vendor','invoice','bill','payment'
  related_entity_id UUID NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INT,
  storage_path TEXT NOT NULL,
  uploaded_by UUID REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ EMAIL ============
CREATE TABLE email_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  related_entity_type TEXT NOT NULL, -- 'invoice','bill', etc
  related_entity_id UUID NOT NULL,
  to_email TEXT NOT NULL,
  cc_email TEXT,
  bcc_email TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  attachment_filename TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','failed','bounced')),
  provider TEXT,
  message_id TEXT,
  error_message TEXT,
  sent_by UUID REFERENCES users(id),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ AUDIT LOG (immutable) ============
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  user_id UUID REFERENCES users(id),
  action TEXT NOT NULL, -- 'create','update','post','pay','send_email','cancel', etc
  entity_type TEXT NOT NULL,
  entity_id UUID,
  old_value JSONB,
  new_value JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ NOTIFICATIONS ============
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  entity_type TEXT,
  entity_id UUID,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ INDEXES ============
CREATE INDEX idx_invoices_company ON invoices(company_id);
CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_number ON invoices(number);
CREATE INDEX idx_journal_items_account ON journal_items(account_id);
CREATE INDEX idx_journal_items_partner ON journal_items(partner_type, partner_id);
CREATE INDEX idx_journal_entries_company ON journal_entries(company_id);
CREATE INDEX idx_payments_partner ON payments(partner_type, partner_id);
CREATE INDEX idx_customers_company ON customers(company_id);
CREATE INDEX idx_vendors_company ON vendors(company_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
