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

async function resolveDocumentTypeId(documentType: string): Promise<string | null> {
  if (!documentType) return null;
  try {
    const { data } = await supabase
      .from('document_types')
      .select('id')
      .ilike('label', documentType.trim())
      .maybeSingle();
    return data?.id ?? null;
  } catch { return null; }
}

function mapDocAliases(d: any) {
  // Resolve document_type: prefer joined label, then raw column
  const joinedType = d.document_types;
  const docType = joinedType?.label ?? d.document_type ?? d.type ?? '';
  const docTypeSlug = joinedType?.slug ?? '';
  const docTypeId = d.document_type_id ?? joinedType?.id ?? null;

  // Resolve for_who: prefer joined family member name
  const joinedMember = d.family_members;
  const rawForWho = d.for_who ?? '';
  const forWhoName = joinedMember
    ? `${joinedMember.first_name ?? ''} ${joinedMember.last_name ?? ''}`.trim()
    : rawForWho;

  const uploadedAt = d.uploaded_at ?? d.created_at ?? '';
  const fileUrl = d.file_url ?? '';
  const fileUrls: string[] = fileUrl ? [fileUrl] : [];

  // Remove joined objects from spread to keep response clean
  const { document_types: _dt, family_members: _fm, ...rest } = d;

  return {
    documentId: d.firestore_id || d.id,
    ...rest,
    documentType: docType,
    documentTypeSlug: docTypeSlug,
    documentTypeId: docTypeId,
    fileUrl,
    filePath: d.file_path ?? '',
    fileName: d.file_name ?? '',
    isValid: d.is_valid ?? false,
    uploadedAt,
    createdAt: d.created_at ?? '',
    familyMemberId: d.family_member_id ?? null,
    forWho: forWhoName,
    'Document Type': docType,
    'For who ?': forWhoName,
    'Upload date': uploadedAt,
    'Uploaded Files': fileUrls,
    uploadDate: uploadedAt,
    uploadedFiles: fileUrls,
    urls: fileUrls,
  };
}

async function enrichWithSignedUrls(docs: any[]): Promise<any[]> {
  const enriched = await Promise.all(docs.map(async (d) => {
    if (d.fileUrl) return d;
    if (!d.supabase_storage_path || !d.supabase_storage_bucket) return d;
    try {
      const signedUrl = await getSupabaseSignedUrl(
        d.supabase_storage_bucket,
        d.supabase_storage_path,
        7200,
      );
      if (signedUrl) {
        d.fileUrl = signedUrl;
        d.file_url = signedUrl;
        d['Uploaded Files'] = [signedUrl];
        d.uploadedFiles = [signedUrl];
        d.urls = [signedUrl];
      }
    } catch (_) { /* best-effort */ }
    return d;
  }));
  return enriched;
}

// ---------------------------------------------------------------------------
// GET /documents/types  (public list of document types)
// ---------------------------------------------------------------------------

export async function getDocumentTypes(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('document_types')
      .select('id, slug, label, label_he, description, description_fr, description_en')
      .order('label', { ascending: true });

    if (error) throw error;

    const types = (data || []).map((t: any) => ({
      id: t.id,
      slug: t.slug,
      label: t.label,
      labelHe: t.label_he,
      description: t.description,
      descriptionFr: t.description_fr,
      descriptionEn: t.description_en,
    }));

    res.json({ types });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

// ---------------------------------------------------------------------------
// GET /documents
// ---------------------------------------------------------------------------

export async function getDocuments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) { res.json({ personalDocs: [], familyDocs: [], documents: [] }); return; }

    // Try with JOINs first, fall back to simple select if FK not set up yet
    let data: any[] | null = null;
    const joinSelect = '*, document_types(id, slug, label, label_he), family_members(id, first_name, last_name)';
    const result = await supabase
      .from('client_documents')
      .select(joinSelect)
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (result.error) {
      const fallback = await supabase
        .from('client_documents')
        .select('*')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false });
      if (fallback.error) throw fallback.error;
      data = fallback.data;
    } else {
      data = result.data;
    }

    const allDocs = await enrichWithSignedUrls((data || []).map(mapDocAliases));
    const personalDocs = allDocs.filter((d: any) => !d.family_member_id);
    const familyDocs = allDocs.filter((d: any) => !!d.family_member_id);

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

    let data: any[] | null = null;
    const result = await supabase
      .from('client_documents')
      .select('*, document_types(id, slug, label, label_he)')
      .eq('client_id', clientId)
      .is('family_member_id', null)
      .order('created_at', { ascending: false });

    if (result.error) {
      const fallback = await supabase
        .from('client_documents')
        .select('*')
        .eq('client_id', clientId)
        .is('family_member_id', null)
        .order('created_at', { ascending: false });
      if (fallback.error) throw fallback.error;
      data = fallback.data;
    } else {
      data = result.data;
    }

    const docs = await enrichWithSignedUrls((data || []).map(mapDocAliases));
    res.json({ documents: docs });
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

    let data: any[] | null = null;
    const result = await supabase
      .from('client_documents')
      .select('*, document_types(id, slug, label, label_he), family_members(id, first_name, last_name)')
      .eq('client_id', clientId)
      .eq('family_member_id', memberId)
      .order('created_at', { ascending: false });

    if (result.error) {
      const fallback = await supabase
        .from('client_documents')
        .select('*')
        .eq('client_id', clientId)
        .eq('family_member_id', memberId)
        .order('created_at', { ascending: false });
      if (fallback.error) throw fallback.error;
      data = fallback.data;
    } else {
      data = result.data;
    }

    const docs = await enrichWithSignedUrls((data || []).map(mapDocAliases));
    res.json({ documents: docs });
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
    const forWho = String(req.body?.for_who || req.body?.forWho || '').trim();

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

    const now = new Date().toISOString();

    const clientId = await resolveSupabaseClientId(uid);
    if (clientId) {
      const docTypeId = await resolveDocumentTypeId(documentType);
      const row: Record<string, any> = {
        client_id: clientId,
        document_type: documentType,
        document_type_id: docTypeId,
        for_who: forWho || null,
        file_url: result.firebaseUrl,
        file_path: result.firebasePath,
        file_name: originalName,
        content_type: contentType,
        file_size: result.size,
        uploaded_at: now,
        supabase_storage_path: result.supabasePath,
        supabase_storage_bucket: result.supabaseBucket,
        metadata: {},
        created_at: now,
      };
      supabase.from('client_documents').insert(row).then(({ error: insertErr }) => {
        if (insertErr) console.error('[documents] insert personal doc error:', insertErr);
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
// POST /documents/family-member/:memberId/upload
// ---------------------------------------------------------------------------

export async function uploadFamilyMemberDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { memberId } = req.params;
    const documentType = String(req.body?.type || req.body?.typeKey || 'family').trim();
    const forWho = String(req.body?.for_who || req.body?.forWho || '').trim();

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

    const now = new Date().toISOString();
    const clientId = await resolveSupabaseClientId(uid);
    if (clientId) {
      const docTypeId = await resolveDocumentTypeId(documentType);
      const row: Record<string, any> = {
        client_id: clientId,
        document_type: documentType,
        document_type_id: docTypeId,
        for_who: forWho || null,
        file_url: result.firebaseUrl,
        file_path: result.firebasePath,
        file_name: originalName,
        content_type: contentType,
        file_size: result.size,
        family_member_id: memberId,
        uploaded_at: now,
        supabase_storage_path: result.supabasePath,
        supabase_storage_bucket: result.supabaseBucket,
        metadata: {},
        created_at: now,
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
// POST /documents/save   (save metadata + file URLs to Supabase)
// ---------------------------------------------------------------------------

export async function saveDocumentMetadata(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) { res.status(404).json({ error: 'Client introuvable.' }); return; }

    const documentType = String(req.body?.document_type || req.body?.type || '').trim();
    const forWho = String(req.body?.for_who || req.body?.forWho || '').trim();
    const urls: string[] = req.body?.urls || req.body?.uploadedFiles || [];
    const uploadDate = req.body?.upload_date || req.body?.uploadDate || new Date().toISOString();

    if (!documentType) {
      res.status(400).json({ error: 'document_type requis.' });
      return;
    }

    const now = new Date().toISOString();
    const docTypeId = await resolveDocumentTypeId(documentType);

    const baseRow: Record<string, any> = {
      client_id: clientId,
      document_type: documentType,
      document_type_id: docTypeId,
      for_who: forWho || null,
      uploaded_at: uploadDate,
      created_at: now,
      is_valid: true,
      metadata: {},
    };

    const rows = urls.length > 0
      ? urls.map((url: string) => ({
          ...baseRow,
          file_url: url,
          file_name: url.split('/').pop() || 'file',
        }))
      : [baseRow];

    const { error } = await supabase.from('client_documents').insert(rows);
    if (error) throw error;

    res.status(201).json({ message: 'Document(s) enregistré(s).', count: rows.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

// ---------------------------------------------------------------------------
// PATCH /documents/:documentId
// ---------------------------------------------------------------------------

export async function updateDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { documentId } = req.params;

    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) { res.status(404).json({ error: 'Client introuvable.' }); return; }

    const { data: doc, error: findErr } = await supabase
      .from('client_documents')
      .select('id')
      .eq('client_id', clientId)
      .or(`id.eq.${documentId},firestore_id.eq.${documentId}`)
      .maybeSingle();

    if (findErr) throw findErr;
    if (!doc) { res.status(404).json({ error: 'Document introuvable.' }); return; }

    const updates: Record<string, any> = {};
    if (req.body.document_type !== undefined) {
      updates.document_type = req.body.document_type;
      const dtId = await resolveDocumentTypeId(req.body.document_type);
      if (dtId) updates.document_type_id = dtId;
    }
    if (req.body.for_who !== undefined) updates.for_who = req.body.for_who;

    if (Object.keys(updates).length === 0) {
      res.json({ message: 'Rien à mettre à jour.' });
      return;
    }

    const { error: updateErr } = await supabase
      .from('client_documents')
      .update(updates)
      .eq('id', doc.id);

    if (updateErr) throw updateErr;

    res.json({ message: 'Document mis à jour.', documentId: doc.id });
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

// ---------------------------------------------------------------------------
// POST /documents/backfill  (admin: backfill family_member_id + document_type_id)
// ---------------------------------------------------------------------------

export async function backfillDocumentRelations(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const results = { familyMemberUpdated: 0, familyMemberNoMatch: 0, docTypeUpdated: 0 };

    // 1. Backfill family_member_id from for_who text
    const { data: docs } = await supabase
      .from('client_documents')
      .select('id, client_id, for_who, family_member_id')
      .is('family_member_id', null)
      .not('for_who', 'is', null)
      .neq('for_who', '');

    if (docs && docs.length > 0) {
      const clientIds = [...new Set(docs.map((d: any) => d.client_id))];
      const { data: members } = await supabase
        .from('family_members')
        .select('id, client_id, first_name, last_name')
        .in('client_id', clientIds);

      const membersByClient = new Map<string, any[]>();
      for (const m of members || []) {
        const list = membersByClient.get(m.client_id) || [];
        list.push(m);
        membersByClient.set(m.client_id, list);
      }

      for (const doc of docs) {
        const forWho = (doc.for_who || '').toLowerCase().trim();
        if (!forWho) continue;
        const clientMembers = membersByClient.get(doc.client_id) || [];
        let matched: any = null;
        for (const m of clientMembers) {
          const n1 = `${m.first_name ?? ''} ${m.last_name ?? ''}`.toLowerCase().trim();
          const n1r = `${m.last_name ?? ''} ${m.first_name ?? ''}`.toLowerCase().trim();
          if (forWho === n1 || forWho === n1r || n1.includes(forWho) || forWho.includes(n1)) {
            matched = m;
            break;
          }
        }
        if (matched) {
          await supabase.from('client_documents').update({ family_member_id: matched.id }).eq('id', doc.id);
          results.familyMemberUpdated++;
        } else {
          results.familyMemberNoMatch++;
        }
      }
    }

    // 2. Backfill document_type_id
    try {
      const { data: dtDocs } = await supabase
        .from('client_documents')
        .select('id, document_type, document_type_id')
        .is('document_type_id', null)
        .not('document_type', 'is', null)
        .neq('document_type', '');

      if (dtDocs && dtDocs.length > 0) {
        const { data: types } = await supabase.from('document_types').select('id, slug, label');
        for (const doc of dtDocs) {
          const dt = (doc.document_type || '').toLowerCase().trim();
          const match = (types || []).find((t: any) =>
            (t.label || '').toLowerCase().trim() === dt ||
            (t.slug || '').toLowerCase().trim() === dt
          );
          if (match) {
            await supabase.from('client_documents').update({ document_type_id: match.id }).eq('id', doc.id);
            results.docTypeUpdated++;
          }
        }
      }
    } catch (_) { /* column might not exist yet */ }

    res.json({ message: 'Backfill terminé.', results });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
