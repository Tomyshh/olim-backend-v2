-- ============================================================================
-- Olim Backend: Supabase Migration 004
-- Creates client_logs table for dual-write from Firestore Client Logs.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.client_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firestore_id text,
  client_id uuid REFERENCES public.clients(id),
  client_firebase_uid text,
  action text NOT NULL,
  description text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_logs_client_id ON public.client_logs (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_logs_action ON public.client_logs (action);

ALTER TABLE public.client_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_service_role_client_logs ON public.client_logs;
CREATE POLICY allow_service_role_client_logs ON public.client_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
