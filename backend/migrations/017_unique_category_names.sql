-- Top-level category names must be unique per company (a NULL parent_id bypasses the table's UNIQUE constraint).
CREATE UNIQUE INDEX IF NOT EXISTS uq_category_toplevel_name ON ticket_categories (company_id, lower(name)) WHERE parent_id IS NULL;
