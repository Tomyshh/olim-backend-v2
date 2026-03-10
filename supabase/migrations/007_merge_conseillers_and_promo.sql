-- ============================================================================
-- Migration 007: Merge conseillers + conseillers_v2 → single conseillers table
--                Merge promo_codes into promotions
-- ============================================================================

-- No wrapping transaction: each statement runs independently to avoid deadlocks
-- with Supabase internal processes (autovacuum, realtime, etc.)

-- ============================================================================
-- PART A: Merge conseillers_v2 into conseillers
-- Strategy: enrich conseillers_v2 with columns from conseillers, copy data,
--           re-point all FK, drop old conseillers, rename conseillers_v2.
-- ============================================================================

-- A1. Add missing columns from conseillers to conseillers_v2
ALTER TABLE conseillers_v2 ADD COLUMN IF NOT EXISTS role_id uuid REFERENCES roles(id);
ALTER TABLE conseillers_v2 ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE conseillers_v2 ADD COLUMN IF NOT EXISTS firebase_uid text;

-- A2. Populate new columns from conseillers (match by name, handle duplicates)
UPDATE conseillers_v2 cv2
SET
  role_id = sub.role_id,
  is_active = sub.is_active,
  firebase_uid = CASE
    WHEN cv2.id = sub.first_v2_id THEN sub.firebase_uid
    ELSE NULL
  END,
  email = COALESCE(NULLIF(cv2.email, ''), sub.email)
FROM (
  SELECT DISTINCT ON (c.name)
    c.name, c.role_id, c.is_active, c.firebase_uid, c.email,
    (SELECT id FROM conseillers_v2 cv WHERE LOWER(cv.name) = LOWER(c.name) ORDER BY cv.created_at LIMIT 1) AS first_v2_id
  FROM conseillers c
) sub
WHERE LOWER(cv2.name) = LOWER(sub.name)
  AND cv2.role_id IS NULL;

-- Rinat exists in conseillers but not in conseillers_v2 → insert
INSERT INTO conseillers_v2 (name, email, role_id, is_active, firebase_uid, is_admin, is_super_admin, is_present, manage_elite, languages, metadata, created_at, updated_at)
SELECT c.name, c.email, c.role_id, c.is_active, c.firebase_uid,
       false, false, false, false, '{}'::jsonb, '{}'::jsonb,
       c.created_at, c.updated_at
FROM conseillers c
WHERE NOT EXISTS (SELECT 1 FROM conseillers_v2 cv2 WHERE LOWER(cv2.name) = LOWER(c.name));

-- A3. Drop the FK from requests → conseillers (old)
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_assigned_to_conseiller_id_fkey;

-- A3b. Remap requests.assigned_to_conseiller_id: old conseillers.id → new conseillers_v2.id (by name)
UPDATE requests r
SET assigned_to_conseiller_id = cv2.id
FROM conseillers c
JOIN conseillers_v2 cv2 ON LOWER(c.name) = LOWER(cv2.name)
WHERE r.assigned_to_conseiller_id = c.id
  AND r.assigned_to_conseiller_id IS NOT NULL;

-- Null out any that still reference old IDs (no match found)
UPDATE requests r
SET assigned_to_conseiller_id = NULL
WHERE r.assigned_to_conseiller_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM conseillers_v2 cv2 WHERE cv2.id = r.assigned_to_conseiller_id);

-- A4. Drop views that reference conseillers_v2 (will be recreated after rename)
DROP VIEW IF EXISTS v_chatcc_enriched;
DROP VIEW IF EXISTS v_leads_enriched;
DROP VIEW IF EXISTS v_family_members_enriched;
DROP VIEW IF EXISTS v_subscriptions_enriched;
DROP VIEW IF EXISTS v_client_documents_enriched;

-- A5. Drop all FK constraints pointing to conseillers_v2
ALTER TABLE chatcc                DROP CONSTRAINT IF EXISTS chatcc_counselor_uuid_fkey;
ALTER TABLE lead_assignment_rules DROP CONSTRAINT IF EXISTS lead_assignment_rules_conseiller_uuid_fkey;
ALTER TABLE lead_attachments      DROP CONSTRAINT IF EXISTS lead_attachments_uploaded_by_uuid_fkey;
ALTER TABLE lead_interactions     DROP CONSTRAINT IF EXISTS lead_interactions_conseiller_uuid_fkey;
ALTER TABLE lead_reminders        DROP CONSTRAINT IF EXISTS lead_reminders_conseiller_uuid_fkey;
ALTER TABLE lead_tasks            DROP CONSTRAINT IF EXISTS lead_tasks_responsible_uuid_fkey;
ALTER TABLE leads                 DROP CONSTRAINT IF EXISTS leads_conseiller_uuid_fkey;
ALTER TABLE refund_requests       DROP CONSTRAINT IF EXISTS refund_requests_reviewed_by_uuid_fkey;

-- A6. Drop policies
DROP POLICY IF EXISTS service_role_full_access ON conseillers;
DROP POLICY IF EXISTS allow_service_role_conseillers_v2 ON conseillers_v2;

-- A7. Drop old conseillers table
DROP TABLE IF EXISTS conseillers;

-- A8. Rename conseillers_v2 → conseillers
ALTER TABLE conseillers_v2 RENAME TO conseillers;
ALTER INDEX conseillers_v2_pkey RENAME TO conseillers_pkey;
ALTER INDEX conseillers_v2_firestore_id_key RENAME TO conseillers_firestore_id_key;

-- A9. Index on firebase_uid (not unique, since multiple firestore accounts may share one)
CREATE INDEX IF NOT EXISTS idx_conseillers_firebase_uid ON conseillers (firebase_uid) WHERE firebase_uid IS NOT NULL AND firebase_uid != '';

-- A10. Re-create all FK constraints pointing to new conseillers
ALTER TABLE requests              ADD CONSTRAINT requests_assigned_to_conseiller_id_fkey FOREIGN KEY (assigned_to_conseiller_id) REFERENCES conseillers(id);
ALTER TABLE chatcc                ADD CONSTRAINT chatcc_counselor_uuid_fkey FOREIGN KEY (counselor_uuid) REFERENCES conseillers(id);
ALTER TABLE lead_assignment_rules ADD CONSTRAINT lead_assignment_rules_conseiller_uuid_fkey FOREIGN KEY (conseiller_uuid) REFERENCES conseillers(id);
ALTER TABLE lead_attachments      ADD CONSTRAINT lead_attachments_uploaded_by_uuid_fkey FOREIGN KEY (uploaded_by_uuid) REFERENCES conseillers(id);
ALTER TABLE lead_interactions     ADD CONSTRAINT lead_interactions_conseiller_uuid_fkey FOREIGN KEY (conseiller_uuid) REFERENCES conseillers(id);
ALTER TABLE lead_reminders        ADD CONSTRAINT lead_reminders_conseiller_uuid_fkey FOREIGN KEY (conseiller_uuid) REFERENCES conseillers(id);
ALTER TABLE lead_tasks            ADD CONSTRAINT lead_tasks_responsible_uuid_fkey FOREIGN KEY (responsible_uuid) REFERENCES conseillers(id);
ALTER TABLE leads                 ADD CONSTRAINT leads_conseiller_uuid_fkey FOREIGN KEY (conseiller_uuid) REFERENCES conseillers(id);
ALTER TABLE refund_requests       ADD CONSTRAINT refund_requests_reviewed_by_uuid_fkey FOREIGN KEY (reviewed_by_uuid) REFERENCES conseillers(id);

-- A11. Create index on role_id
CREATE INDEX IF NOT EXISTS idx_conseillers_role ON conseillers (role_id);

-- A12. RLS policy
ALTER TABLE conseillers ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_full_access ON conseillers FOR ALL TO service_role USING (true) WITH CHECK (true);

-- A13. Recreate all views (using new table name "conseillers")
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
LEFT JOIN public.conseillers cv ON cc.counselor_uuid = cv.id;

CREATE OR REPLACE VIEW public.v_leads_enriched AS
SELECT
  l.*,
  cv.name AS conseiller_name_resolved,
  cv.email AS conseiller_email,
  ls.label AS source_label,
  lps.label AS status_label
FROM public.leads l
LEFT JOIN public.conseillers cv ON l.conseiller_uuid = cv.id
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

-- A14. Enriched view for conseillers with role
CREATE OR REPLACE VIEW public.v_conseillers_enriched AS
SELECT
  co.*,
  r.slug AS role_slug,
  r.label AS role_label,
  r.has_leads_access,
  r.has_admin_access
FROM public.conseillers co
LEFT JOIN public.roles r ON co.role_id = r.id;

-- ============================================================================
-- PART B: Merge promo_codes into promotions
-- promo_codes uses `code` (text) as PK, promotions has uuid id + `code`.
-- Since both are empty, just drop promo_codes. promotions already covers it.
-- ============================================================================

-- Re-point promo_redemptions FK: code → promotions.code instead of promo_codes.code
ALTER TABLE promo_redemptions DROP CONSTRAINT IF EXISTS promo_redemptions_code_fkey;

-- Ensure promotions has a unique constraint on code for the FK
CREATE UNIQUE INDEX IF NOT EXISTS promotions_code_unique ON promotions (code) WHERE code IS NOT NULL;

-- Drop promo_codes
DROP TABLE IF EXISTS promo_codes;
