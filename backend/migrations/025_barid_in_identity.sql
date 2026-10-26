-- Barid-IN identity: login emails / company contact details move from the old Hawmess domain, and ticket reference IDs use the BI- prefix.
-- Only values that still carry the old brand are touched, and an email is only renamed when the new address is free.
UPDATE users SET email = regexp_replace(email, '@hawmess\.(com|local)$', '@barid-in.com')
 WHERE email ~ '@hawmess\.(com|local)$'
   AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.email = regexp_replace(users.email, '@hawmess\.(com|local)$', '@barid-in.com'));
UPDATE companies SET email = regexp_replace(email, '@hawmess\.(com|local)$', '@barid-in.com') WHERE email ~ '@hawmess\.(com|local)$';
UPDATE companies SET website = 'www.barid-in.com' WHERE website = 'www.hawmess.com';

-- Ticket IDs: HW-T16ID24 -> BI-T16ID24 (same digits, so the mapping is one-to-one and stays unique).
UPDATE tickets SET ticket_no = 'BI-' || substr(ticket_no, 4) WHERE ticket_no LIKE 'HW-%';
CREATE OR REPLACE FUNCTION gen_ticket_no() RETURNS TEXT AS $$
DECLARE v TEXT; i INT := 0;
BEGIN
  LOOP
    i := i + 1;
    v := 'BI-T' || lpad(floor(random() * 100)::int::text, 2, '0') || 'ID'
         || CASE WHEN i <= 30 THEN lpad(floor(random() * 100)::int::text, 2, '0')
                 ELSE lpad(floor(random() * 10000)::int::text, 4, '0') END;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM tickets WHERE ticket_no = v);
  END LOOP;
  RETURN v;
END $$ LANGUAGE plpgsql VOLATILE;
