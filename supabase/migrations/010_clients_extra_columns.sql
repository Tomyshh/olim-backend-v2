-- ============================================================================
-- Migration 010: Add missing columns to clients from Firestore field discovery
-- ============================================================================
-- 99 unique Firestore fields discovered. Many map to existing columns but
-- several high-value fields had no column. This migration adds them.
-- ============================================================================

-- Primary phone (2725/2802 clients have it in Firestore)
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS phone text;

-- Profile photo URL
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS profile_photo_url text;

-- Activity tracking (2794/2802 clients)
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS last_active_at timestamptz;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS activity_score integer;

-- Request tracking (692/2802 clients)
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS total_requests integer DEFAULT 0;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS last_request_at timestamptz;

-- Registration tracking
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS informations_filled boolean DEFAULT false;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS is_first_visit boolean;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS created_via text;

-- Subscription/billing columns
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS is_annual_subscription boolean;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS annual_expiration_date timestamptz;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS isracard_sub_code text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS isracard_sub_id text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS subscription_plan text;

-- Promo tracking
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS promo_code_expiration_date timestamptz;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS promo_code_reduction integer;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS promo_code_source text;

-- Phone verification
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS phone_verified boolean DEFAULT false;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS verified_phone_number text;

-- Mirpaa (health service)
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS mirpaa_name text;

-- Elite onboarding
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS elite_onboarding_done boolean DEFAULT false;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_clients_phone ON public.clients (phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clients_membership_type_id ON public.clients (membership_type_id) WHERE membership_type_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clients_last_active_at ON public.clients (last_active_at DESC NULLS LAST) WHERE last_active_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clients_is_unpaid ON public.clients (is_unpaid) WHERE is_unpaid = true;
CREATE INDEX IF NOT EXISTS idx_clients_created_from ON public.clients (created_from) WHERE created_from IS NOT NULL;
