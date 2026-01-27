import type { Response } from 'express';
import crypto from 'node:crypto';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import { getStorage } from '../../config/firebase.js';

type UploadResult = {
  url: string;
  path: string;
  contentType: string;
  size: number;
  originalName: string;
};

function sanitizeFilename(name: string): string {
  const base = (name || 'file').trim();
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180) || 'file';
}

function inferContentType(originalName: string, fallback: string): string {
  const ct = String(fallback || '').trim();
  if (ct && ct !== 'application/octet-stream') return ct;
  const ext = originalName.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
    json: 'application/json'
  };
  return map[ext] || 'application/octet-stream';
}

function buildFirebaseDownloadUrl(bucketName: string, objectPath: string, token: string): string {
  const encoded = encodeURIComponent(objectPath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encoded}?alt=media&token=${encodeURIComponent(token)}`;
}

export async function v1UploadRequestFiles(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = String(req.uid || '').trim();
  if (!uid) {
    res.status(401).json({ message: 'Vous devez être connecté.' });
    return;
  }

  const files = (req as any).files as Express.Multer.File[] | undefined;
  if (!files || !Array.isArray(files) || files.length === 0) {
    res.status(400).json({ message: 'Aucun fichier reçu (champ attendu: files[]).' });
    return;
  }

  const storage = getStorage();
  const bucket = storage.bucket(); // bucket par défaut (config firebase.ts)
  const bucketName = bucket.name;

  const uploaded: UploadResult[] = [];

  for (const f of files) {
    const originalName = String(f.originalname || 'file');
    const clean = sanitizeFilename(originalName);
    const ts = Date.now();
    const objectPath = `requests/${uid}/${ts}_${clean}`;
    const contentType = inferContentType(originalName, f.mimetype);
    const token = crypto.randomUUID();

    const fileRef = bucket.file(objectPath);
    await fileRef.save(f.buffer, {
      resumable: false,
      metadata: {
        contentType,
        metadata: {
          // Compat URL Firebase (token dans metadata)
          firebaseStorageDownloadTokens: token,
          uploadedBy: uid,
          uploadedAt: new Date().toISOString(),
          originalName,
          fileSize: String(f.size || 0)
        }
      }
    });

    const url = buildFirebaseDownloadUrl(bucketName, objectPath, token);
    uploaded.push({
      url,
      path: objectPath,
      contentType,
      size: f.size || 0,
      originalName
    });
  }

  res.json({ files: uploaded });
}

