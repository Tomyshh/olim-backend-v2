import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase } from '../services/supabase.service.js';
import { resolveSupabaseClientId, dualWriteDocumentUpload } from '../services/dualWrite.service.js';
import {
  uploadDual,
  sanitizeFilename,
  inferContentType,
  getSupabaseSignedUrl,
  deleteFromBoth,
} from '../services/storage.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapDocAliases(d: any) {
  return {
    documentId: d.firestore_id || d.id,
    ...d,
    'Document Type': d.document_type ?? d.type ?? '',
    documentType: d.document_type ?? d.type ?? '',
    fileUrl: d.file_url ?? '',
    filePath: d.file_path ?? '',
    fileName: d.file_name ?? '',
    isValid: d.is_valid ?? false,
    uploadedAt: d.uploaded_at ?? '',
    createdAt: d.created_at ?? '',
    familyMemberId: d.family_member_id ?? null,
    forWho: d.for_who ?? null,
  };
}

// ---------------------------------------------------------------------------
// GET /documents
// ---------------------------------------------------------------------------

export async function getDocuments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) { res.json({ personalDocs: [], legacyDocs: [], documents: [] }); return; }

    const { data, error } = await supabase
      .from('client_documents')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const allDocs = (data || []).map(mapDocAliases);
    const personalDocs = allDocs.filter(d => !d.family_member_id);
    const familyDocs = allDocs.filter(d => !!d.family_member_id);

    res.json({ personalDocs, familyDocs, documents: allDocs });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

// ---------------------------------------------------------------------------
// GET /documents/personal
// ---------------------------------------------------------------------------

export async function getPersonalDocuments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) { res.json({ documents: [] }); return; }

    const { data, error } = await supabase
      .from('client_documents')
      .select('*')
      .eq('client_id', clientId)
      .is('family_member_id', null)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ documents: (data || []).map(mapDocAliases) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

// ---------------------------------------------------------------------------
// GET /documents/family-member/:memberId
// ---------------------------------------------------------------------------

export async function getFamilyMemberDocuments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { memberId } = req.params;
    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) { res.json({ documents: [] }); return; }

    const { data, error } = await supabase
      .from('client_documents')
      .select('*')
      .eq('client_id', clientId)
      .eq('family_member_id', memberId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ documents: (data || []).map(mapDocAliases) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

// ---------------------------------------------------------------------------
// POST /documents/personal/upload
// ---------------------------------------------------------------------------

export async function uploadPersonalDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const documentType = String(req.body?.type || req.body?.typeKey || 'personal').trim();

    const files = (req as any).files as Express.Multer.File[] | undefined;
    const file = files?.[0] || (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ message: 'Aucun fichier reçu.' });
      return;
    }

    const originalName = String(file.originalname || 'file');
    const clean = sanitizeFilename(originalName);
    const ts = Date.now();
    const contentType = inferContentType(originalName, file.mimetype);
    const typeSlug = documentType.toLowerCase().replace(/\s+/g, '_');

    const result = await uploadDual({
      bucket: 'client-documents',
      firebasePath: `${uid}/documents/${typeSlug}/${ts}_${clean}`,
      supabasePath: `${uid}/${typeSlug}/${ts}_${clean}`,
      buffer: file.buffer,
      contentType,
      originalName,
      size: file.size || 0,
      uploaderId: uid,
    });

    dualWriteDocumentUpload(uid, {
      url: result.firebaseUrl,
      path: result.firebasePath,
      contentType,
      size: result.size,
      originalName,
      documentType,
      supabaseStoragePath: result.supabasePath,
      supabaseStorageBucket: result.supabaseBucket,
    }).catch(() => {});

    res.status(201).json({
      url: result.firebaseUrl,
      path: result.firebasePath,
      supabaseStoragePath: result.supabasePath,
      contentType,
      size: result.size,
      originalName,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

// ---------------------------------------------------------------------------
// POST /documents/family-member/:memberId/upload
// ---------------------------------------------------------------------------

export async function uploadFamilyMemberDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { memberId } = req.params;
    const documentType = String(req.body?.type || req.body?.typeKey || 'family').trim();

    const files = (req as any).files as Express.Multer.File[] | undefined;
    const file = files?.[0] || (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ message: 'Aucun fichier reçu.' });
      return;
    }

    const originalName = String(file.originalname || 'file');
    const clean = sanitizeFilename(originalName);
    const ts = Date.now();
    const contentType = inferContentType(originalName, file.mimetype);
    const typeSlug = documentType.toLowerCase().replace(/\s+/g, '_');

    const result = await uploadDual({
      bucket: 'client-documents',
      firebasePath: `${uid}/members/${memberId}/${typeSlug}/${ts}_${clean}`,
      supabasePath: `${uid}/${typeSlug}/${memberId}/${ts}_${clean}`,
      buffer: file.buffer,
      contentType,
      originalName,
      size: file.size || 0,
      uploaderId: uid,
    });

    const clientId = await resolveSupabaseClientId(uid);
    if (clientId) {
      const row: Record<string, any> = {
        client_id: clientId,
        document_type: documentType,
        file_url: result.firebaseUrl,
        file_path: result.firebasePath,
        file_name: originalName,
        content_type: contentType,
        file_size: result.size,
        family_member_id: memberId,
        supabase_storage_path: result.supabasePath,
        supabase_storage_bucket: result.supabaseBucket,
        metadata: {},
        created_at: new Date().toISOString(),
      };
      supabase.from('client_documents').insert(row).then(({ error }) => {
        if (error) console.error('[documents] insert family doc error:', error);
      });
    }

    res.status(201).json({
      url: result.firebaseUrl,
      path: result.firebasePath,
      supabaseStoragePath: result.supabasePath,
      contentType,
      size: result.size,
      originalName,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

// ---------------------------------------------------------------------------
// GET /documents/:documentId/download
// ---------------------------------------------------------------------------

export async function downloadDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { documentId } = req.params;

    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) { res.status(404).json({ error: 'Client introuvable.' }); return; }

    const { data: doc, error } = await supabase
      .from('client_documents')
      .select('*')
      .eq('client_id', clientId)
      .or(`id.eq.${documentId},firestore_id.eq.${documentId}`)
      .maybeSingle();

    if (error) throw error;
    if (!doc) { res.status(404).json({ error: 'Document introuvable.' }); return; }

    if (doc.supabase_storage_path && doc.supabase_storage_bucket) {
      const signedUrl = await getSupabaseSignedUrl(
        doc.supabase_storage_bucket,
        doc.supabase_storage_path,
        3600,
      );
      if (signedUrl) {
        res.json({ downloadUrl: signedUrl, source: 'supabase' });
        return;
      }
    }

    if (doc.file_url) {
      res.json({ downloadUrl: doc.file_url, source: 'firebase' });
      return;
    }

    res.status(404).json({ error: 'Aucune URL de fichier disponible.' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

// ---------------------------------------------------------------------------
// DELETE /documents/:documentId
// ---------------------------------------------------------------------------

export async function deleteDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { documentId } = req.params;

    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) { res.status(404).json({ error: 'Client introuvable.' }); return; }

    const { data: doc, error } = await supabase
      .from('client_documents')
      .select('*')
      .eq('client_id', clientId)
      .or(`id.eq.${documentId},firestore_id.eq.${documentId}`)
      .maybeSingle();

    if (error) throw error;
    if (!doc) { res.status(404).json({ error: 'Document introuvable.' }); return; }

    await deleteFromBoth(
      doc.supabase_storage_bucket || 'client-documents',
      doc.supabase_storage_path,
      doc.file_path,
    );

    const { error: delErr } = await supabase
      .from('client_documents')
      .delete()
      .eq('id', doc.id);

    if (delErr) throw delErr;

    res.json({ message: 'Document supprimé.', documentId: doc.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
