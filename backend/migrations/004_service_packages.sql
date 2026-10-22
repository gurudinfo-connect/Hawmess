-- Basic / Premium packages per service. Each package: {name, price, tagline, includes[]}.
-- A quotation line remembers which package it was quoted with.
ALTER TABLE services ADD COLUMN IF NOT EXISTS packages JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE quotation_lines ADD COLUMN IF NOT EXISTS package_name TEXT;
