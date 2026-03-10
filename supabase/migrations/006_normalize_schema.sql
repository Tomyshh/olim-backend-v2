-- ============================================================================
-- Olim Backend: Supabase Migration 006
-- Normalisation: tables de reference, FK manquantes, vues enrichies
-- ============================================================================
-- NOTE: Lookup tables and FK columns already exist from a previous partial run.
-- This migration focuses on populating remaining FK data and creating views.
-- ============================================================================

-- ============================================================================
-- SECTION 1: Tables de reference (lookup) - CREATE IF NOT EXISTS + seed
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.document_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  label_he text,
  description text,
  display_order integer DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.membership_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  is_paid boolean NOT NULL DEFAULT true,
  display_order integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.plan_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.request_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  parent_id uuid REFERENCES public.request_categories(id),
  display_order integer DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.request_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  display_order integer DEFAULT 0,
  is_terminal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.relationship_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  display_order integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seed data (idempotent)
INSERT INTO public.document_types (slug, label, display_order) VALUES
  ('teudat_zehut',      'Teoudat Zehout',            1),
  ('teudat_ole',        'Teoudat Ole',               2),
  ('passeport',         'Passeport',                  3),
  ('passeport_etranger','Passeport etranger',         4),
  ('permis_conduire',   'Permis de conduire',         5),
  ('carte_identite',    'Carte d''identite',          6),
  ('carte_credit',      'Carte de credit',            7),
  ('carte_grise',       'Carte grise',                8),
  ('carte_koupat_holim','Carte Koupat Holim',         9),
  ('contrat_location',  'Contrat de location',       10),
  ('compteur_eau',      'Compteur d''eau',           11),
  ('compteur_gaz',      'Compteur de gaz',           12),
  ('compteur_electricite','Compteur d''electricite', 13),
  ('facture_arnona',    'Facture d''Arnona',         14),
  ('facture_eau',       'Facture d''eau',            15),
  ('facture_gaz',       'Facture de gaz',            16),
  ('facture_electricite','Facture d''electricite',   17),
  ('facture_telephone', 'Facture de telephone',      18),
  ('fiche_paie',        'Fiche de paie',             19),
  ('releve_bancaire',   'Releve bancaire',           20),
  ('rib',               'RIB',                       21),
  ('sefah',             'Sefah',                     22),
  ('acte_naissance',    'Acte de naissance',         23),
  ('assurance_auto',    'Assurance automobile',      24),
  ('assurance_habitation','Assurance habitation',    25),
  ('attestation_travail','Attestation de travail',   26),
  ('document_medical',  'Document medical',          27),
  ('ordonnance',        'Ordonnance',                28),
  ('photos_identite',   'Photos d''identite',        29),
  ('justificatif_revenus','Justificatif de revenus', 30),
  ('diplome',           'Diplome',                   31),
  ('profile_photo',     'Photo de profil',           32),
  ('request_attachment','Piece jointe de demande',   33),
  ('autre',             'Autre',                     99)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.membership_types (slug, label, is_paid, display_order) VALUES
  ('visitor',       'Visitor',       false, 0),
  ('free',          'Free',          false, 1),
  ('pack_start',    'Pack Start',    true,  2),
  ('pack_essential','Pack Essential', true,  3),
  ('pack_vip',      'Pack VIP',      true,  4),
  ('pack_elite',    'Pack Elite',    true,  5)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.plan_types (slug, label) VALUES
  ('monthly', 'Mensuel'),
  ('annual',  'Annuel')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.request_statuses (slug, label, display_order, is_terminal) VALUES
  ('pending',      'En attente',         1, false),
  ('assigned',     'Assigne',            2, false),
  ('in_progress',  'En cours',           3, false),
  ('waiting_info', 'Attente info client', 4, false),
  ('completed',    'Termine',            5, true),
  ('closed',       'Ferme',              6, true),
  ('cancelled',    'Annule',             7, true)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.relationship_types (slug, label, display_order) VALUES
  ('account_owner', 'Titulaire du compte', 1),
  ('conjoint',      'Conjoint(e)',         2),
  ('parent',        'Parent',              3),
  ('child',         'Enfant',              4),
  ('sibling',       'Frere/Soeur',         5),
  ('grandparent',   'Grand-parent',        6),
  ('other',         'Autre',               99)
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- SECTION 2: FK columns (ADD IF NOT EXISTS is idempotent)
-- ============================================================================

ALTER TABLE public.client_documents ADD COLUMN IF NOT EXISTS document_type_id uuid REFERENCES public.document_types(id);
ALTER TABLE public.client_documents ADD COLUMN IF NOT EXISTS family_member_id uuid REFERENCES public.family_members(id);
CREATE INDEX IF NOT EXISTS idx_client_documents_type ON public.client_documents (document_type_id);
CREATE INDEX IF NOT EXISTS idx_client_documents_member ON public.client_documents (family_member_id);

ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS membership_type_id uuid REFERENCES public.membership_types(id);

ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS membership_type_id uuid REFERENCES public.membership_types(id);
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS plan_type_id uuid REFERENCES public.plan_types(id);

ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS relationship_type_id uuid REFERENCES public.relationship_types(id);
ALTER TABLE public.family_members ADD COLUMN IF NOT EXISTS selected_card_uuid uuid REFERENCES public.payment_credentials(id);

ALTER TABLE public.chatcc ADD COLUMN IF NOT EXISTS client_uuid uuid REFERENCES public.clients(id);
ALTER TABLE public.chatcc ADD COLUMN IF NOT EXISTS counselor_uuid uuid REFERENCES public.conseillers_v2(id);
CREATE INDEX IF NOT EXISTS idx_chatcc_client_uuid ON public.chatcc (client_uuid);
CREATE INDEX IF NOT EXISTS idx_chatcc_counselor_uuid ON public.chatcc (counselor_uuid);

ALTER TABLE public.chatcc_messages ADD COLUMN IF NOT EXISTS client_uuid uuid REFERENCES public.clients(id);

ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS sender_client_id uuid REFERENCES public.clients(id);

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS conseiller_uuid uuid REFERENCES public.conseillers_v2(id);
CREATE INDEX IF NOT EXISTS idx_leads_conseiller_uuid ON public.leads (conseiller_uuid);

ALTER TABLE public.lead_interactions ADD COLUMN IF NOT EXISTS conseiller_uuid uuid REFERENCES public.conseillers_v2(id);
ALTER TABLE public.lead_reminders ADD COLUMN IF NOT EXISTS conseiller_uuid uuid REFERENCES public.conseillers_v2(id);
ALTER TABLE public.lead_tasks ADD COLUMN IF NOT EXISTS responsible_uuid uuid REFERENCES public.conseillers_v2(id);
ALTER TABLE public.lead_assignment_rules ADD COLUMN IF NOT EXISTS conseiller_uuid uuid REFERENCES public.conseillers_v2(id);
ALTER TABLE public.lead_attachments ADD COLUMN IF NOT EXISTS uploaded_by_uuid uuid REFERENCES public.conseillers_v2(id);

ALTER TABLE public.client_activity_history ADD COLUMN IF NOT EXISTS client_uuid uuid REFERENCES public.clients(id);
ALTER TABLE public.refund_requests ADD COLUMN IF NOT EXISTS reviewed_by_uuid uuid REFERENCES public.conseillers_v2(id);
ALTER TABLE public.appointments ADD COLUMN IF NOT EXISTS slot_uuid uuid REFERENCES public.available_slots(id);

-- ============================================================================
-- SECTION 3: Populate FK from existing text data (idempotent: WHERE ... IS NULL)
-- ============================================================================

-- subscriptions.membership_type_id
UPDATE public.subscriptions s
SET membership_type_id = mt.id
FROM public.membership_types mt
WHERE s.membership_type_id IS NULL
  AND s.membership_type IS NOT NULL
  AND LOWER(REPLACE(s.membership_type, ' ', '_')) = mt.slug;

-- subscriptions.plan_type_id (with normalization of typos)
UPDATE public.subscriptions s
SET plan_type_id = pt.id
FROM public.plan_types pt
WHERE s.plan_type_id IS NULL
  AND s.plan_type IS NOT NULL
  AND (
    LOWER(s.plan_type) = pt.slug
    OR (LOWER(s.plan_type) IN ('annualy', 'anually') AND pt.slug = 'annual')
    OR (LOWER(s.plan_type) = 'free' AND pt.slug = 'monthly')
  );

-- chatcc.client_uuid
UPDATE public.chatcc cc
SET client_uuid = c.id
FROM public.clients c
WHERE cc.client_uuid IS NULL
  AND cc.client_id IS NOT NULL
  AND c.firebase_uid = cc.client_id;

-- chatcc.counselor_uuid
UPDATE public.chatcc cc
SET counselor_uuid = cv.id
FROM public.conseillers_v2 cv
WHERE cc.counselor_uuid IS NULL
  AND cc.counselor_id IS NOT NULL
  AND cv.firestore_id = cc.counselor_id;

-- chatcc_messages.client_uuid
UPDATE public.chatcc_messages cm
SET client_uuid = c.id
FROM public.clients c
WHERE cm.client_uuid IS NULL
  AND cm.client_id IS NOT NULL
  AND c.firebase_uid = cm.client_id;

-- leads.conseiller_uuid
UPDATE public.leads l
SET conseiller_uuid = cv.id
FROM public.conseillers_v2 cv
WHERE l.conseiller_uuid IS NULL
  AND l.conseiller_id IS NOT NULL
  AND cv.firestore_id = l.conseiller_id;

-- lead_interactions.conseiller_uuid
UPDATE public.lead_interactions li
SET conseiller_uuid = cv.id
FROM public.conseillers_v2 cv
WHERE li.conseiller_uuid IS NULL
  AND li.conseiller_id IS NOT NULL
  AND cv.firestore_id = li.conseiller_id;

-- lead_reminders.conseiller_uuid
UPDATE public.lead_reminders lr
SET conseiller_uuid = cv.id
FROM public.conseillers_v2 cv
WHERE lr.conseiller_uuid IS NULL
  AND lr.conseiller_id IS NOT NULL
  AND cv.firestore_id = lr.conseiller_id;

-- lead_tasks.responsible_uuid
UPDATE public.lead_tasks lt
SET responsible_uuid = cv.id
FROM public.conseillers_v2 cv
WHERE lt.responsible_uuid IS NULL
  AND lt.responsible_id IS NOT NULL
  AND cv.firestore_id = lt.responsible_id;

-- lead_assignment_rules.conseiller_uuid
UPDATE public.lead_assignment_rules lar
SET conseiller_uuid = cv.id
FROM public.conseillers_v2 cv
WHERE lar.conseiller_uuid IS NULL
  AND lar.conseiller_id IS NOT NULL
  AND cv.firestore_id = lar.conseiller_id;

-- lead_attachments.uploaded_by_uuid
UPDATE public.lead_attachments la
SET uploaded_by_uuid = cv.id
FROM public.conseillers_v2 cv
WHERE la.uploaded_by_uuid IS NULL
  AND la.uploaded_by IS NOT NULL
  AND cv.firestore_id = la.uploaded_by;

-- client_activity_history.client_uuid
UPDATE public.client_activity_history cah
SET client_uuid = c.id
FROM public.clients c
WHERE cah.client_uuid IS NULL
  AND cah.client_id IS NOT NULL
  AND c.firebase_uid = cah.client_id;

-- client_documents.document_type_id (fuzzy match for remaining)
UPDATE public.client_documents cd
SET document_type_id = dt.id
FROM public.document_types dt
WHERE cd.document_type_id IS NULL
  AND cd.document_type IS NOT NULL
  AND (
    (LOWER(cd.document_type) LIKE '%teoudat z%' AND dt.slug = 'teudat_zehut')
    OR (LOWER(cd.document_type) LIKE '%teudat z%' AND dt.slug = 'teudat_zehut')
    OR (LOWER(cd.document_type) LIKE '%תעודת זהות%' AND dt.slug = 'teudat_zehut')
    OR (LOWER(cd.document_type) LIKE '%teoudat ol%' AND dt.slug = 'teudat_ole')
    OR (LOWER(cd.document_type) LIKE '%passeport%' AND LOWER(cd.document_type) NOT LIKE '%etranger%' AND LOWER(cd.document_type) NOT LIKE '%franc%' AND dt.slug = 'passeport')
    OR (LOWER(cd.document_type) IN ('passport') AND dt.slug = 'passeport')
    OR (LOWER(cd.document_type) LIKE '%passeport etranger%' AND dt.slug = 'passeport_etranger')
    OR (LOWER(cd.document_type) LIKE '%passeport fran%' AND dt.slug = 'passeport_etranger')
    OR (LOWER(cd.document_type) LIKE '%permis de conduire%' AND dt.slug = 'permis_conduire')
    OR (LOWER(cd.document_type) IN ('driving license') AND dt.slug = 'permis_conduire')
    OR (LOWER(cd.document_type) LIKE '%carte de cr%' AND dt.slug = 'carte_credit')
    OR (LOWER(cd.document_type) LIKE '%credit card%' AND dt.slug = 'carte_credit')
    OR (LOWER(cd.document_type) LIKE '%carte d''identit%' AND dt.slug = 'carte_identite')
    OR (LOWER(cd.document_type) LIKE '%carte grise%' AND dt.slug = 'carte_grise')
    OR (LOWER(cd.document_type) LIKE '%vehicle registration%' AND dt.slug = 'carte_grise')
    OR (LOWER(cd.document_type) LIKE '%koupat%' AND dt.slug = 'carte_koupat_holim')
    OR (LOWER(cd.document_type) LIKE '%health fund%' AND dt.slug = 'carte_koupat_holim')
    OR (LOWER(cd.document_type) LIKE '%contrat de location%' AND dt.slug = 'contrat_location')
    OR (LOWER(cd.document_type) LIKE '%rental contract%' AND dt.slug = 'contrat_location')
    OR (LOWER(cd.document_type) LIKE '%compteur d''eau%' AND dt.slug = 'compteur_eau')
    OR (LOWER(cd.document_type) LIKE '%water meter%' AND dt.slug = 'compteur_eau')
    OR (LOWER(cd.document_type) LIKE '%compteur de gaz%' AND dt.slug = 'compteur_gaz')
    OR (LOWER(cd.document_type) LIKE '%compteur%gaz%' AND dt.slug = 'compteur_gaz')
    OR (LOWER(cd.document_type) LIKE '%compteur d''%lectricit%' AND dt.slug = 'compteur_electricite')
    OR (LOWER(cd.document_type) LIKE '%electricity meter%' AND dt.slug = 'compteur_electricite')
    OR (LOWER(cd.document_type) LIKE '%arnona%' AND dt.slug = 'facture_arnona')
    OR (LOWER(cd.document_type) LIKE '%facture d''eau%' AND dt.slug = 'facture_eau')
    OR (LOWER(cd.document_type) LIKE '%facture de gaz%' AND dt.slug = 'facture_gaz')
    OR (LOWER(cd.document_type) LIKE '%facture d''%lectricit%' AND dt.slug = 'facture_electricite')
    OR (LOWER(cd.document_type) LIKE '%electricity bill%' AND dt.slug = 'facture_electricite')
    OR (LOWER(cd.document_type) LIKE '%facture%t%l%phone%' AND dt.slug = 'facture_telephone')
    OR (LOWER(cd.document_type) LIKE '%fiche de paie%' AND dt.slug = 'fiche_paie')
    OR (LOWER(cd.document_type) LIKE '%bulletin%salaire%' AND dt.slug = 'fiche_paie')
    OR (LOWER(cd.document_type) LIKE '%relev%bancaire%' AND dt.slug = 'releve_bancaire')
    OR (LOWER(cd.document_type) LIKE '%relev%compte%' AND dt.slug = 'releve_bancaire')
    OR (LOWER(cd.document_type) = 'rib' AND dt.slug = 'rib')
    OR (LOWER(cd.document_type) LIKE '%sefah%' AND dt.slug = 'sefah')
    OR (LOWER(cd.document_type) LIKE '%acte de naissance%' AND dt.slug = 'acte_naissance')
    OR (LOWER(cd.document_type) LIKE '%assurance auto%' AND dt.slug = 'assurance_auto')
    OR (LOWER(cd.document_type) LIKE '%assurance habitation%' AND dt.slug = 'assurance_habitation')
    OR (LOWER(cd.document_type) LIKE '%home insurance%' AND dt.slug = 'assurance_habitation')
    OR (LOWER(cd.document_type) LIKE '%attestation%travail%' AND dt.slug = 'attestation_travail')
    OR (LOWER(cd.document_type) LIKE '%ordonnance%' AND dt.slug = 'ordonnance')
    OR (LOWER(cd.document_type) LIKE '%photos d''identit%' AND dt.slug = 'photos_identite')
    OR (LOWER(cd.document_type) LIKE '%justificatif%revenus%' AND dt.slug = 'justificatif_revenus')
    OR (LOWER(cd.document_type) LIKE '%dipl%' AND dt.slug = 'diplome')
    OR (LOWER(cd.document_type) LIKE '%document m%dic%' AND dt.slug = 'document_medical')
    OR (LOWER(cd.document_type) LIKE '%attestation m%dic%' AND dt.slug = 'document_medical')
    OR (LOWER(cd.document_type) LIKE '%rapport%m%dic%' AND dt.slug = 'document_medical')
  );

-- Remaining unmatched → 'autre'
UPDATE public.client_documents cd
SET document_type_id = (SELECT id FROM public.document_types WHERE slug = 'autre')
WHERE cd.document_type_id IS NULL
  AND cd.document_type IS NOT NULL;

-- family_members.relationship_type_id
UPDATE public.family_members fm
SET relationship_type_id = rt.id
FROM public.relationship_types rt
WHERE fm.relationship_type_id IS NULL
  AND fm.status IS NOT NULL
  AND (
    (LOWER(fm.status) LIKE '%account owner%' AND rt.slug = 'account_owner')
    OR (LOWER(fm.status) IN ('conjoint','conjoin','spouse','partner','mari') AND rt.slug = 'conjoint')
    OR (LOWER(fm.status) LIKE '%conjoint%' AND rt.slug = 'conjoint')
    OR (LOWER(fm.status) IN ('child','boy','girl','daughter','fille','fils','garçon','beau fils') AND rt.slug = 'child')
    OR (LOWER(fm.status) IN ('father','mother','mere','mère','pere','père','parent') AND rt.slug = 'parent')
    OR (LOWER(fm.status) LIKE '%mere%' AND rt.slug = 'parent')
    OR (LOWER(fm.status) LIKE '%pere%' AND rt.slug = 'parent')
    OR (LOWER(fm.status) LIKE '%grand%' AND rt.slug = 'grandparent')
    OR (LOWER(fm.status) LIKE '%soeur%' AND rt.slug = 'sibling')
  );

-- Unmatched → 'other'
UPDATE public.family_members fm
SET relationship_type_id = (SELECT id FROM public.relationship_types WHERE slug = 'other')
WHERE fm.relationship_type_id IS NULL
  AND fm.status IS NOT NULL;

-- ============================================================================
-- SECTION 4: Enriched views
-- ============================================================================

CREATE OR REPLACE VIEW public.v_client_documents_enriched AS
SELECT
  cd.*,
  dt.slug AS document_type_slug,
  dt.label AS document_type_label,
  fm.first_name AS family_member_first_name,
  fm.last_name AS family_member_last_name
FROM public.client_documents cd
LEFT JOIN public.document_types dt ON cd.document_type_id = dt.id
LEFT JOIN public.family_members fm ON cd.family_member_id = fm.id;

CREATE OR REPLACE VIEW public.v_chatcc_enriched AS
SELECT
  cc.*,
  c.email AS client_email,
  c.first_name AS client_first_name,
  c.last_name AS client_last_name,
  cv.name AS counselor_resolved_name,
  cv.email AS counselor_email
FROM public.chatcc cc
LEFT JOIN public.clients c ON cc.client_uuid = c.id
LEFT JOIN public.conseillers_v2 cv ON cc.counselor_uuid = cv.id;

CREATE OR REPLACE VIEW public.v_leads_enriched AS
SELECT
  l.*,
  cv.name AS conseiller_name_resolved,
  cv.email AS conseiller_email,
  ls.label AS source_label,
  lps.label AS status_label
FROM public.leads l
LEFT JOIN public.conseillers_v2 cv ON l.conseiller_uuid = cv.id
LEFT JOIN public.lead_sources ls ON l.source_id = ls.id
LEFT JOIN public.lead_pipeline_statuses lps ON l.status_id = lps.id;

CREATE OR REPLACE VIEW public.v_subscriptions_enriched AS
SELECT
  s.*,
  mt.label AS membership_label,
  mt.slug AS membership_slug,
  mt.is_paid AS membership_is_paid,
  pt.label AS plan_label,
  pt.slug AS plan_slug,
  c.email AS client_email,
  c.first_name AS client_first_name,
  c.last_name AS client_last_name
FROM public.subscriptions s
LEFT JOIN public.membership_types mt ON s.membership_type_id = mt.id
LEFT JOIN public.plan_types pt ON s.plan_type_id = pt.id
LEFT JOIN public.clients c ON s.client_id = c.id;

CREATE OR REPLACE VIEW public.v_family_members_enriched AS
SELECT
  fm.*,
  rt.label AS relationship_label,
  rt.slug AS relationship_slug,
  c.email AS client_email,
  c.first_name AS owner_first_name,
  c.last_name AS owner_last_name
FROM public.family_members fm
LEFT JOIN public.relationship_types rt ON fm.relationship_type_id = rt.id
LEFT JOIN public.clients c ON fm.client_id = c.id;

-- ============================================================================
-- SECTION 5: RLS on lookup tables
-- ============================================================================

DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'document_types','membership_types','plan_types',
      'request_categories','request_statuses','relationship_types'
    ])
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'allow_service_role_' || tbl, tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      'allow_service_role_' || tbl, tbl
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'allow_anon_select_' || tbl, tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO anon USING (true)',
      'allow_anon_select_' || tbl, tbl
    );
  END LOOP;
END $$;
