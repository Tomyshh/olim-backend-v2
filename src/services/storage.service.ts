import crypto from 'node:crypto';
import { supabase } from './supabase.service.js';
import { getStorage } from '../config/firebase.js';

export type StorageBucket =
  | 'client-documents'
  | 'chat-files'
  | 'request-files'
  | 'lead-attachments'
  | 'avatars';

export interface DualUploadResult {
  firebaseUrl: string;
  firebasePath: string;
  supabasePath: string | null;
  supabaseBucket: StorageBucket;
  contentType: string;
  size: number;
  originalName: string;
}

export interface UploadOptions {
  bucket: StorageBucket;
  supabasePath: string;
  firebasePath: string;
  buffer: Buffer;
  contentType: string;
  originalName: string;
  size: number;
  uploaderId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function sanitizeFilename(name: string): string {
  const base = (name || 'file').trim();
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180) || 'file';
}

export function inferContentType(originalName: string, fallback: string): string {
  const ct = String(fallback || '').trim();
  if (ct && ct !== 'application/octet-stream') return ct;
  const ext = originalName.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain', json: 'application/json',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
    mp4: 'video/mp4', mov: 'video/quicktime',
  };
  return map[ext] || 'application/octet-stream';
}

function buildFirebaseDownloadUrl(bucketName: string, objectPath: string, token: string): string {
  const encoded = encodeURIComponent(objectPath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encoded}?alt=media&token=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// Dual upload: Firebase + Supabase Storage in parallel
// ---------------------------------------------------------------------------

export async function uploadDual(opts: UploadOptions): Promise<DualUploadResult> {
  const { bucket, supabasePath, firebasePath, buffer, contentType, originalName, size, uploaderId } = opts;
  const token = crypto.randomUUID();

  const firebaseStorage = getStorage();
  const firebaseBucket = firebaseStorage.bucket();
  const bucketName = firebaseBucket.name;

  const [fbResult, sbResult] = await Promise.allSettled([
    (async () => {
      const fileRef = firebaseBucket.file(firebasePath);
      await fileRef.save(buffer, {
        resumable: false,
        metadata: {
          contentType,
          metadata: {
            firebaseStorageDownloadTokens: token,
            uploadedBy: uploaderId,
            uploadedAt: new Date().toISOString(),
            originalName,
            fileSize: String(size),
          },
        },
      });
      return buildFirebaseDownloadUrl(bucketName, firebasePath, token);
    })(),

    (async () => {
      const { error } = await supabase.storage.from(bucket).upload(supabasePath, buffer, {
        contentType,
        upsert: true,
      });
      if (error) throw error;
      return supabasePath;
    })(),
  ]);

  if (fbResult.status === 'rejected') {
    console.error('[storage] Firebase upload failed:', fbResult.reason);
    throw fbResult.reason;
  }

  if (sbResult.status === 'rejected') {
    console.error('[storage] Supabase Storage upload failed (non-blocking):', sbResult.reason);
  }

  return {
    firebaseUrl: fbResult.value,
    firebasePath,
    supabasePath: sbResult.status === 'fulfilled' ? sbResult.value : null,
    supabaseBucket: bucket,
    contentType,
    size,
    originalName,
  };
}

// ---------------------------------------------------------------------------
// Upload to Supabase Storage only (for new endpoints where Firebase is optional)
// ---------------------------------------------------------------------------

export async function uploadToSupabase(
  bucket: StorageBucket,
  path: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const { error } = await supabase.storage.from(bucket).upload(path, buffer, {
    contentType,
    upsert: true,
  });
  if (error) throw error;
  return path;
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

export async function getSupabaseSignedUrl(
  bucket: string,
  path: string,
  expiresInSeconds = 3600,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresInSeconds);
  if (error) {
    console.error('[storage] Supabase signed URL error:', error);
    return null;
  }
  return data.signedUrl;
}

export function getSupabasePublicUrl(bucket: string, path: string): string {
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

// ---------------------------------------------------------------------------
// Delete from both storages
// ---------------------------------------------------------------------------

export async function deleteFromBoth(
  bucket: string,
  supabasePath: string | null,
  firebasePath: string | null,
): Promise<void> {
  const ops: Promise<void>[] = [];

  if (supabasePath) {
    ops.push(
      supabase.storage.from(bucket).remove([supabasePath]).then(({ error }) => {
        if (error) console.error('[storage] Supabase delete error:', error);
      }),
    );
  }

  if (firebasePath) {
    ops.push(
      (async () => {
        try {
          const firebaseBucket = getStorage().bucket();
          await firebaseBucket.file(firebasePath).delete();
        } catch (err) {
          console.error('[storage] Firebase delete error:', err);
        }
      })(),
    );
  }

  await Promise.allSettled(ops);
}
