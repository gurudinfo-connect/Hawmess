-- Itemised quotation lines per package now live inside services.packages[].items (JSONB), so no new column is needed.
-- This migration only records the change; the items themselves are filled by the idempotent seed (seedQuoteItems).
SELECT 1;
