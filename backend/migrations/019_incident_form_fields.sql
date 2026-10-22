-- Incident form (ServiceNow-style layout): extra optional fields captured when raising a ticket.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS channel TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS impact TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS urgency TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS service TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS service_offering TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS configuration_item TEXT;
