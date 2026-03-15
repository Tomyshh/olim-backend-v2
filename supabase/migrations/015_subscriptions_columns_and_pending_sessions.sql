-- 015: Add missing columns to subscriptions + create pending_payment_sessions table

-- A1. Missing columns on subscriptions (required by dualWrite mappers)
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS base_price_cents INTEGER;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS family_supplement_count INTEGER DEFAULT 0;

-- B1. New table for PayMe hosted sale flow
CREATE TABLE IF NOT EXISTS pending_payment_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_firebase_uid TEXT NOT NULL,
  payme_sale_id TEXT,
  status TEXT DEFAULT 'pending',
  membership TEXT NOT NULL,
  plan_type TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  installments INTEGER DEFAULT 1,
  promo_code TEXT,
  created_by_uid TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_payment_sessions_payme_sale_id
  ON pending_payment_sessions (payme_sale_id);

CREATE INDEX IF NOT EXISTS idx_pending_payment_sessions_client
  ON pending_payment_sessions (client_firebase_uid);

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
