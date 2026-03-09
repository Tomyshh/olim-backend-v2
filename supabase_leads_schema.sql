-- ============================================================================
-- OLIM CRM — Module Leads : Schema Supabase complet
-- Execute ce fichier dans le SQL Editor de Supabase (Dashboard > SQL Editor)
-- ============================================================================

-- Nettoyage : supprimer les objets existants pour eviter les conflits
-- (l'ancienne table leads a un schema different et incompatible)
-- Les DROP TABLE CASCADE suppriment aussi les triggers, vues dependantes, etc.
DROP TABLE IF EXISTS public.lead_stats_daily CASCADE;
DROP TABLE IF EXISTS public.lead_nurturing_sequences CASCADE;
DROP TABLE IF EXISTS public.lead_score_rules CASCADE;
DROP TABLE IF EXISTS public.lead_assignment_rules CASCADE;
DROP TABLE IF EXISTS public.lead_attachments CASCADE;
DROP TABLE IF EXISTS public.lead_tasks CASCADE;
DROP TABLE IF EXISTS public.lead_reminders CASCADE;
DROP TABLE IF EXISTS public.lead_interactions CASCADE;
DROP TABLE IF EXISTS public.leads CASCADE;
DROP TABLE IF EXISTS public.lead_pipeline_statuses CASCADE;
DROP TABLE IF EXISTS public.lead_sources CASCADE;

DROP VIEW IF EXISTS public.v_lead_reminders_due CASCADE;
DROP VIEW IF EXISTS public.v_lead_stats_by_source CASCADE;
DROP VIEW IF EXISTS public.v_lead_stats_by_conseiller CASCADE;
DROP FUNCTION IF EXISTS public.update_leads_updated_at() CASCADE;


-- ============================================================================
-- 1. Table de reference : sources de leads
-- ============================================================================
CREATE TABLE public.lead_sources (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  category text NOT NULL CHECK (category IN ('digital', 'human', 'other')),
  icon text,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_sources_pkey PRIMARY KEY (id)
);

-- ============================================================================
-- 2. Table de reference : statuts pipeline
-- ============================================================================
CREATE TABLE public.lead_pipeline_statuses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  color text,
  display_order integer NOT NULL DEFAULT 0,
  is_terminal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_pipeline_statuses_pkey PRIMARY KEY (id)
);

-- ============================================================================
-- 3. Table principale : leads
-- ============================================================================
CREATE TABLE public.leads (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  firestore_id text UNIQUE,

  -- Informations principales
  first_name text NOT NULL,
  last_name text NOT NULL,
  phone text,
  phone_secondary text,
  email text,
  city text,
  country text,
  language text DEFAULT 'fr',

  -- Informations commerciales
  service_requested text,
  interest_level text CHECK (interest_level IN ('hot', 'warm', 'cold')) DEFAULT 'cold',
  estimated_budget text,
  urgency text CHECK (urgency IN ('low', 'medium', 'high', 'critical')) DEFAULT 'medium',

  -- Pipeline & scoring
  status_id uuid REFERENCES public.lead_pipeline_statuses(id),
  score integer NOT NULL DEFAULT 0,
  priority text CHECK (priority IN ('low', 'medium', 'high', 'urgent')) DEFAULT 'medium',

  -- Source
  source_id uuid REFERENCES public.lead_sources(id),
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Attribution
  conseiller_id text,
  assigned_at timestamptz,

  -- Dates
  last_interaction_at timestamptz,
  converted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Archivage
  archived_at timestamptz,
  archive_reason text,

  -- Notes
  comments text,

  CONSTRAINT leads_pkey PRIMARY KEY (id)
);

-- ============================================================================
-- 4. Interactions / historique
-- ============================================================================
CREATE TABLE public.lead_interactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  conseiller_id text NOT NULL,
  conseiller_name text,
  interaction_type text NOT NULL CHECK (interaction_type IN (
    'call', 'email', 'whatsapp', 'meeting', 'sms', 'note', 'status_change', 'other'
  )),
  summary text NOT NULL,
  next_action text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_interactions_pkey PRIMARY KEY (id)
);

-- ============================================================================
-- 5. Rappels
-- ============================================================================
CREATE TABLE public.lead_reminders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  conseiller_id text NOT NULL,
  reminder_at timestamptz NOT NULL,
  note text,
  treated boolean NOT NULL DEFAULT false,
  treated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_reminders_pkey PRIMARY KEY (id)
);

-- ============================================================================
-- 6. Taches
-- ============================================================================
CREATE TABLE public.lead_tasks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  task_type text NOT NULL CHECK (task_type IN (
    'call', 'send_quote', 'send_documents', 'follow_up', 'meeting', 'other'
  )),
  title text NOT NULL,
  description text,
  deadline timestamptz,
  responsible_id text NOT NULL,
  responsible_name text,
  status text NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')) DEFAULT 'pending',
  reminder_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_tasks_pkey PRIMARY KEY (id)
);

-- ============================================================================
-- 7. Pieces jointes
-- ============================================================================
CREATE TABLE public.lead_attachments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  file_url text NOT NULL,
  file_name text NOT NULL,
  file_size integer,
  mime_type text,
  uploaded_by text NOT NULL,
  uploaded_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_attachments_pkey PRIMARY KEY (id)
);

-- ============================================================================
-- 8. Regles d'attribution automatique
-- ============================================================================
CREATE TABLE public.lead_assignment_rules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  rule_type text NOT NULL CHECK (rule_type IN ('source', 'language', 'workload', 'round_robin')),
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  conseiller_id text,
  priority integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_assignment_rules_pkey PRIMARY KEY (id)
);

-- ============================================================================
-- 9. Regles de scoring
-- ============================================================================
CREATE TABLE public.lead_score_rules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  condition_field text NOT NULL,
  condition_operator text NOT NULL CHECK (condition_operator IN ('equals', 'contains', 'gt', 'lt', 'gte', 'lte', 'exists')),
  condition_value text NOT NULL,
  score_delta integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_score_rules_pkey PRIMARY KEY (id)
);

-- ============================================================================
-- 10. Sequences de nurturing (preparatoire)
-- ============================================================================
CREATE TABLE public.lead_nurturing_sequences (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  trigger_status_id uuid REFERENCES public.lead_pipeline_statuses(id),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_nurturing_sequences_pkey PRIMARY KEY (id)
);

-- ============================================================================
-- 11. Stats quotidiennes (materialisees)
-- ============================================================================
CREATE TABLE public.lead_stats_daily (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  stat_date date NOT NULL,
  total_leads integer NOT NULL DEFAULT 0,
  new_leads integer NOT NULL DEFAULT 0,
  converted_leads integer NOT NULL DEFAULT 0,
  lost_leads integer NOT NULL DEFAULT 0,
  by_source jsonb NOT NULL DEFAULT '{}'::jsonb,
  by_conseiller jsonb NOT NULL DEFAULT '{}'::jsonb,
  by_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  avg_response_time_hours numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_stats_daily_pkey PRIMARY KEY (id),
  CONSTRAINT lead_stats_daily_date_unique UNIQUE (stat_date)
);


-- ============================================================================
-- INDEX
-- ============================================================================

CREATE INDEX idx_leads_conseiller_id ON public.leads (conseiller_id);
CREATE INDEX idx_leads_status_id ON public.leads (status_id);
CREATE INDEX idx_leads_source_id ON public.leads (source_id);
CREATE INDEX idx_leads_score ON public.leads (score DESC);
CREATE INDEX idx_leads_created_at ON public.leads (created_at DESC);
CREATE INDEX idx_leads_archived_at ON public.leads (archived_at) WHERE archived_at IS NULL;
CREATE INDEX idx_leads_interest_level ON public.leads (interest_level);
CREATE INDEX idx_leads_priority ON public.leads (priority);
CREATE INDEX idx_leads_country ON public.leads (country);
CREATE INDEX idx_leads_language ON public.leads (language);

CREATE INDEX idx_lead_interactions_lead_id ON public.lead_interactions (lead_id);
CREATE INDEX idx_lead_interactions_created_at ON public.lead_interactions (created_at DESC);

CREATE INDEX idx_lead_reminders_lead_id ON public.lead_reminders (lead_id);
CREATE INDEX idx_lead_reminders_due ON public.lead_reminders (reminder_at, treated) WHERE treated = false;
CREATE INDEX idx_lead_reminders_conseiller ON public.lead_reminders (conseiller_id, treated) WHERE treated = false;

CREATE INDEX idx_lead_tasks_lead_id ON public.lead_tasks (lead_id);
CREATE INDEX idx_lead_tasks_responsible ON public.lead_tasks (responsible_id, status);
CREATE INDEX idx_lead_tasks_deadline ON public.lead_tasks (deadline) WHERE status IN ('pending', 'in_progress');

CREATE INDEX idx_lead_attachments_lead_id ON public.lead_attachments (lead_id);

CREATE INDEX idx_lead_stats_daily_date ON public.lead_stats_daily (stat_date DESC);


-- ============================================================================
-- RLS (Row Level Security)
-- ============================================================================

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_pipeline_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_assignment_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_score_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_nurturing_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_stats_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON public.leads FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_full_access" ON public.lead_interactions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_full_access" ON public.lead_reminders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_full_access" ON public.lead_tasks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_full_access" ON public.lead_attachments FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_full_access" ON public.lead_sources FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_full_access" ON public.lead_pipeline_statuses FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_full_access" ON public.lead_assignment_rules FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_full_access" ON public.lead_score_rules FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_full_access" ON public.lead_nurturing_sequences FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_full_access" ON public.lead_stats_daily FOR ALL USING (true) WITH CHECK (true);


-- ============================================================================
-- VUES
-- ============================================================================

CREATE OR REPLACE VIEW public.v_lead_stats_by_conseiller AS
SELECT
  l.conseiller_id,
  COUNT(*) AS total_leads,
  COUNT(*) FILTER (WHERE ps.slug = 'converted') AS converted_leads,
  COUNT(*) FILTER (WHERE ps.slug = 'lost') AS lost_leads,
  COUNT(*) FILTER (WHERE ps.slug = 'new') AS new_leads,
  ROUND(
    COUNT(*) FILTER (WHERE ps.slug = 'converted')::numeric
    / NULLIF(COUNT(*)::numeric, 0) * 100, 2
  ) AS conversion_rate,
  AVG(
    EXTRACT(EPOCH FROM (l.last_interaction_at - l.created_at)) / 3600
  ) FILTER (WHERE l.last_interaction_at IS NOT NULL) AS avg_response_time_hours,
  COUNT(*) FILTER (WHERE l.interest_level = 'hot') AS hot_leads,
  COUNT(*) FILTER (WHERE l.interest_level = 'warm') AS warm_leads,
  COUNT(*) FILTER (WHERE l.interest_level = 'cold') AS cold_leads
FROM public.leads l
LEFT JOIN public.lead_pipeline_statuses ps ON l.status_id = ps.id
WHERE l.archived_at IS NULL
GROUP BY l.conseiller_id;

CREATE OR REPLACE VIEW public.v_lead_stats_by_source AS
SELECT
  ls.id AS source_id,
  ls.slug AS source_slug,
  ls.label AS source_label,
  ls.category AS source_category,
  COUNT(l.id) AS total_leads,
  COUNT(l.id) FILTER (WHERE ps.slug = 'converted') AS converted_leads,
  ROUND(
    COUNT(l.id) FILTER (WHERE ps.slug = 'converted')::numeric
    / NULLIF(COUNT(l.id)::numeric, 0) * 100, 2
  ) AS conversion_rate
FROM public.lead_sources ls
LEFT JOIN public.leads l ON l.source_id = ls.id AND l.archived_at IS NULL
LEFT JOIN public.lead_pipeline_statuses ps ON l.status_id = ps.id
GROUP BY ls.id, ls.slug, ls.label, ls.category;

CREATE OR REPLACE VIEW public.v_lead_reminders_due AS
SELECT
  r.id AS reminder_id,
  r.lead_id,
  r.conseiller_id,
  r.reminder_at,
  r.note,
  r.created_at,
  l.first_name AS lead_first_name,
  l.last_name AS lead_last_name,
  l.phone AS lead_phone,
  CASE
    WHEN r.reminder_at < now() THEN true
    ELSE false
  END AS is_overdue
FROM public.lead_reminders r
JOIN public.leads l ON l.id = r.lead_id
WHERE r.treated = false
  AND l.archived_at IS NULL
ORDER BY r.reminder_at ASC;


-- ============================================================================
-- FONCTIONS utilitaires
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_leads_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_leads_updated_at
  BEFORE UPDATE ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.update_leads_updated_at();

CREATE TRIGGER trg_lead_tasks_updated_at
  BEFORE UPDATE ON public.lead_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.update_leads_updated_at();


-- ============================================================================
-- SEED DATA : Sources
-- ============================================================================

INSERT INTO public.lead_sources (slug, label, category, icon, display_order) VALUES
  ('facebook',         'Facebook',               'digital', 'facebook',         1),
  ('instagram',        'Instagram',              'digital', 'instagram',        2),
  ('google_ads',       'Google Ads',             'digital', 'google',           3),
  ('website',          'Site internet',          'digital', 'language',         4),
  ('form',             'Formulaire',             'digital', 'description',      5),
  ('whatsapp',         'WhatsApp',               'digital', 'chat',             6),
  ('chatbot',          'Chatbot',                'digital', 'smart_toy',        7),
  ('referral',         'Recommandation client',  'human',   'people',           8),
  ('partner',          'Partenaire',             'human',   'handshake',        9),
  ('employee',         'Salarié',                'human',   'badge',            10),
  ('event',            'Événement',              'human',   'event',            11),
  ('tradeshow',        'Salon',                  'human',   'storefront',       12),
  ('inbound_call',     'Appel entrant',          'other',   'phone_callback',   13),
  ('email_inbound',    'Email',                  'other',   'email',            14),
  ('external_db',      'Base de données externe','other',   'database',         15)
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- SEED DATA : Pipeline Statuses
-- ============================================================================

INSERT INTO public.lead_pipeline_statuses (slug, label, color, display_order, is_terminal) VALUES
  ('new',               'Nouveau lead',           '#3B82F6', 1, false),
  ('contacted',         'Lead contacté',          '#8B5CF6', 2, false),
  ('in_discussion',     'En discussion',          '#F59E0B', 3, false),
  ('interested',        'Intéressé',              '#10B981', 4, false),
  ('quote_sent',        'Devis envoyé',           '#6366F1', 5, false),
  ('waiting_response',  'En attente de réponse',  '#F97316', 6, false),
  ('converted',         'Converti (client)',       '#22C55E', 7, true),
  ('lost',              'Perdu',                  '#EF4444', 8, true)
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- SEED DATA : Score Rules
-- ============================================================================

INSERT INTO public.lead_score_rules (name, condition_field, condition_operator, condition_value, score_delta) VALUES
  ('Demande urgente',          'urgency',        'equals',   'critical',  30),
  ('Urgence haute',            'urgency',        'equals',   'high',      20),
  ('Budget elevé',             'estimated_budget','contains', 'high',      20),
  ('Recommandation client',    'source_slug',    'equals',   'referral',  10),
  ('Visite du site',           'source_slug',    'equals',   'website',   5),
  ('Lead chaud',               'interest_level', 'equals',   'hot',       25),
  ('Lead tiede',               'interest_level', 'equals',   'warm',      10),
  ('Appel entrant',            'source_slug',    'equals',   'inbound_call', 15)
ON CONFLICT DO NOTHING;
