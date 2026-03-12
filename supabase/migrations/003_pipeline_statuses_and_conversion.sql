-- Migration: Pipeline statuses update, conversion fields, last call denormalized data

-- 1. Rename / reorder pipeline statuses
UPDATE public.lead_pipeline_statuses SET display_order = 0 WHERE slug = 'new';
UPDATE public.lead_pipeline_statuses SET slug = 'no_answer', label = 'Ne répond pas', color = '#EF4444', display_order = 1, is_terminal = false WHERE slug = 'contacted';
UPDATE public.lead_pipeline_statuses SET slug = 'to_recall', label = 'À rappeler', color = '#F59E0B', display_order = 2, is_terminal = false WHERE slug = 'discussion';
UPDATE public.lead_pipeline_statuses SET slug = 'to_finalize', label = 'À finaliser', color = '#8B5CF6', display_order = 3, is_terminal = false WHERE slug = 'waiting_response';
UPDATE public.lead_pipeline_statuses SET display_order = 4, is_terminal = true WHERE slug = 'converted';
UPDATE public.lead_pipeline_statuses SET label = 'Pas intéressé (Perdu)', color = '#6B7280', display_order = 5, is_terminal = true WHERE slug = 'lost';

-- 2. Move ALL leads that reference a status about to be deleted → fallback to 'to_recall'
--    This catches any slug we didn't anticipate (interested, quote_sent, devis_envoye, etc.)
UPDATE public.leads
SET status_id = (SELECT id FROM public.lead_pipeline_statuses WHERE slug = 'to_recall' LIMIT 1)
WHERE status_id IS NOT NULL
  AND status_id NOT IN (
    SELECT id FROM public.lead_pipeline_statuses
    WHERE slug IN ('new', 'no_answer', 'to_recall', 'to_finalize', 'converted', 'lost')
  );

-- 3. Also handle leads with NULL or dangling status_id → set to 'new'
UPDATE public.leads
SET status_id = (SELECT id FROM public.lead_pipeline_statuses WHERE slug = 'new' LIMIT 1)
WHERE status_id IS NULL
   OR status_id NOT IN (SELECT id FROM public.lead_pipeline_statuses);

-- 4. Now safe to delete unused statuses
DELETE FROM public.lead_pipeline_statuses
WHERE slug NOT IN ('new', 'no_answer', 'to_recall', 'to_finalize', 'converted', 'lost');

-- 5. Add conversion fields to leads
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS conversion_plan text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS subscription_type text;

-- 6. Add last call denormalized fields for pipeline card display
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS last_call_summary text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS last_call_date timestamptz;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS last_call_by_name text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS next_reminder_at timestamptz;
