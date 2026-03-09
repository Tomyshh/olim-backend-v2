-- ============================================================================
-- OLIM CRM — Table conseillers dans Supabase
-- Execute ce fichier dans le SQL Editor de Supabase (Dashboard > SQL Editor)
-- ============================================================================

DROP TABLE IF EXISTS public.conseillers CASCADE;

CREATE TABLE public.conseillers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  firebase_uid text UNIQUE,
  name text NOT NULL,
  email text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conseillers_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_conseillers_firebase_uid ON public.conseillers (firebase_uid);
CREATE INDEX idx_conseillers_active ON public.conseillers (is_active) WHERE is_active = true;

ALTER TABLE public.conseillers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON public.conseillers FOR ALL USING (true) WITH CHECK (true);

-- ============================================================================
-- SEED DATA : Les 15 conseillers existants
-- ============================================================================

INSERT INTO public.conseillers (name, email, is_active) VALUES
  ('Aaron',    'aaron@olimservice.com',    true),
  ('Anaelle',  'anaelle@olimservice.com',  true),
  ('Annie',    'annie@olimservice.com',    true),
  ('Arielle',  'arielle@olimservice.com',  true),
  ('David',    'david@olimservice.com',    true),
  ('Eva-B',    'eva-b@olimservice.com',    true),
  ('Jessica',  'jessica@olimservice.com',  true),
  ('Keren',    'keren@olimservice.com',    true),
  ('Marie',    'marie@olimservice.com',    true),
  ('Nery',     'nery@olimservice.com',     true),
  ('Odelia',   'odelia@olimservice.com',   true),
  ('Ruth',     'ruth@olimservice.com',     true),
  ('Sarah',    'sarah@olimservice.com',    true),
  ('Shirel',   'shirel@olimservice.com',   true),
  ('Yaacov',   'yaacov@olimservice.com',   true)
ON CONFLICT DO NOTHING;
