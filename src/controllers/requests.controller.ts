import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { dualWriteToSupabase, dualWriteDelete, resolveSupabaseClientId, mapFavoriteRequestToSupabase, dualWriteLegacyRequest } from '../services/dualWrite.service.js';

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
    const db = getFirestore();
    const { status, limit = 50 } = req.query;

    let query = db.collection('Clients').doc(uid).collection('Requests');

    if (status) {
      query = query.where('Status', '==', status) as any;
    }

    const snapshot = await query.orderBy('Request Date', 'desc').limit(Number(limit)).get();

    const requests = snapshot.docs.map(doc => ({
      requestId: doc.id,
      ...doc.data()
    }));

    res.json({ requests });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getRequestDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { requestId } = req.params;
    const db = getFirestore();

    const requestDoc = await db
      .collection('Clients')
      .doc(uid)
      .collection('Requests')
      .doc(requestId)
      .get();

    if (!requestDoc.exists) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }

    res.json({ requestId, ...requestDoc.data() });
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
    const clientDoc = await db.collection('Clients').doc(uid).get();
    const clientData = clientDoc.data()!;

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
    const db = getFirestore();
    const favoritesSnapshot = await db
      .collection('Clients')
      .doc(uid)
      .collection('favoriteRequests')
      .get();

    const favorites = favoritesSnapshot.docs.map(doc => ({
      favoriteId: doc.id,
      ...doc.data()
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

