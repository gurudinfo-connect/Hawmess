-- Service master: professional item title / description shown on quotations, plus default quantity, free flag and GST flag.
-- The text itself is loaded by the idempotent seed from src/db/serviceMaster.ts (never overwrites admin edits).
ALTER TABLE services ADD COLUMN IF NOT EXISTS item_title TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS item_description TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS default_quantity NUMERIC(18,3) NOT NULL DEFAULT 1;
ALTER TABLE services ADD COLUMN IF NOT EXISTS is_free BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE services ADD COLUMN IF NOT EXISTS gst_applicable BOOLEAN NOT NULL DEFAULT true;
