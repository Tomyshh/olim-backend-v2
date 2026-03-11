import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import {
  uploadDual,
  sanitizeFilename,
  inferContentType,
  getSupabasePublicUrl,
  type DualUploadResult,
} from '../../services/storage.service.js';
import { dualWriteDocumentUpload, dualWriteClient } from '../../services/dualWrite.service.js';

type UploadResultLegacy = {
  url: string;
  path: string;
  contentType: string;
  size: number;
  originalName: string;
  supabaseStoragePath?: string | null;
};

function toLegacy(r: DualUploadResult): UploadResultLegacy {
  return {
    url: r.firebaseUrl,
    path: r.firebasePath,
    contentType: r.contentType,
    size: r.size,
    originalName: r.originalName,
    supabaseStoragePath: r.supabasePath,
  };
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

  const uploaded: UploadResultLegacy[] = [];

  for (const f of files) {
    const originalName = String(f.originalname || 'file');
    const clean = sanitizeFilename(originalName);
    const ts = Date.now();
    const contentType = inferContentType(originalName, f.mimetype);

    const result = await uploadDual({
      bucket: 'client-documents',
      firebasePath: `${uid}/documents/${ts}_${clean}`,
      supabasePath: `${uid}/personal/${ts}_${clean}`,
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
      documentType: 'personal',
      supabaseStoragePath: result.supabasePath,
      supabaseStorageBucket: result.supabaseBucket,
    }).catch(() => {});
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
