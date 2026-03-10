BEGIN;

ALTER TABLE public.partners
  ADD COLUMN IF NOT EXISTS vip boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS categorie text,
  ADD COLUMN IF NOT EXISTS partner_type text,
  ADD COLUMN IF NOT EXISTS adresse text,
  ADD COLUMN IF NOT EXISTS waze text,
  ADD COLUMN IF NOT EXISTS keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS subtitle jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS villes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS langues jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS images jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS icon text,
  ADD COLUMN IF NOT EXISTS icon_vip text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.partners
  DROP CONSTRAINT IF EXISTS partners_firestore_id_key;
ALTER TABLE public.partners
  ADD CONSTRAINT partners_firestore_id_key UNIQUE (firestore_id);

CREATE INDEX IF NOT EXISTS idx_partners_vip ON public.partners (vip);
CREATE INDEX IF NOT EXISTS idx_partners_categorie ON public.partners (categorie);
CREATE INDEX IF NOT EXISTS idx_partners_partner_type ON public.partners (partner_type);

UPDATE public.partners
SET is_active = true
WHERE is_active IS NULL;

ALTER TABLE public.partners
  ALTER COLUMN is_active SET DEFAULT true;
ALTER TABLE public.partners
  ALTER COLUMN is_active SET NOT NULL;

COMMIT;

