-- Rebrand Hawmess -> Barid-IN (company name and the footer shown on quotations and invoices).
-- Only values that still carry the old brand are touched, so anything an admin edited is left alone. Login emails are not changed.
UPDATE companies SET name = 'Barid-IN' WHERE name = 'Hawmess';
UPDATE companies SET legal_name = 'Barid-IN' WHERE legal_name = 'Hawmess';
UPDATE companies SET invoice_footer = 'Thank you for your business — Barid-IN' WHERE invoice_footer = 'Thank you for your business — Hawmess';
