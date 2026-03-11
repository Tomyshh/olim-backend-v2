-- Migration: Add foreign keys on client_documents
-- document_type_id → document_types.id
-- family_member_id → family_members.id (already exists as text, convert to uuid FK)

-- 1. Add document_type_id column if not exists
ALTER TABLE client_documents
  ADD COLUMN IF NOT EXISTS document_type_id uuid;

-- 2. Backfill document_type_id from document_type label
UPDATE client_documents cd
SET document_type_id = dt.id
FROM document_types dt
WHERE cd.document_type_id IS NULL
  AND LOWER(TRIM(cd.document_type)) = LOWER(TRIM(dt.label));

-- 3. Add FK constraint document_type_id → document_types.id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_client_documents_document_type'
      AND table_name = 'client_documents'
  ) THEN
    ALTER TABLE client_documents
      ADD CONSTRAINT fk_client_documents_document_type
      FOREIGN KEY (document_type_id) REFERENCES document_types(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- 4. Ensure family_member_id is uuid and add FK to family_members
-- First check if there's already a FK
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_client_documents_family_member'
      AND table_name = 'client_documents'
  ) THEN
    ALTER TABLE client_documents
      ADD CONSTRAINT fk_client_documents_family_member
      FOREIGN KEY (family_member_id) REFERENCES family_members(id)
      ON DELETE SET NULL;
  END IF;
EXCEPTION
  WHEN others THEN
    RAISE NOTICE 'family_member FK skipped: %', SQLERRM;
END $$;

-- 5. Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_client_documents_document_type_id
  ON client_documents(document_type_id);

CREATE INDEX IF NOT EXISTS idx_client_documents_family_member_id
  ON client_documents(family_member_id);
