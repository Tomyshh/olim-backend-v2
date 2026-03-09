-- ============================================================================
-- OLIM CRM — Tables roles + conseillers dans Supabase
-- Execute ce fichier dans le SQL Editor de Supabase (Dashboard > SQL Editor)
-- ============================================================================

DROP TABLE IF EXISTS public.conseillers CASCADE;
DROP TABLE IF EXISTS public.roles CASCADE;

-- ============================================================================
-- 1. Table de reference : roles
-- ============================================================================

CREATE TABLE public.roles (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  description text,
  has_leads_access boolean NOT NULL DEFAULT false,
  has_admin_access boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_pkey PRIMARY KEY (id)
);

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON public.roles FOR ALL USING (true) WITH CHECK (true);

-- ============================================================================
-- 2. Table conseillers avec role
-- ============================================================================

CREATE TABLE public.conseillers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  firebase_uid text UNIQUE,
  name text NOT NULL,
  email text NOT NULL,
  role_id uuid REFERENCES public.roles(id),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conseillers_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_conseillers_firebase_uid ON public.conseillers (firebase_uid);
CREATE INDEX idx_conseillers_active ON public.conseillers (is_active) WHERE is_active = true;
CREATE INDEX idx_conseillers_role_id ON public.conseillers (role_id);

ALTER TABLE public.conseillers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON public.conseillers FOR ALL USING (true) WITH CHECK (true);

-- ============================================================================
-- SEED DATA : Roles
-- ============================================================================

INSERT INTO public.roles (slug, label, description, has_leads_access, has_admin_access, display_order) VALUES
  ('direction',      'Direction',            'Super admin — accès complet à toutes les sections',            true,  true,  1),
  ('commercial',     'Commercial',           'Accès au module leads et suivi commercial',                    true,  false, 2),
  ('senior_advisor', 'Conseiller Senior',    'Conseiller expérimenté — pas d''accès aux leads',              false, false, 3),
  ('accounting',     'Comptabilité',         'Gestion comptable — pas d''accès aux leads',                   false, false, 4),
  ('advisor',        'Conseiller',           'Conseiller standard — pas d''accès aux leads',                 false, false, 5),
  ('quality',        'Qualité',              'Contrôle qualité et audit',                                    false, false, 6),
  ('partnership',    'Partenariat',          'Gestion des partenariats',                                     false, false, 7),
  ('legal',          'Juridique',            'Service juridique',                                            false, false, 8),
  ('marketing',      'Marketing',            'Marketing et communication',                                   true,  false, 9),
  ('hr',             'Ressources Humaines',  'Gestion des ressources humaines',                              false, false, 10)
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- SEED DATA : Conseillers avec attribution de roles
-- ============================================================================

INSERT INTO public.conseillers (name, email, is_active, role_id) VALUES
  ('Aaron',    'aaron@olimservice.com',    true, (SELECT id FROM public.roles WHERE slug = 'advisor')),
  ('Anaelle',  'anaelle@olimservice.com',  true, (SELECT id FROM public.roles WHERE slug = 'advisor')),
  ('Annie',    'annie@olimservice.com',    true, (SELECT id FROM public.roles WHERE slug = 'advisor')),
  ('Arielle',  'arielle@olimservice.com',  true, (SELECT id FROM public.roles WHERE slug = 'accounting')),
  ('David',    'david@olimservice.com',    true, (SELECT id FROM public.roles WHERE slug = 'direction')),
  ('Eva-B',    'eva-b@olimservice.com',    true, (SELECT id FROM public.roles WHERE slug = 'advisor')),
  ('Jessica',  'jessica@olimservice.com',  true, (SELECT id FROM public.roles WHERE slug = 'senior_advisor')),
  ('Keren',    'keren@olimservice.com',    true, (SELECT id FROM public.roles WHERE slug = 'advisor')),
  ('Marie',    'marie@olimservice.com',    true, (SELECT id FROM public.roles WHERE slug = 'advisor')),
  ('Nery',     'nery@olimservice.com',     true, (SELECT id FROM public.roles WHERE slug = 'advisor')),
  ('Odelia',   'odelia@olimservice.com',   true, (SELECT id FROM public.roles WHERE slug = 'advisor')),
  ('Rinat',    'rinat@olimservice.com',    true, (SELECT id FROM public.roles WHERE slug = 'partnership')),
  ('Ruth',     'ruth@olimservice.com',     true, (SELECT id FROM public.roles WHERE slug = 'advisor')),
  ('Sarah',    'sarah@olimservice.com',    true, (SELECT id FROM public.roles WHERE slug = 'advisor')),
  ('Shirel',   'shirel@olimservice.com',   true, (SELECT id FROM public.roles WHERE slug = 'advisor')),
  ('Yaacov',   'yaacov@olimservice.com',   true, (SELECT id FROM public.roles WHERE slug = 'direction'))
ON CONFLICT DO NOTHING;
