import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore, getStorage } from '../config/firebase.js';
import { supabase } from '../services/supabase.service.js';
import { resolveSupabaseClientId } from '../services/dualWrite.service.js';

export async function getDocuments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;

    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) { res.json({ personalDocs: [], legacyDocs: [] }); return; }

    const { data, error } = await supabase
      .from('client_documents')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const allDocs = data || [];
    const mapDocAliases = (d: any) => ({
      documentId: d.firestore_id || d.id,
      ...d,
      // Legacy aliases
      documentType: d.document_type ?? d.type ?? '',
      fileUrl: d.file_url ?? '',
      filePath: d.file_path ?? '',
      fileName: d.file_name ?? '',
      isValid: d.is_valid ?? false,
      uploadedAt: d.uploaded_at ?? '',
      createdAt: d.created_at ?? '',
      familyMemberId: d.family_member_id ?? null,
    });
    const personalDocs = allDocs.filter(d => d.category === 'personal').map(mapDocAliases);
    const legacyDocs = allDocs.filter(d => d.category === 'legacy').map(mapDocAliases);

    res.json({ personalDocs, legacyDocs });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getPersonalDocuments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;

    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) { res.json({ documents: [] }); return; }

    const { data, error } = await supabase
      .from('client_documents')
      .select('*')
      .eq('client_id', clientId)
      .eq('category', 'personal')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const documents = (data || []).map((d: any) => ({
      documentId: d.firestore_id || d.id,
      ...d,
      // Legacy aliases
      documentType: d.document_type ?? d.type ?? '',
      fileUrl: d.file_url ?? '',
      filePath: d.file_path ?? '',
      fileName: d.file_name ?? '',
      isValid: d.is_valid ?? false,
      uploadedAt: d.uploaded_at ?? '',
      createdAt: d.created_at ?? '',
      familyMemberId: d.family_member_id ?? null,
    }));
    res.json({ documents });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

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

    const documents = (data || []).map((d: any) => ({
      documentId: d.firestore_id || d.id,
      ...d,
      // Legacy aliases
      documentType: d.document_type ?? d.type ?? '',
      fileUrl: d.file_url ?? '',
      filePath: d.file_path ?? '',
      fileName: d.file_name ?? '',
      isValid: d.is_valid ?? false,
      uploadedAt: d.uploaded_at ?? '',
      createdAt: d.created_at ?? '',
      familyMemberId: d.family_member_id ?? null,
    }));
    res.json({ documents });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function uploadPersonalDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { type, typeKey, fileName } = req.body;
    // TODO: Implémenter upload avec Firebase Storage
    // TODO: Stocker dans Clients/{uid}/docs/{typeKey}/...
    // TODO: Mettre à jour Firestore

    res.status(501).json({
      message: 'Not implemented - uploadPersonalDocument',
      note: 'À implémenter avec Firebase Storage + Firestore update'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function uploadFamilyMemberDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { memberId } = req.params;
    const { type, typeKey, fileName } = req.body;
    // TODO: Implémenter upload avec Firebase Storage
    // TODO: Stocker dans Clients/{uid}/membres/{memberId}/docs/{typeKey}/...

    res.status(501).json({
      message: 'Not implemented - uploadFamilyMemberDocument',
      note: 'À implémenter avec Firebase Storage'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function downloadDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { documentId } = req.params;
    // TODO: Récupérer document depuis Storage
    // TODO: Streamer le fichier

    res.status(501).json({
      message: 'Not implemented - downloadDocument',
      note: 'À implémenter avec Firebase Storage download'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function deleteDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { documentId } = req.params;
    // TODO: Supprimer depuis Storage
    // TODO: Supprimer référence Firestore

    res.status(501).json({
      message: 'Not implemented - deleteDocument',
      note: 'À implémenter avec Firebase Storage + Firestore delete'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

