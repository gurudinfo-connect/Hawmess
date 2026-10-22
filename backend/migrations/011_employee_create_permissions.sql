-- Employees can now create customers (auto-assigned to themselves), create draft invoices and convert their own quotations to invoices.
-- They can only ever see/touch their own records: scoping is enforced in the queries (lib/scope.ts), not by these strings.
-- Posting invoices, payments, credit notes and cancelling stay with admin / accounting roles.
-- Additive and idempotent: keeps whatever else is already on the role and adds only the missing permissions.
UPDATE roles r
SET permissions = (
  SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
  FROM jsonb_array_elements_text(r.permissions || '["customers.create","invoices.view","invoices.create","quotations.convert"]'::jsonb) AS t(p)
)
WHERE r.name = 'employee';
