import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';
import { supabase } from '../services/supabase.service.js';
import {
  dualWriteToSupabase,
  dualWriteDelete,
  resolveSupabaseClientId,
  mapFavoriteRequestToSupabase,
} from '../services/dualWrite.service.js';

export async function getFavorites(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) {
      res.json({ favorites: [] });
      return;
    }

    let data: any[] | null = null;

    // Try with type filter first, fall back without if column doesn't exist
    const result = await supabase
      .from('favorite_requests')
      .select('*')
      .eq('client_id', clientId);

    if (result.error) {
      // Table might not exist at all – return empty
      res.json({ favorites: [] });
      return;
    }
    data = result.data;

    // Client-side filter if `type` column exists on some rows
    const favorites = (data || [])
      .filter((f: any) => !f.type || f.type === 'favorite')
      .map((f: any) => ({ id: f.id, ...f }));
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
    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) {
      res.json({ recent: [] });
      return;
    }

    const result = await supabase
      .from('favorite_requests')
      .select('*')
      .eq('client_id', clientId);

    if (result.error) {
      res.json({ recent: [] });
      return;
    }

    // Client-side filter for recent items, sort by last_used
    const recent = (result.data || [])
      .filter((r: any) => r.type === 'recent')
      .sort((a: any, b: any) => {
        const da = a.last_used ? new Date(a.last_used).getTime() : 0;
        const db = b.last_used ? new Date(b.last_used).getTime() : 0;
        return db - da;
      })
      .slice(0, 10)
      .map((r: any) => ({ id: r.id, ...r }));
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
