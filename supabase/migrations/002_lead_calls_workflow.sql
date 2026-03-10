-- Workflow d'appels CRM
-- Brouillons, validation, rappels liés et traçabilité des modifications.

ALTER TABLE public.lead_interactions
  ADD COLUMN IF NOT EXISTS is_draft boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS detailed_comment text,
  ADD COLUMN IF NOT EXISTS lead_answered boolean,
  ADD COLUMN IF NOT EXISTS reminder_at timestamptz,
  ADD COLUMN IF NOT EXISTS status_slug text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_by text,
  ADD COLUMN IF NOT EXISTS updated_by_name text,
  ADD COLUMN IF NOT EXISTS validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS validated_by text,
  ADD COLUMN IF NOT EXISTS validated_by_name text;

ALTER TABLE public.lead_reminders
  ADD COLUMN IF NOT EXISTS call_interaction_id uuid REFERENCES public.lead_interactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lead_interactions_call_workflow
  ON public.lead_interactions (lead_id, interaction_type, is_draft, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_reminders_call_interaction
  ON public.lead_reminders (call_interaction_id);

CREATE TABLE IF NOT EXISTS public.lead_interaction_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_interaction_id uuid NOT NULL REFERENCES public.lead_interactions(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  edited_by text NOT NULL,
  edited_by_name text,
  old_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_interaction_edits_interaction
  ON public.lead_interaction_edits (lead_interaction_id, created_at DESC);
