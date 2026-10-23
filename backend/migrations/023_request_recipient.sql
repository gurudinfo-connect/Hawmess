-- Who an employee request (e.g. leave) was sent to: HR, Admin or both.
ALTER TABLE employee_requests ADD COLUMN IF NOT EXISTS send_to TEXT NOT NULL DEFAULT 'both' CHECK (send_to IN ('hr','admin','both'));
