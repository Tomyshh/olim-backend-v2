-- Index unique pour le dual-write family_members (client_id, firestore_id).
-- Requise pour upsert dans dualWriteFamilyMember.
-- Partial: uniquement pour les lignes avec firestore_id (évite conflit avec membres créés via /api/profile).
CREATE UNIQUE INDEX IF NOT EXISTS idx_family_members_client_firestore_id
  ON public.family_members (client_id, firestore_id)
  WHERE firestore_id IS NOT NULL;
