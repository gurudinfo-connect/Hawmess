-- Internal audio / video calling: call history + audit metadata ONLY.
-- No audio, video or SDP/ICE data is ever stored; media flows peer-to-peer (or through a TURN relay) and is never recorded.
CREATE TABLE IF NOT EXISTS calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  caller_id UUID NOT NULL REFERENCES users(id),
  callee_id UUID NOT NULL REFERENCES users(id),
  call_type TEXT NOT NULL CHECK (call_type IN ('audio','video')),
  -- 'ringing' and 'active' are the only non-final states; everything else is the final outcome.
  status TEXT NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing','active','completed','missed','declined','failed','cancelled')),
  end_reason TEXT,                          -- e.g. busy, offline, timeout, hangup, media_error, ice_failed, disconnected, server_restart
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ,                  -- the callee pressed Accept
  connected_at TIMESTAMPTZ,                 -- media actually connected (first peer report)
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),   -- connected_at -> ended_at
  CHECK (caller_id <> callee_id)
);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_company ON calls(company_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_open ON calls(status) WHERE status IN ('ringing','active');
