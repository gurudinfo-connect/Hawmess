-- Quotations (pre-sales documents). They never touch the ledger: only the invoice
-- created from an accepted quotation posts a journal entry.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS quotation_terms TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS quotation_footer TEXT;

-- Per-service template text (one item per line) used to pre-fill a quotation.
ALTER TABLE services ADD COLUMN IF NOT EXISTS quote_includes TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS quote_documents TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS quote_timeline TEXT;

CREATE TABLE quotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  customer_id UUID NOT NULL REFERENCES customers(id),
  quote_date DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until DATE NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','rejected','cancelled','invoiced')),
  tax_inclusive BOOLEAN NOT NULL DEFAULT true,
  untaxed_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL DEFAULT 0,
  notes TEXT,
  includes TEXT,          -- "Package includes" (one per line)
  documents TEXT,         -- "Documents required" (one per line)
  timelines TEXT,         -- "Estimated timelines" (one per line)
  terms TEXT,             -- "Terms & conditions" (one per line)
  prepared_by TEXT,
  prepared_title TEXT,
  prepared_contact TEXT,
  approved_by TEXT,
  approved_title TEXT,
  approved_contact TEXT,
  invoice_id UUID REFERENCES invoices(id),
  fiscal_year_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id),
  UNIQUE (company_id, number)
);

CREATE TABLE quotation_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id),
  description TEXT NOT NULL,   -- bold item title
  detail TEXT,                 -- grey sub-line under the title
  quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
  unit_price NUMERIC(18,2) NOT NULL DEFAULT 0,
  discount_percent NUMERIC(6,2) NOT NULL DEFAULT 0,  -- 100 = shown as FREE
  tax_id UUID REFERENCES taxes(id),
  line_gross NUMERIC(18,2) NOT NULL DEFAULT 0,       -- qty x unit price, before discount
  line_subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  line_tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_quotations_company ON quotations(company_id);
CREATE INDEX idx_quotations_customer ON quotations(customer_id);
CREATE INDEX idx_quotations_status ON quotations(status);

-- Grant the new permissions to existing roles (fresh installs get them from the seed too).
UPDATE roles SET permissions = permissions || '["quotations.view","quotations.create","quotations.edit","quotations.send","quotations.convert"]'::jsonb
  WHERE name IN ('accountant','manager','sales') AND NOT (permissions ? 'quotations.view');
UPDATE roles SET permissions = permissions || '["quotations.view"]'::jsonb
  WHERE name = 'viewer' AND NOT (permissions ? 'quotations.view');

-- Company letterhead details.
UPDATE companies SET
  address = '1st Floor, 873, 28th Main Rd, Corporation Colony, Jayanagara 9th Block, Jayanagar',
  city = 'Bengaluru', state = 'Karnataka', pincode = '560069',
  website = 'www.hawmess.com'
WHERE name = 'Hawmess';

UPDATE companies SET quotation_terms = E'This quotation is an estimate and is valid for the validity period stated above from the date of issue.\nTimelines and approvals for any government process are decided solely by the respective authorities and are not within our control.\nPrices are subject to revision for requirements or scope not covered in this quotation.\nTaxes are applied as per prevailing rates. All payments are non-refundable once the corresponding work has commenced.\nAll disputes are subject to the jurisdiction of courts in Bengaluru, Karnataka.'
WHERE quotation_terms IS NULL;
