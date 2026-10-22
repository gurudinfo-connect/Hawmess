-- Rebrand: New Starts / Howmess -> Hawmess (company name, website and invoice footer shown on quotations and invoices).
-- Only values that still carry an old brand are touched, so anything an admin edited is left alone.
UPDATE companies SET name = 'Hawmess' WHERE name IN ('New Starts', 'Howmess');
UPDATE companies SET legal_name = 'Hawmess' WHERE legal_name IN ('New Starts', 'Howmess');
UPDATE companies SET website = 'www.hawmess.com' WHERE website ILIKE '%newstarts%' OR website ILIKE '%howmess%';
UPDATE companies SET invoice_footer = 'Thank you for your business — Hawmess' WHERE invoice_footer IN ('Thank you for your business — New Starts', 'Thank you for your business — Howmess');
-- demo logins created by the seed script
UPDATE users SET email = regexp_replace(email, '@(newstarts|howmess)\.local$', '@hawmess.local') WHERE email ~ '@(newstarts|howmess)\.local$'
  AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.email = regexp_replace(users.email, '@(newstarts|howmess)\.local$', '@hawmess.local'));
UPDATE users SET email = 'admin@hawmess.com' WHERE email IN ('admin@mopuribusiness.com', 'admin@howmess.com')
  AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.email = 'admin@hawmess.com');
