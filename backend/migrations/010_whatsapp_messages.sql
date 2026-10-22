-- Log of quotations sent to customers over WhatsApp (mirrors email_messages).
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  related_entity_type TEXT NOT NULL,
  related_entity_id UUID NOT NULL,
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  attachment_filename TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  provider TEXT,
  message_id TEXT,
  error_message TEXT,
  sent_by UUID REFERENCES users(id),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_messages_entity_idx ON whatsapp_messages(related_entity_type, related_entity_id);
