import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { supabase } from '../services/supabase.service.js';
import { dualWriteToSupabase, dualWriteDelete, resolveSupabaseClientId, mapFavoriteRequestToSupabase, dualWriteLegacyRequest } from '../services/dualWrite.service.js';
import { readClientInfo } from '../services/supabaseFirstRead.service.js';

function mapRequestToLegacy(r: Record<string, any>): Record<string, any> {
  return {
    requestId: r.firebase_request_id ?? r.unique_id ?? r.id,
    ...r,
    'Request Type': r.request_type ?? '',
    'Request Category': r.request_category ?? '',
    'Request Sub-Category': r.request_sub_category ?? '',
    'Description': r.request_description ?? '',
    'Request Ref': r.request_ref ?? '',
    'Status': r.status ?? '',
    'Priority': r.priority ?? 1,
    'Difficulty': r.difficulty ?? 1,
    'Assigned to': r.assigned_to ?? '',
    'Tags': r.tags ?? [],
    'Available Days': r.available_days ?? [],
    'Available Hours': r.available_hours ?? [],
    'Uploaded Files': r.uploaded_files ?? [],
    'is opened': r.is_opened ?? false,
    'Support Response': r.response_text ?? '',
    'Support Response Date': r.response_date ?? null,
    '[Response] Attached Files': r.response_files ?? [],
    'Response urls': r.response_files ?? [],
    'Support Comment Response': r.response_comment ?? '',
    'Client comment': r.client_comment ?? '',
    'Request Date': r.request_date ?? r.created_at,
    'In Progress Date': r.in_progress_date ?? null,
    'Closing Date': r.closing_date ?? null,
    'Active Step': r.status ?? '',
    "Temps d'attente": r.waiting_time ?? '',
    'First Name': r.first_name ?? '',
    'Last Name': r.last_name ?? '',
    'Email': r.email ?? '',
    'Membership Type': r.membership_type ?? '',
    'is rdv': r.is_rdv ?? false,
    'rdv location': r.rdv_location ?? '',
    'rdv date': r.rdv_date ?? '',
    'rdv hours': r.rdv_hours ?? '',
    'rdv name': r.rdv_name ?? '',
    'is rdv over': r.is_rdv_over ?? false,
    'Created By': r.created_by ?? 'APP',
    'Waiting Info From Client': r.waiting_info_from_client ?? false,
    'has missing fields': r.has_missing_fields ?? false,
    'missing fields': r.missing_fields ?? [],
    'additional information': r.additional_information ?? '',
    rating: r.rating ?? null,
    'rating tags': r.rating_tags ?? [],
    source: r.source ?? '',
    platform: r.platform ?? 'mobile',
  };
}

function computeConseiller(requestType: string, requestCategory: string): string {
  const type = String(requestType || '').trim();
  const category = String(requestCategory || '').trim();
  if (type === 'CRM Internal System' && category !== 'Vérifier remboursement') {
    return 'Odelia';
  }
  if (type === 'CRM Internal System' && category === 'Vérifier remboursement') {
    return 'Yaacov';
  }
  return 'Marie';
}

export async function getRequests(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { status, limit = 50 } = req.query;

    let query = supabase
      .from('requests')
      .select('*')
      .eq('user_id', uid)
      .order('request_date', { ascending: false })
      .limit(Number(limit));

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const mapped = (data ?? []).map(r => mapRequestToLegacy(r));

    // Deduplicate by firebase_request_id (migration can create LEGACY-xxx
    // and APP-xxx rows for the same request)
    const seen = new Map<string, Record<string, any>>();
    for (const r of mapped) {
      const fid = r.firebase_request_id ?? r.requestId;
      if (!fid || !seen.has(fid)) {
        seen.set(fid ?? r.id, r);
      }
    }
    const requests = Array.from(seen.values());

    res.json({ requests });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getRequestDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { requestId } = req.params;

    const { data, error } = await supabase
      .from('requests')
      .select('*')
      .eq('user_id', uid)
      .or(`firebase_request_id.eq.${requestId},unique_id.eq.${requestId}`)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }

    res.json(mapRequestToLegacy(data));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getConseiller(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const requestType = String(req.query.requestType || '');
    const requestCategory = String(req.query.requestCategory || '');
    const conseiller = computeConseiller(requestType, requestCategory);
    res.json({
      conseiller,
      advisor: conseiller,
      requestType,
      requestCategory
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Unable to resolve conseiller' });
  }
}

export async function createRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const requestData = req.body;
    const db = getFirestore();

    // Récupérer infos client pour enrichir la demande
    const clientData = await readClientInfo(uid, async () => {
      const doc = await db.collection('Clients').doc(uid).get();
      return doc.exists ? (doc.data() || {}) as Record<string, any> : {} as Record<string, any>;
    });

    const newRequest = {
      'User ID': uid,
      'First Name': clientData['First Name'],
      'Last Name': clientData['Last Name'],
      Email: clientData.Email,
      // IMPORTANT: membership calculé côté serveur (middleware) — ne pas faire confiance au client.
      'Membership Type': typeof (req as any)?.requestMembership === 'string' ? String((req as any).requestMembership).trim() : null,
      'Request Type': requestData.requestType,
      'Request Category': requestData.category,
      'SubCategory ID': requestData.subCategoryId,
      'Request Sub-Category': requestData.subCategory,
      Description: requestData.description,
      'Request Date': new Date(),
      Priority: requestData.priority || 'normal',
      'Uploaded Files': requestData.files || [],
      'Available Days': requestData.availableDays || [],
      'Available Hours': requestData.availableHours || [],
      Tags: requestData.tags || [],
      Status: 'pending',
      'Created At': new Date(),
      'Updated At': new Date(),
      'Form Data': requestData.formData || {}
    };

    const requestRef = await db
      .collection('Clients')
      .doc(uid)
      .collection('Requests')
      .add(newRequest);

    dualWriteLegacyRequest(uid, requestRef.id, newRequest).catch(() => {});

    res.status(201).json({ requestId: requestRef.id, ...newRequest });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { requestId } = req.params;
    const updates = req.body;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('Requests')
      .doc(requestId)
      .update({
        ...updates,
        'Updated At': new Date()
      });

    const updatedDoc = await db
      .collection('Clients')
      .doc(uid)
      .collection('Requests')
      .doc(requestId)
      .get();

    dualWriteLegacyRequest(uid, requestId, updatedDoc.data()!).catch(() => {});

    res.json({ requestId, ...updatedDoc.data() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function deleteRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { requestId } = req.params;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('Requests')
      .doc(requestId)
      .delete();

    dualWriteDelete('requests', 'firebase_request_id', requestId).catch(() => {});

    res.json({ message: 'Request deleted', requestId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function uploadRequestFiles(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { requestId } = req.params;
    // TODO: Implémenter upload fichiers avec Firebase Storage
    // TODO: Mettre à jour 'Uploaded Files' dans la demande

    res.status(501).json({
      message: 'Not implemented - uploadRequestFiles',
      note: 'À implémenter avec Firebase Storage'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function assignAdvisor(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { requestId } = req.params;
    const { advisorId } = req.body;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('Requests')
      .doc(requestId)
      .update({
        'Assigned to': advisorId,
        'Updated At': new Date()
      });

    dualWriteToSupabase('requests', {
      assigned_to: advisorId,
      sync_date: new Date().toISOString()
    }, { mode: 'update', matchColumn: 'firebase_request_id', matchValue: requestId }).catch(() => {});

    res.json({ message: 'Advisor assigned', requestId, advisorId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function rateRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { requestId } = req.params;
    const { rating, comment } = req.body;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('Requests')
      .doc(requestId)
      .update({
        rating: Number(rating),
        ratingComment: comment,
        'Updated At': new Date()
      });

    dualWriteToSupabase('requests', {
      rating: Number(rating),
      client_comment: comment ?? null,
      sync_date: new Date().toISOString()
    }, { mode: 'update', matchColumn: 'firebase_request_id', matchValue: requestId }).catch(() => {});

    res.json({ message: 'Rating saved', requestId, rating });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getFavoriteRequests(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

    const { data, error } = await supabase
      .from('favorite_requests')
      .select('*')
      .eq('client_id', clientId);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const favorites = (data ?? []).map(f => ({
      favoriteId: f.firestore_id ?? f.id,
      ...f
    }));

    res.json({ favorites });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function addFavoriteRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { requestId } = req.params;
    const { categoryId, subCategoryId } = req.body;
    const db = getFirestore();

    const favData = {
      categoryId,
      subCategoryId,
      createdAt: new Date()
    };

    await db
      .collection('Clients')
      .doc(uid)
      .collection('favoriteRequests')
      .doc(requestId)
      .set(favData);

    resolveSupabaseClientId(uid).then(cid => {
      if (cid) dualWriteToSupabase('favorite_requests', mapFavoriteRequestToSupabase(cid, requestId, favData), { onConflict: 'firestore_id' });
    }).catch(() => {});

    res.json({ message: 'Favorite added', requestId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function removeFavoriteRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { requestId } = req.params;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('favoriteRequests')
      .doc(requestId)
      .delete();

    dualWriteDelete('favorite_requests', 'firestore_id', requestId).catch(() => {});

    res.json({ message: 'Favorite removed', requestId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

