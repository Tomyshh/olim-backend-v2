-- ============================================================================
-- Migration 008: Supabase Storage Buckets
-- ============================================================================
-- Buckets:
--   1. client-documents  (prive) : docs identite, factures, contrats, etc.
--   2. chat-files        (prive) : fichiers partages dans les chats
--   3. request-files     (prive) : pieces jointes aux demandes clients
--   4. lead-attachments  (prive) : fichiers lies aux leads (conseillers only)
--   5. avatars           (public) : photos de profil clients/conseillers
-- ============================================================================

-- ============================================================================
-- 1. Create buckets
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('client-documents', 'client-documents', false, 20971520, -- 20 MB
    ARRAY['image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif',
          'application/pdf',
          'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
  )
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('chat-files', 'chat-files', false, 10485760, -- 10 MB
    ARRAY['image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif',
          'application/pdf',
          'audio/mpeg','audio/ogg','audio/wav','audio/mp4',
          'video/mp4','video/quicktime']
  )
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('request-files', 'request-files', false, 20971520, -- 20 MB
    ARRAY['image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif',
          'application/pdf',
          'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
  )
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('lead-attachments', 'lead-attachments', false, 20971520, -- 20 MB
    ARRAY['image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif',
          'application/pdf',
          'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
  )
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('avatars', 'avatars', true, 5242880, -- 5 MB
    ARRAY['image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif']
  )
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ============================================================================
-- 2. RLS Policies — client-documents
-- Path convention: {client_firebase_uid}/{document_type_slug}/{filename}
-- ============================================================================

-- Clients: read/upload/delete their own documents
CREATE POLICY "clients_own_documents_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'client-documents'
    AND (storage.foldername(name))[1] = (
      SELECT firebase_uid FROM public.clients
      WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY "clients_own_documents_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'client-documents'
    AND (storage.foldername(name))[1] = (
      SELECT firebase_uid FROM public.clients
      WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY "clients_own_documents_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'client-documents'
    AND (storage.foldername(name))[1] = (
      SELECT firebase_uid FROM public.clients
      WHERE auth_user_id = auth.uid()
    )
  );

-- Conseillers (service_role): full access to all client documents
CREATE POLICY "service_role_client_documents"
  ON storage.objects FOR ALL TO service_role
  USING (bucket_id = 'client-documents')
  WITH CHECK (bucket_id = 'client-documents');

-- ============================================================================
-- 3. RLS Policies — chat-files
-- Path convention: {chatcc_id}/{filename}
-- ============================================================================

-- Clients: read/upload chat files for their own chats
CREATE POLICY "clients_own_chat_files_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'chat-files'
    AND EXISTS (
      SELECT 1 FROM public.chatcc
      WHERE chatcc.id::text = (storage.foldername(name))[1]
        AND chatcc.client_uuid = (
          SELECT id FROM public.clients WHERE auth_user_id = auth.uid()
        )
    )
  );

CREATE POLICY "clients_own_chat_files_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'chat-files'
    AND EXISTS (
      SELECT 1 FROM public.chatcc
      WHERE chatcc.id::text = (storage.foldername(name))[1]
        AND chatcc.client_uuid = (
          SELECT id FROM public.clients WHERE auth_user_id = auth.uid()
        )
    )
  );

-- Conseillers: full access to chat files
CREATE POLICY "service_role_chat_files"
  ON storage.objects FOR ALL TO service_role
  USING (bucket_id = 'chat-files')
  WITH CHECK (bucket_id = 'chat-files');

-- ============================================================================
-- 4. RLS Policies — request-files
-- Path convention: {request_unique_id}/{filename}
-- ============================================================================

-- Clients: read/upload files for their own requests
CREATE POLICY "clients_own_request_files_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'request-files'
    AND EXISTS (
      SELECT 1 FROM public.requests
      WHERE requests.unique_id = (storage.foldername(name))[1]
        AND requests.client_id = (
          SELECT id FROM public.clients WHERE auth_user_id = auth.uid()
        )
    )
  );

CREATE POLICY "clients_own_request_files_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'request-files'
    AND EXISTS (
      SELECT 1 FROM public.requests
      WHERE requests.unique_id = (storage.foldername(name))[1]
        AND requests.client_id = (
          SELECT id FROM public.clients WHERE auth_user_id = auth.uid()
        )
    )
  );

-- Conseillers: full access
CREATE POLICY "service_role_request_files"
  ON storage.objects FOR ALL TO service_role
  USING (bucket_id = 'request-files')
  WITH CHECK (bucket_id = 'request-files');

-- ============================================================================
-- 5. RLS Policies — lead-attachments (conseillers only, no client access)
-- Path convention: {lead_id}/{filename}
-- ============================================================================

CREATE POLICY "service_role_lead_attachments"
  ON storage.objects FOR ALL TO service_role
  USING (bucket_id = 'lead-attachments')
  WITH CHECK (bucket_id = 'lead-attachments');

-- ============================================================================
-- 6. RLS Policies — avatars (public read, authenticated write own)
-- Path convention: {user_id}/{filename}
-- ============================================================================

CREATE POLICY "avatars_public_read"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'avatars');

CREATE POLICY "avatars_authenticated_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "avatars_authenticated_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "avatars_authenticated_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Service role: full access to avatars
CREATE POLICY "service_role_avatars"
  ON storage.objects FOR ALL TO service_role
  USING (bucket_id = 'avatars')
  WITH CHECK (bucket_id = 'avatars');
