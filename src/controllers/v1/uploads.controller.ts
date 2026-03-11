import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import {
  uploadDual,
  sanitizeFilename,
  inferContentType,
  getSupabasePublicUrl,
  type DualUploadResult,
} from '../../services/storage.service.js';
import { dualWriteDocumentUpload, dualWriteClient, resolveSupabaseClientId } from '../../services/dualWrite.service.js';
import { supabase } from '../../services/supabase.service.js';

type UploadResultLegacy = {
  url: string;
  path: string;
  contentType: string;
  size: number;
  originalName: string;
  supabaseStoragePath?: string | null;
  supabaseStorageBucket?: string | null;
};

function toLegacy(r: DualUploadResult): UploadResultLegacy {
  return {
    url: r.firebaseUrl,
    path: r.firebasePath,
    contentType: r.contentType,
    size: r.size,
    originalName: r.originalName,
    supabaseStoragePath: r.supabasePath,
    supabaseStorageBucket: r.supabaseBucket,
  };
}

async function resolveDocTypeId(label: string): Promise<string | null> {
  if (!label) return null;
  try {
    const { data } = await supabase.from('document_types').select('id').ilike('label', label.trim()).maybeSingle();
    return data?.id ?? null;
  } catch { return null; }
}

async function resolveFamilyMemberId(clientId: string, forWho: string): Promise<string | null> {
  if (!clientId || !forWho) return null;
  try {
    const fw = forWho.toLowerCase().trim();
    const { data: members } = await supabase
      .from('family_members')
      .select('id, first_name, last_name')
      .eq('client_id', clientId);
    for (const m of members || []) {
      const n1 = `${m.first_name ?? ''} ${m.last_name ?? ''}`.toLowerCase().trim();
      const n1r = `${m.last_name ?? ''} ${m.first_name ?? ''}`.toLowerCase().trim();
      if (fw === n1 || fw === n1r || n1.includes(fw) || fw.includes(n1)) {
        return m.id;
      }
    }
  } catch { /* best-effort */ }
  return null;
}

// ---- POST /v1/uploads/documents ----
export async function v1UploadDocumentFiles(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = String(req.uid || '').trim();
  if (!uid) { res.status(401).json({ message: 'Vous devez être connecté.' }); return; }

  const files = (req as any).files as Express.Multer.File[] | undefined;
  if (!files?.length) {
    res.status(400).json({ message: 'Aucun fichier reçu (champ attendu: files[]).' });
    return;
  }

  const documentType = String(req.body?.documentType || req.body?.document_type || 'personal').trim();
  const forWho = String(req.body?.forWho || req.body?.for_who || '').trim();

  const clientId = await resolveSupabaseClientId(uid);
  const docTypeId = await resolveDocTypeId(documentType);
  const familyMemberId = clientId ? await resolveFamilyMemberId(clientId, forWho) : null;
  const typeSlug = documentType.toLowerCase().replace(/\s+/g, '_');
  const now = new Date().toISOString();

  const uploaded: UploadResultLegacy[] = [];

  for (const f of files) {
    const originalName = String(f.originalname || 'file');
    const clean = sanitizeFilename(originalName);
    const ts = Date.now();
    const contentType = inferContentType(originalName, f.mimetype);

    const result = await uploadDual({
      bucket: 'client-documents',
      firebasePath: `${uid}/documents/${typeSlug}/${ts}_${clean}`,
      supabasePath: `${uid}/${typeSlug}/${ts}_${clean}`,
      buffer: f.buffer,
      contentType,
      originalName,
      size: f.size || 0,
      uploaderId: uid,
    });

    uploaded.push(toLegacy(result));

    // Insert proper row in client_documents with all fields
    if (clientId) {
      const row: Record<string, any> = {
        client_id: clientId,
        document_type: documentType,
        document_type_id: docTypeId,
        for_who: forWho || null,
        family_member_id: familyMemberId,
        file_url: result.firebaseUrl,
        file_path: result.firebasePath,
        file_name: originalName,
        content_type: contentType,
        file_size: result.size,
        uploaded_at: now,
        supabase_storage_path: result.supabasePath,
        supabase_storage_bucket: result.supabaseBucket,
        is_valid: true,
        metadata: {},
        created_at: now,
      };
      supabase.from('client_documents').insert(row).then(({ error }) => {
        if (error) console.error('[v1/uploads] insert doc error:', error.message);
      });
    }
  }

  res.json({ files: uploaded });
}

// ---- POST /v1/uploads/profile-photo ----
export async function v1UploadProfilePhoto(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = String(req.uid || '').trim();
  if (!uid) { res.status(401).json({ message: 'Vous devez être connecté.' }); return; }

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) { res.status(400).json({ message: 'Aucun fichier reçu.' }); return; }

  const originalName = String(file.originalname || 'profile');
  const clean = sanitizeFilename(originalName);
  const contentType = inferContentType(originalName, file.mimetype);

  const result = await uploadDual({
    bucket: 'avatars',
    firebasePath: `${uid}/profile/${clean}`,
    supabasePath: `${uid}/${clean}`,
    buffer: file.buffer,
    contentType,
    originalName,
    size: file.size || 0,
    uploaderId: uid,
  });

  const avatarPublicUrl = result.supabasePath
    ? getSupabasePublicUrl('avatars', result.supabasePath)
    : null;

  dualWriteDocumentUpload(uid, {
    url: result.firebaseUrl,
    path: result.firebasePath,
    contentType,
    size: file.size || 0,
    originalName,
    documentType: 'profile_photo',
    supabaseStoragePath: result.supabasePath,
    supabaseStorageBucket: result.supabaseBucket,
  }).catch(() => {});

  dualWriteClient(uid, {
    profilePhotoUrl: result.firebaseUrl,
    supabaseAvatarUrl: avatarPublicUrl,
  }).catch(() => {});

  res.json({ files: [toLegacy(result)] });
}

// ---- POST /v1/uploads/requests ----
export async function v1UploadRequestFiles(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = String(req.uid || '').trim();
  if (!uid) { res.status(401).json({ message: 'Vous devez être connecté.' }); return; }

  const files = (req as any).files as Express.Multer.File[] | undefined;
  if (!files?.length) {
    res.status(400).json({ message: 'Aucun fichier reçu (champ attendu: files[]).' });
    return;
  }

  const uploaded: UploadResultLegacy[] = [];

  for (const f of files) {
    const originalName = String(f.originalname || 'file');
    const clean = sanitizeFilename(originalName);
    const ts = Date.now();
    const contentType = inferContentType(originalName, f.mimetype);

    const result = await uploadDual({
      bucket: 'request-files',
      firebasePath: `requests/${uid}/${ts}_${clean}`,
      supabasePath: `${uid}/${ts}_${clean}`,
      buffer: f.buffer,
      contentType,
      originalName,
      size: f.size || 0,
      uploaderId: uid,
    });

    uploaded.push(toLegacy(result));

    dualWriteDocumentUpload(uid, {
      url: result.firebaseUrl,
      path: result.firebasePath,
      contentType,
      size: f.size || 0,
      originalName,
      documentType: 'request_attachment',
      supabaseStoragePath: result.supabasePath,
      supabaseStorageBucket: result.supabaseBucket,
    }).catch(() => {});
  }

  res.json({ files: uploaded });
}
