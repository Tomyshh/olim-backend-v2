-- ============================================================================
-- Olim Backend: Supabase Migration 005
-- Adds missing tables, columns, indexes, and FK constraints to complete
-- the Firestore → Supabase migration.
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: Missing tables
-- ============================================================================

-- ---- Invoices (Clients/{uid}/invoices) ----
CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  client_id uuid REFERENCES public.clients(id),
  client_firebase_uid text,
  amount_cents integer,
  currency text NOT NULL DEFAULT 'ILS',
  description text,
  invoice_date timestamptz,
  payment_method text,
  payme_transaction_id text,
  status text NOT NULL DEFAULT 'paid',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoices_client_id ON public.invoices (client_id, created_at DESC);

-- ---- News (root collection News) ----
CREATE TABLE IF NOT EXISTS public.news (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text UNIQUE,
  title text,
  content text,
  category text,
  is_breaking boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Available Slots (root collection AvailableSlots) ----
CREATE TABLE IF NOT EXISTS public.available_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text UNIQUE,
  slot_date text,
  slot_time text,
  is_available boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---- User Saved Tips (Clients/{uid}/Tips) ----
CREATE TABLE IF NOT EXISTS public.user_saved_tips (
  id text PRIMARY KEY,
  client_id uuid REFERENCES public.clients(id),
  client_firebase_uid text,
  tip_id text,
  title text,
  content text,
  saved_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_user_saved_tips_client ON public.user_saved_tips (client_id);

-- ---- Tip Likes (likedBy field in Tips docs) ----
CREATE TABLE IF NOT EXISTS public.tip_likes (
  id text PRIMARY KEY,
  tip_id text NOT NULL,
  client_firebase_uid text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tip_likes_tip ON public.tip_likes (tip_id);

-- ---- Client Settings (Clients/{uid}/settings/preferences) ----
CREATE TABLE IF NOT EXISTS public.client_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL UNIQUE REFERENCES public.clients(id),
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- SECTION 2: Missing columns on existing tables
-- ============================================================================

-- family_members: fields from Firestore Family Members
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS has_gov_access boolean;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS is_connected boolean;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS lives_at_home boolean;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS service_active boolean;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS billing_exempt boolean;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS billing_exempt_reason text;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS validation_status text;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS relationship_type text;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS is_child boolean;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS service_activated_at timestamptz;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS reactivated_at timestamptz;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS selected_card_id text;

-- client_documents: align with dualWrite mapper columns
ALTER TABLE public.client_documents ADD COLUMN IF NOT EXISTS file_url text;
ALTER TABLE public.client_documents ADD COLUMN IF NOT EXISTS file_path text;
ALTER TABLE public.client_documents ADD COLUMN IF NOT EXISTS file_name text;
ALTER TABLE public.client_documents ADD COLUMN IF NOT EXISTS content_type text;
ALTER TABLE public.client_documents ADD COLUMN IF NOT EXISTS file_size integer;

-- client_addresses: additional fields from Firestore
ALTER TABLE public.client_addresses ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE public.client_addresses ADD COLUMN IF NOT EXISTS additional_info text;
ALTER TABLE public.client_addresses ADD COLUMN IF NOT EXISTS details text;
ALTER TABLE public.client_addresses ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.client_addresses ADD COLUMN IF NOT EXISTS order_index integer DEFAULT 0;

-- client_access_credentials: ensure client_firebase_uid column exists
ALTER TABLE public.client_access_credentials ADD COLUMN IF NOT EXISTS client_firebase_uid text;

-- ============================================================================
-- SECTION 3: Additional indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_clients_firebase_uid ON public.clients (firebase_uid);
CREATE INDEX IF NOT EXISTS idx_clients_auth_user_id ON public.clients (auth_user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_client_id ON public.subscriptions (client_id);
CREATE INDEX IF NOT EXISTS idx_requests_user_id ON public.requests (user_id);
CREATE INDEX IF NOT EXISTS idx_requests_client_id ON public.requests (client_id);
CREATE INDEX IF NOT EXISTS idx_promo_reverts_uid ON public.promo_reverts (client_firebase_uid);

-- Firestore ID indexes for migration dedup
CREATE INDEX IF NOT EXISTS idx_invoices_firestore_id ON public.invoices (firestore_id);
CREATE INDEX IF NOT EXISTS idx_client_access_cred_firestore ON public.client_access_credentials (firestore_id);
CREATE INDEX IF NOT EXISTS idx_client_logs_firestore_id ON public.client_logs (firestore_id);

-- ============================================================================
-- SECTION 4: RLS on new tables
-- ============================================================================

DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'invoices','news','available_slots',
      'user_saved_tips','tip_likes','client_settings'
    ])
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'allow_service_role_' || tbl, tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      'allow_service_role_' || tbl, tbl
    );
  END LOOP;
END $$;

COMMIT;
