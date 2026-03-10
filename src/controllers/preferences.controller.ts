import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import {
  dualWriteToSupabase,
  dualWriteDelete,
  resolveSupabaseClientId,
  mapFavoriteRequestToSupabase,
} from '../services/dualWrite.service.js';

export async function getFavorites(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();

    const snapshot = await db
      .collection('Clients')
      .doc(uid)
      .collection('favoriteRequests')
      .where('type', '==', 'favorite')
      .get();

    const favorites = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ favorites });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function addFavorite(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { categoryId } = req.params;
    const body = req.body;
    const db = getFirestore();

    const docData = {
      type: 'favorite',
      categoryId,
      categoryTitle: body.categoryTitle ?? '',
      subCategoryId: body.subCategoryId ?? '',
      subCategoryTitle: body.subCategoryTitle ?? '',
      ...body,
    };

    await db
      .collection('Clients')
      .doc(uid)
      .collection('favoriteRequests')
      .doc(categoryId)
      .set(docData, { merge: true });

    const clientId = await resolveSupabaseClientId(uid);
    if (clientId) {
      const row = mapFavoriteRequestToSupabase(clientId, categoryId, docData);
      dualWriteToSupabase('favorite_requests', row, { onConflict: 'firestore_id' }).catch(() => {});
    }

    res.status(201).json({ message: 'Favorite added', categoryId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function removeFavorite(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { categoryId } = req.params;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('favoriteRequests')
      .doc(categoryId)
      .delete();

    dualWriteDelete('favorite_requests', 'firestore_id', categoryId).catch(() => {});

    res.json({ message: 'Favorite removed', categoryId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getRecent(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();

    const snapshot = await db
      .collection('Clients')
      .doc(uid)
      .collection('favoriteRequests')
      .where('type', '==', 'recent')
      .orderBy('lastUsed', 'desc')
      .limit(10)
      .get();

    const recent = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ recent });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function recordUsage(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { subCategoryId } = req.params;
    const body = req.body;
    const db = getFirestore();

    const now = new Date();
    const docData = {
      type: 'recent',
      subCategoryId,
      lastUsed: now,
      ...body,
    };

    await db
      .collection('Clients')
      .doc(uid)
      .collection('favoriteRequests')
      .doc(subCategoryId)
      .set(docData, { merge: true });

    const clientId = await resolveSupabaseClientId(uid);
    if (clientId) {
      const row = mapFavoriteRequestToSupabase(clientId, subCategoryId, docData);
      dualWriteToSupabase('favorite_requests', row, { onConflict: 'firestore_id' }).catch(() => {});
    }

    res.json({ message: 'Usage recorded', subCategoryId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
