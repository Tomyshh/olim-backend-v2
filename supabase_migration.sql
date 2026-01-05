-- 1. Table for historical snapshots of client activity
-- Allows for tracking engagement score evolution over time.
CREATE TABLE IF NOT EXISTS client_activity_history (
  id BIGSERIAL PRIMARY KEY,
  client_id TEXT NOT NULL,
  email TEXT,
  score INTEGER,
  status TEXT,
  requests_30d INTEGER,
  requests_90d INTEGER,
  monthly_average FLOAT,
  last_request_at TIMESTAMP WITH TIME ZONE,
  computed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Prevent multiple snapshots for the same client on the same day
  CONSTRAINT unique_client_daily_snapshot UNIQUE (client_id, computed_at)
);

CREATE INDEX IF NOT EXISTS idx_client_activity_computed_at ON client_activity_history (computed_at);
CREATE INDEX IF NOT EXISTS idx_client_activity_client_id ON client_activity_history (client_id);

-- 2. Table for daily platform-wide aggregated statistics
-- Useful for executive dashboards and high-level KPI tracking.
CREATE TABLE IF NOT EXISTS daily_platform_stats (
  date DATE PRIMARY KEY,
  total_clients INTEGER,
  active_clients_30d INTEGER,
  avg_request_month FLOAT,
  avg_request_day FLOAT,
  median_request_month FLOAT,
  median_request_day FLOAT,
  status_distribution JSONB,
  membership_distribution JSONB, -- Example: {"Visitor": 100, "Pack Start": 50, ...}
  total_requests_30d INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
