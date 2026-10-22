-- Navbar: Favorites (starred tickets) and Workspace (tickets I am involved in, incl. tickets I watch).
CREATE TABLE IF NOT EXISTS ticket_favorites (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ticket_id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_favorites_ticket ON ticket_favorites(ticket_id);
CREATE TABLE IF NOT EXISTS ticket_watchers (
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_watchers_user ON ticket_watchers(user_id);
