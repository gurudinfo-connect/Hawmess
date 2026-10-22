-- Company branding shown on quotations and invoices: Hawmess.
-- Idempotent: only fills values that are still empty, so anything an admin edited is left alone.
UPDATE companies SET
  legal_name = COALESCE(legal_name, 'Hawmess'),
  website = COALESCE(website, 'www.hawmess.com'),
  invoice_footer = COALESCE(invoice_footer, 'Thank you for your business — Hawmess')
WHERE name = 'Hawmess';
