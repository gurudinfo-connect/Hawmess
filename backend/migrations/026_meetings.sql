-- Schedule calendar: meetings assigned by admin / HR / any employee, per-person saved schedule and alerts. Additive and idempotent.

CREATE TABLE IF NOT EXISTS meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'meeting' CHECK (kind IN ('meeting','interview','review','training','call','personal','other')),
  meeting_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  location TEXT,
  meeting_link TEXT,
  is_public BOOLEAN NOT NULL DEFAULT false,          -- company-wide: everyone can see it and save it to their own schedule
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  organizer_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS idx_meetings_company_date ON meetings(company_id, meeting_date);

-- One row per person per meeting = that person's saved schedule entry (with their own response and alert).
CREATE TABLE IF NOT EXISTS meeting_attendees (
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'invitee' CHECK (role IN ('organizer','invitee','saved')),   -- saved = the person added it to their own schedule
  response TEXT NOT NULL DEFAULT 'pending' CHECK (response IN ('pending','accepted','declined','tentative')),
  alert_minutes INT CHECK (alert_minutes BETWEEN 0 AND 10080),   -- minutes before the start; NULL = no alert
  alert_notified_at TIMESTAMPTZ,                                 -- bell / e-mail alert already sent
  snoozed_until TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_attendees_user ON meeting_attendees(user_id);
