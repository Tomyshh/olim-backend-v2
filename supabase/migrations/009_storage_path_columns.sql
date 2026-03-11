-- ============================================================================
-- Migration 009: Add Supabase Storage path tracking columns
-- ============================================================================

ALTER TABLE public.client_documents
  ADD COLUMN IF NOT EXISTS supabase_storage_path text,
  ADD COLUMN IF NOT EXISTS supabase_storage_bucket text;

CREATE INDEX IF NOT EXISTS idx_client_documents_supabase_path
  ON public.client_documents (supabase_storage_bucket, supabase_storage_path)
  WHERE supabase_storage_path IS NOT NULL;

DROP VIEW IF EXISTS public.v_client_documents_enriched;
CREATE VIEW public.v_client_documents_enriched AS
SELECT
  cd.*,
  dt.label  AS document_type_label,
  dt.slug   AS document_type_slug,
  c.firebase_uid AS client_firebase_uid,
  c.first_name   AS client_first_name,
  c.last_name    AS client_last_name,
  fm.first_name  AS family_member_first_name,
  fm.last_name   AS family_member_last_name
FROM public.client_documents cd
LEFT JOIN public.document_types dt ON dt.id = cd.document_type_id
LEFT JOIN public.clients        c  ON c.id  = cd.client_id
LEFT JOIN public.family_members fm ON fm.id = cd.family_member_id;
