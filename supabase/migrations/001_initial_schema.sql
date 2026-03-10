-- ============================================================================
-- Olim Backend: Supabase Migration 001
-- Creates new tables + adds missing columns to existing tables.
--
-- EXCLUDED (production tables, do NOT touch):
--   daily_platform_stats, leads, lead_*, popular_categories, request_metrics,
--   requests, roles, voice_requests, v_requests_enriched, v_lead*
-- ============================================================================

BEGIN;

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- SECTION 1: Existing tables – add missing columns only
-- ============================================================================

-- clients: add columns that may be missing
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS membership_type text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS membership_status text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS is_unpaid boolean NOT NULL DEFAULT false;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS free_access jsonb;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS seniority jsonb;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS created_from text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS securden_folder text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS promo_code_used text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS firestore_id text;

-- client_addresses: add firestore_id for dual-write mapping
ALTER TABLE public.client_addresses ADD COLUMN IF NOT EXISTS firestore_id text;

-- family_members: add missing fields
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS firestore_id text;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS father_name text;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS koupat_holim text;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS monthly_supplement_cents integer;

-- payment_credentials: add firestore_id
ALTER TABLE public.payment_credentials ADD COLUMN IF NOT EXISTS firestore_id text;

-- subscriptions: add missing fields
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS firestore_id text;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS is_active boolean;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS is_paused boolean;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS will_expire boolean;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS is_annual boolean;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS family_supplement_cents integer;

-- client_documents: add firestore_id
ALTER TABLE public.client_documents ADD COLUMN IF NOT EXISTS firestore_id text;

-- ============================================================================
-- SECTION 2: New indexes on existing tables (IF NOT EXISTS)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_clients_email ON public.clients (email);
CREATE INDEX IF NOT EXISTS idx_family_members_client_id ON public.family_members (client_id);
CREATE INDEX IF NOT EXISTS idx_payment_credentials_client_id ON public.payment_credentials (client_id);
CREATE INDEX IF NOT EXISTS idx_client_addresses_client_id ON public.client_addresses (client_id);
CREATE INDEX IF NOT EXISTS idx_client_devices_client_id ON public.client_devices (client_id);
CREATE INDEX IF NOT EXISTS idx_client_fcm_tokens_client_id ON public.client_fcm_tokens (client_id);
CREATE INDEX IF NOT EXISTS idx_client_phones_client_id ON public.client_phones (client_id);
CREATE INDEX IF NOT EXISTS idx_client_documents_client_id ON public.client_documents (client_id);
CREATE INDEX IF NOT EXISTS idx_subscription_events_subscription_id ON public.subscription_events (subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscription_events_client_id ON public.subscription_events (client_id);

-- ============================================================================
-- SECTION 3: New tables
-- ============================================================================

-- ---- Chat Conversations (Clients/{uid}/Conversations) ----
CREATE TABLE IF NOT EXISTS public.chat_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text UNIQUE,
  client_id uuid NOT NULL REFERENCES public.clients(id),
  request_id text,
  title text DEFAULT 'Nouvelle conversation',
  last_message text,
  last_message_at timestamptz,
  unread_count integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.chat_conversations DROP CONSTRAINT IF EXISTS chat_conversations_firestore_id_key;
ALTER TABLE public.chat_conversations ADD CONSTRAINT chat_conversations_firestore_id_key UNIQUE (firestore_id);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_client ON public.chat_conversations (client_id, updated_at DESC);

-- ---- Chat Messages (Clients/{uid}/Conversations/{id}/Messages) ----
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  conversation_id uuid NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  sender_id text NOT NULL,
  sender_name text,
  content text,
  type text NOT NULL DEFAULT 'text',
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_read boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON public.chat_messages (conversation_id, created_at);

-- ---- ChatCC (QA chat – root collection) ----
CREATE TABLE IF NOT EXISTS public.chatcc (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text UNIQUE,
  client_id text NOT NULL,
  counselor_id text NOT NULL,
  counselor_name text,
  request_id text,
  is_done boolean NOT NULL DEFAULT false,
  is_done_by text,
  last_message text,
  last_timestamp timestamptz,
  welcome_shown_to_client boolean DEFAULT false,
  welcome_shown_at timestamptz,
  unread_for_client integer DEFAULT 0,
  unread_for_counselor integer DEFAULT 0,
  is_favorite boolean DEFAULT false,
  closed_chat_date timestamptz,
  satisfaction_score integer,
  chat_rating integer,
  chat_rating_date timestamptz,
  chat_rating_skipped boolean,
  chat_rating_tags jsonb DEFAULT '[]'::jsonb,
  evaluation_date timestamptz,
  evaluation_feedback text,
  evaluation_strengths text,
  evaluation_improvements text,
  evaluation_note text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---- ChatCC Messages ----
CREATE TABLE IF NOT EXISTS public.chatcc_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  chatcc_id uuid NOT NULL REFERENCES public.chatcc(id) ON DELETE CASCADE,
  client_id text,
  request_id text,
  sender_id text NOT NULL,
  sender_name text,
  content text,
  type text NOT NULL DEFAULT 'text',
  file_url text,
  is_uploading boolean DEFAULT false,
  read_by jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chatcc_messages_chatcc ON public.chatcc_messages (chatcc_id, created_at);

-- ---- Appointments (Clients/{uid}/appointments) ----
CREATE TABLE IF NOT EXISTS public.appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  client_id uuid NOT NULL REFERENCES public.clients(id),
  request_id text,
  slot_id text,
  appointment_date text,
  appointment_time text,
  status text NOT NULL DEFAULT 'scheduled',
  notes text DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appointments_client ON public.appointments (client_id, created_at DESC);

-- ---- Notifications (Clients/{uid}/notifications) ----
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  client_id uuid NOT NULL REFERENCES public.clients(id),
  title text,
  body text,
  type text,
  is_read boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_client ON public.notifications (client_id, created_at DESC);

-- ---- Notification Settings (Clients/{uid}/settings/notifications) ----
CREATE TABLE IF NOT EXISTS public.notification_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL UNIQUE REFERENCES public.clients(id),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Favorite Requests (Clients/{uid}/favoriteRequests) ----
CREATE TABLE IF NOT EXISTS public.favorite_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text UNIQUE,
  client_id uuid NOT NULL REFERENCES public.clients(id),
  category_id text,
  sub_category_id text,
  category_title text,
  sub_category_title text,
  request_type text,
  last_used timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.favorite_requests DROP CONSTRAINT IF EXISTS favorite_requests_firestore_id_key;
ALTER TABLE public.favorite_requests ADD CONSTRAINT favorite_requests_firestore_id_key UNIQUE (firestore_id);
CREATE INDEX IF NOT EXISTS idx_favorite_requests_client ON public.favorite_requests (client_id);

-- ---- Request Drafts (Clients/{uid}/RequestDrafts) ----
CREATE TABLE IF NOT EXISTS public.request_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  client_id uuid NOT NULL REFERENCES public.clients(id),
  draft_type text NOT NULL,
  title text,
  category text,
  subcategory text,
  progress numeric(3,2) DEFAULT 0,
  current_step text,
  snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  uploaded_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  client_temp_id text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_request_drafts_client ON public.request_drafts (client_id, updated_at DESC);

-- ---- Request Pending Processes (legacy) ----
CREATE TABLE IF NOT EXISTS public.request_pending_processes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  request_firestore_id text,
  client_firebase_uid text,
  request_type text,
  date text,
  description text,
  missing_doc text,
  missing_text text,
  response_text text,
  waiting_info_from_client boolean DEFAULT false,
  is_opened boolean DEFAULT false,
  response_doc jsonb DEFAULT '[]'::jsonb,
  missing_type text,
  done boolean DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Support Tickets ----
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  client_id uuid REFERENCES public.clients(id),
  client_firebase_uid text,
  subject text NOT NULL,
  description text,
  priority text NOT NULL DEFAULT 'normal',
  status text NOT NULL DEFAULT 'open',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_client ON public.support_tickets (client_id);

-- ---- Contact Messages ----
CREATE TABLE IF NOT EXISTS public.contact_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  client_firebase_uid text,
  name text,
  email text,
  phone text,
  subject text,
  message text,
  status text NOT NULL DEFAULT 'new',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Health Requests ----
CREATE TABLE IF NOT EXISTS public.health_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  client_id uuid REFERENCES public.clients(id),
  client_firebase_uid text,
  request_type text NOT NULL DEFAULT 'general',
  description text DEFAULT '',
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_health_requests_client ON public.health_requests (client_id);

-- ---- Health Configs ----
CREATE TABLE IF NOT EXISTS public.health_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL UNIQUE REFERENCES public.clients(id),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Subscription Change Quotes ----
CREATE TABLE IF NOT EXISTS public.subscription_change_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  client_id uuid NOT NULL REFERENCES public.clients(id),
  quote_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_sub_change_quotes_client ON public.subscription_change_quotes (client_id);

-- ---- Refund Requests ----
CREATE TABLE IF NOT EXISTS public.refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  client_id uuid REFERENCES public.clients(id),
  client_firebase_uid text,
  amount_cents integer,
  reason text,
  status text NOT NULL DEFAULT 'pending',
  reviewed_by text,
  reviewed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refund_requests_client ON public.refund_requests (client_id);

-- ---- System Alerts ----
CREATE TABLE IF NOT EXISTS public.system_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  alert_type text NOT NULL,
  title text,
  message text,
  severity text NOT NULL DEFAULT 'info',
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- ---- Conseillers V2 (Conseillers2 collection) ----
CREATE TABLE IF NOT EXISTS public.conseillers_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text UNIQUE,
  name text NOT NULL,
  email text,
  is_admin boolean NOT NULL DEFAULT false,
  is_super_admin boolean NOT NULL DEFAULT false,
  is_present boolean NOT NULL DEFAULT false,
  manage_elite boolean NOT NULL DEFAULT false,
  languages jsonb NOT NULL DEFAULT '{}'::jsonb,
  now_request text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Promotions (Firestore Promotions collection) ----
CREATE TABLE IF NOT EXISTS public.promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text UNIQUE,
  code text NOT NULL,
  code_normalized text,
  is_valid boolean NOT NULL DEFAULT true,
  for_everyone boolean NOT NULL DEFAULT false,
  membership_type text,
  applicable_memberships jsonb DEFAULT '[]'::jsonb,
  plan_type text,
  applicable_plans jsonb DEFAULT '[]'::jsonb,
  discount_percent integer,
  discount_amount_cents integer,
  duration_cycles integer,
  expiration_date timestamptz,
  source text,
  used_by_uid text,
  used_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_promotions_code ON public.promotions (code);

-- ---- Promo Reverts ----
CREATE TABLE IF NOT EXISTS public.promo_reverts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  client_firebase_uid text NOT NULL,
  promo_code text,
  promotion_id text,
  revert_at timestamptz NOT NULL,
  base_price_cents integer,
  discounted_price_cents integer,
  plan_type text,
  membership_type text,
  payme_sub_id text,
  duration_cycles integer,
  status text NOT NULL DEFAULT 'pending',
  source text,
  completed_at timestamptz,
  skip_reason text,
  last_error text,
  last_error_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_promo_reverts_status ON public.promo_reverts (status, revert_at);

-- ---- Client Creation Locks ----
CREATE TABLE IF NOT EXISTS public.client_creation_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lock_key text NOT NULL UNIQUE,
  email text,
  firebase_uid text,
  status text NOT NULL DEFAULT 'in_progress',
  last_error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Phone OTP Sessions ----
CREATE TABLE IF NOT EXISTS public.phone_otp_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose text NOT NULL,
  phone_number text NOT NULL,
  firebase_uid text,
  code_hash text,
  attempts integer NOT NULL DEFAULT 0,
  request_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_phone_otp_phone ON public.phone_otp_sessions (phone_number, created_at DESC);

-- ---- Job Leases ----
CREATE TABLE IF NOT EXISTS public.job_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'idle',
  last_success_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  locked_by text,
  locked_at timestamptz,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---- FAQs ----
CREATE TABLE IF NOT EXISTS public.faqs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  question text NOT NULL,
  answer text NOT NULL,
  category text,
  display_order integer DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Support Contacts ----
CREATE TABLE IF NOT EXISTS public.support_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  name text NOT NULL,
  role text,
  email text,
  phone text,
  whatsapp text,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Announcements (Annonces) ----
CREATE TABLE IF NOT EXISTS public.announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  title text NOT NULL,
  content text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---- iCinema Movies ----
CREATE TABLE IF NOT EXISTS public.icinema_movies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text UNIQUE,
  title text,
  language text,
  age_rating text,
  duration text,
  genre text,
  image_large text,
  image_long text,
  director text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---- iCinema Seances ----
CREATE TABLE IF NOT EXISTS public.icinema_seances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  movie_id uuid NOT NULL REFERENCES public.icinema_movies(id) ON DELETE CASCADE,
  showtime timestamptz,
  hall text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_icinema_seances_movie ON public.icinema_seances (movie_id);

-- ---- Client Access Credentials (legacy) ----
CREATE TABLE IF NOT EXISTS public.client_access_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  client_id uuid REFERENCES public.clients(id),
  title text,
  username text,
  securden_id text,
  family_members jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Idempotency Keys ----
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  request_id text,
  client_firebase_uid text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_key ON public.idempotency_keys (idempotency_key);

-- ---- Dual Write Failures (tracking) ----
CREATE TABLE IF NOT EXISTS public.dual_write_failures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_table text NOT NULL,
  operation text NOT NULL,
  payload jsonb NOT NULL,
  error_message text,
  error_stack text,
  retry_count integer NOT NULL DEFAULT 0,
  resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dual_write_failures_unresolved
  ON public.dual_write_failures (resolved, created_at)
  WHERE resolved = false;

-- ============================================================================
-- SECTION 4: RLS on new tables (service_role bypass)
-- ============================================================================

DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'chat_conversations','chat_messages','chatcc','chatcc_messages',
      'appointments','notifications','notification_settings',
      'favorite_requests','request_drafts','request_pending_processes',
      'support_tickets','contact_messages',
      'health_requests','health_configs',
      'subscription_change_quotes','refund_requests','system_alerts',
      'conseillers_v2','promotions','promo_reverts',
      'client_creation_locks','phone_otp_sessions','job_leases',
      'faqs','support_contacts','announcements',
      'icinema_movies','icinema_seances','client_access_credentials',
      'idempotency_keys','dual_write_failures'
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
