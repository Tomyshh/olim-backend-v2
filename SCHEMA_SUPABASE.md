-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.admin_audit_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  action text NOT NULL,
  caller_firebase_uid text,
  client_firebase_uid text,
  ip inet,
  user_agent text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT admin_audit_logs_pkey PRIMARY KEY (id)
);
CREATE TABLE public.advertisements (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  firestore_id text UNIQUE,
  description text,
  url text,
  whatsapp text,
  phone text,
  is_active boolean NOT NULL DEFAULT false,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  last_shown_at timestamp with time zone,
  last_clicked_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT advertisements_pkey PRIMARY KEY (id)
);
CREATE TABLE public.app_config (
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT app_config_pkey PRIMARY KEY (key)
);
CREATE TABLE public.client_activity_history (
  id bigint NOT NULL DEFAULT nextval('client_activity_history_id_seq'::regclass),
  client_id text NOT NULL,
  email text,
  score integer,
  status text,
  requests_30d integer,
  requests_90d integer,
  monthly_average double precision,
  last_request_at timestamp with time zone,
  computed_at timestamp with time zone DEFAULT now(),
  CONSTRAINT client_activity_history_pkey PRIMARY KEY (id)
);
CREATE TABLE public.client_addresses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  label text,
  address1 text,
  address2 text,
  apartment text,
  floor text,
  city text,
  postal_code text,
  country text,
  is_primary boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT client_addresses_pkey PRIMARY KEY (id),
  CONSTRAINT client_addresses_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id)
);
CREATE TABLE public.client_devices (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  device_id text NOT NULL,
  platform text,
  app_version text,
  last_login_at timestamp with time zone,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT client_devices_pkey PRIMARY KEY (id),
  CONSTRAINT client_devices_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id)
);
CREATE TABLE public.client_document_files (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  client_document_id uuid NOT NULL,
  url text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT client_document_files_pkey PRIMARY KEY (id),
  CONSTRAINT client_document_files_client_document_id_fkey FOREIGN KEY (client_document_id) REFERENCES public.client_documents(id)
);
CREATE TABLE public.client_documents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  document_type text NOT NULL,
  for_who text,
  uploaded_at timestamp with time zone,
  is_valid boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT client_documents_pkey PRIMARY KEY (id),
  CONSTRAINT client_documents_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id)
);
CREATE TABLE public.client_fcm_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  token text NOT NULL,
  platform text,
  device_id text,
  last_seen_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT client_fcm_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT client_fcm_tokens_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id)
);
CREATE TABLE public.client_phones (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  phone_e164 text NOT NULL,
  is_verified boolean NOT NULL DEFAULT false,
  verified_at timestamp with time zone,
  source text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT client_phones_pkey PRIMARY KEY (id),
  CONSTRAINT client_phones_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id)
);
CREATE TABLE public.clients (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  firebase_uid text NOT NULL UNIQUE,
  auth_user_id uuid,
  email USER-DEFINED,
  first_name text,
  last_name text,
  father_name text,
  civility text,
  birthday date,
  teoudat_zeout text,
  koupat_holim text,
  language text NOT NULL DEFAULT 'fr'::text,
  registration_complete boolean NOT NULL DEFAULT false,
  registration_completed_at timestamp with time zone,
  has_gov_access boolean,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT clients_pkey PRIMARY KEY (id)
);
CREATE TABLE public.counselors (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  email USER-DEFINED,
  is_present boolean,
  requests_count integer,
  is_finance boolean,
  manage_elite boolean,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT counselors_pkey PRIMARY KEY (id)
);
CREATE TABLE public.daily_platform_stats (
  date date NOT NULL,
  total_clients integer,
  active_clients_30d integer,
  avg_request_month double precision,
  avg_request_day double precision,
  median_request_month double precision,
  median_request_day double precision,
  status_distribution jsonb,
  membership_distribution jsonb,
  total_requests_30d integer,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT daily_platform_stats_pkey PRIMARY KEY (date)
);
CREATE TABLE public.delete_user_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  firebase_uid text,
  email USER-DEFINED,
  reason text,
  status text NOT NULL DEFAULT 'pending'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  processed_at timestamp with time zone,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT delete_user_requests_pkey PRIMARY KEY (id)
);
CREATE TABLE public.family_members (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  first_name text,
  last_name text,
  birthday date,
  teoudat_zeout text,
  status text,
  is_account_owner boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT family_members_pkey PRIMARY KEY (id),
  CONSTRAINT family_members_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id)
);
CREATE TABLE public.leads (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  firestore_id text UNIQUE,
  email USER-DEFINED,
  first_name text,
  last_name text,
  phone text,
  status text,
  description text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT leads_pkey PRIMARY KEY (id)
);
CREATE TABLE public.partners (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  firestore_id text UNIQUE,
  title text,
  description text,
  vip_sentence text,
  address text,
  category text,
  partner_type text,
  waze text,
  is_active boolean,
  is_vip boolean,
  keywords ARRAY,
  subtitle ARRAY,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT partners_pkey PRIMARY KEY (id)
);
CREATE TABLE public.payment_credentials (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'payme'::text,
  external_id text,
  buyer_key text,
  card_masked text,
  card_type text,
  card_name text,
  securden_id text,
  securden_folder text,
  is_default boolean NOT NULL DEFAULT false,
  is_subscription_card boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT payment_credentials_pkey PRIMARY KEY (id),
  CONSTRAINT payment_credentials_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id)
);
CREATE TABLE public.phone_otp_codes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  purpose text NOT NULL,
  firebase_uid text,
  phone_number text NOT NULL,
  code_hash text,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  consumed_at timestamp with time zone,
  ip inet,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT phone_otp_codes_pkey PRIMARY KEY (id)
);
CREATE TABLE public.promo_codes (
  code text NOT NULL,
  membership_type text,
  discount_percent integer,
  for_everyone boolean NOT NULL DEFAULT false,
  is_valid boolean NOT NULL DEFAULT true,
  expires_at timestamp with time zone,
  source text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT promo_codes_pkey PRIMARY KEY (code)
);
CREATE TABLE public.promo_redemptions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  client_id uuid NOT NULL,
  subscription_id uuid,
  redeemed_at timestamp with time zone NOT NULL DEFAULT now(),
  source text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT promo_redemptions_pkey PRIMARY KEY (id),
  CONSTRAINT promo_redemptions_code_fkey FOREIGN KEY (code) REFERENCES public.promo_codes(code),
  CONSTRAINT promo_redemptions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id),
  CONSTRAINT promo_redemptions_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id)
);
CREATE TABLE public.request_files (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  kind text NOT NULL,
  url text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT request_files_pkey PRIMARY KEY (id),
  CONSTRAINT request_files_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id)
);
CREATE TABLE public.request_status_events (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  request_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  changed_at timestamp with time zone NOT NULL DEFAULT now(),
  actor_type text,
  actor_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT request_status_events_pkey PRIMARY KEY (id),
  CONSTRAINT request_status_events_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id)
);
CREATE TABLE public.request_tags (
  request_id uuid NOT NULL,
  tag text NOT NULL,
  CONSTRAINT request_tags_pkey PRIMARY KEY (request_id, tag),
  CONSTRAINT request_tags_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id)
);
CREATE TABLE public.requests (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  firebase_request_id character varying,
  unique_id character varying UNIQUE,
  linked_request_id character varying,
  user_id character varying NOT NULL,
  first_name character varying,
  last_name character varying,
  email character varying,
  phone character varying,
  membership_type character varying,
  request_type character varying NOT NULL,
  request_category character varying NOT NULL,
  request_sub_category character varying,
  request_ref character varying,
  category_id character varying,
  sub_category_id character varying,
  request_description text,
  form_data jsonb,
  tags ARRAY,
  uploaded_files ARRAY,
  file_count integer DEFAULT 0,
  available_days ARRAY,
  available_hours ARRAY,
  status character varying DEFAULT 'Assigned'::character varying,
  priority integer DEFAULT 1,
  difficulty integer DEFAULT 1,
  is_opened boolean DEFAULT false,
  success boolean DEFAULT true,
  is_pending boolean DEFAULT false,
  assigned_to character varying,
  response_text text,
  response_date timestamp with time zone,
  response_files ARRAY,
  response_comment text,
  is_rdv boolean DEFAULT false,
  rdv_location character varying,
  rdv_date character varying,
  rdv_hours character varying,
  rdv_name character varying,
  is_rdv_over boolean DEFAULT false,
  rdv_not_found boolean DEFAULT false,
  rating integer,
  rating_tags ARRAY,
  client_comment text,
  location character varying,
  contact character varying,
  waiting_time character varying,
  waiting_info_from_client boolean DEFAULT false,
  has_missing_fields boolean DEFAULT false,
  missing_fields ARRAY,
  additional_information text,
  source character varying,
  platform character varying DEFAULT 'mobile'::character varying,
  app_version character varying,
  created_by character varying DEFAULT 'APP'::character varying,
  request_date timestamp with time zone NOT NULL DEFAULT now(),
  in_progress_date timestamp with time zone,
  closing_date timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  sync_source character varying,
  sync_date timestamp with time zone,
  client_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT requests_pkey PRIMARY KEY (id),
  CONSTRAINT requests_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id)
);
CREATE TABLE public.subscription_events (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  subscription_id uuid NOT NULL,
  client_id uuid NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamp with time zone NOT NULL DEFAULT now(),
  actor_type text,
  actor_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT subscription_events_pkey PRIMARY KEY (id),
  CONSTRAINT subscription_events_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id),
  CONSTRAINT subscription_events_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id)
);
CREATE TABLE public.subscriptions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL UNIQUE,
  plan_type text,
  membership_type text,
  price_cents integer,
  currency text NOT NULL DEFAULT 'ILS'::text,
  payment_method text,
  installments integer,
  next_payment_at timestamp with time zone,
  last_payment_at timestamp with time zone,
  payme_sub_code integer,
  payme_sub_id text,
  payme_buyer_key text,
  payme_status text,
  payme_sub_status integer,
  payme_next_payment_date date,
  promo_code text,
  promo_source text,
  promo_applied_at timestamp with time zone,
  promo_expires_at timestamp with time zone,
  is_unpaid boolean NOT NULL DEFAULT false,
  start_at timestamp with time zone,
  end_at timestamp with time zone,
  cancelled_at timestamp with time zone,
  resumed_at timestamp with time zone,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT subscriptions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id)
);
CREATE TABLE public.tip_translations (
  tip_id uuid NOT NULL,
  lang text NOT NULL,
  title text,
  content text,
  CONSTRAINT tip_translations_pkey PRIMARY KEY (tip_id, lang),
  CONSTRAINT tip_translations_tip_id_fkey FOREIGN KEY (tip_id) REFERENCES public.tips(id)
);
CREATE TABLE public.tips (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  firestore_id text UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT tips_pkey PRIMARY KEY (id)
);
CREATE TABLE public.voice_requests (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  subgroup_id text,
  transcription text,
  matched_group_name text,
  matched_subgroup_name text,
  CONSTRAINT voice_requests_pkey PRIMARY KEY (id)
);