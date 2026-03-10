import { Response } from 'express';
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { admin, getFirestore } from '../config/firebase.js';
import { dualWriteToSupabase, resolveSupabaseClientId } from '../services/dualWrite.service.js';

export async function getTips(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const db = getFirestore();
    const { category, search } = req.query as { category?: string; search?: string };

    let query: any = db.collection('Tips');
    if (category && String(category).trim()) {
      query = query.where('category', '==', String(category).trim());
    }
    query = query.orderBy('createdAt', 'desc');

    const snapshot = await query.get();
    let tips = snapshot.docs.map((doc: QueryDocumentSnapshot) => ({
      tipId: doc.id,
      ...doc.data(),
    }));

    if (search && String(search).trim()) {
      const term = String(search).trim().toLowerCase();
      tips = tips.filter((t: Record<string, any>) => {
        const title = (t.title || '').toLowerCase();
        const body = (t.body || '').toLowerCase();
        const summary = (t.summary || '').toLowerCase();
        return title.includes(term) || body.includes(term) || summary.includes(term);
      });
    }

    res.json({ tips });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getPinnedTips(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const db = getFirestore();
    const snapshot = await db
      .collection('Tips')
      .where('isPinned', '==', true)
      .orderBy('createdAt', 'desc')
      .get();

    const tips = snapshot.docs.map((doc) => ({
      tipId: doc.id,
      ...doc.data(),
    }));

    res.json({ tips });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function incrementTipView(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { tipId } = req.params;
    const db = getFirestore();

    await db.collection('Tips').doc(tipId).update({
      viewCount: admin.firestore.FieldValue.increment(1),
    });

    res.json({ message: 'View count incremented', tipId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function likeTip(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { tipId } = req.params;
    const db = getFirestore();

    await db.collection('Tips').doc(tipId).update({
      likedBy: admin.firestore.FieldValue.arrayUnion(uid),
    });

    const rowId = `${tipId}_${uid}`;
    dualWriteToSupabase(
      'tip_likes',
      {
        id: rowId,
        tip_id: tipId,
        client_firebase_uid: uid,
        created_at: new Date().toISOString(),
      },
      { mode: 'insert' }
    ).catch(() => {});

    res.json({ message: 'Tip liked', tipId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function unlikeTip(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { tipId } = req.params;
    const db = getFirestore();

    await db.collection('Tips').doc(tipId).update({
      likedBy: admin.firestore.FieldValue.arrayRemove(uid),
    });

    const rowId = `${tipId}_${uid}`;
    dualWriteToSupabase(
      'tip_likes',
      {},
      { mode: 'delete', matchColumn: 'id', matchValue: rowId }
    ).catch(() => {});

    res.json({ message: 'Tip unliked', tipId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getSavedTips(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();

    const snapshot = await db
      .collection('Clients')
      .doc(uid)
      .collection('Tips')
      .orderBy('savedAt', 'desc')
      .get();

    const tips = snapshot.docs.map((doc) => ({
      tipId: doc.id,
      ...doc.data(),
    }));

    res.json({ tips });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function saveTip(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { tipId } = req.params;
    const data = req.body || {};
    const db = getFirestore();

    const saveData = {
      ...data,
      savedAt: new Date(),
    };

    await db.collection('Clients').doc(uid).collection('Tips').doc(tipId).set(saveData, {
      merge: true,
    });

    resolveSupabaseClientId(uid).then((clientId) => {
      dualWriteToSupabase(
        'user_saved_tips',
        {
          id: `${tipId}_${uid}`,
          tip_id: tipId,
          client_id: clientId,
          client_firebase_uid: uid,
          ...data,
          saved_at: new Date().toISOString(),
        },
        { mode: 'insert' }
      ).catch(() => {});
    }).catch(() => {});

    res.json({ message: 'Tip saved', tipId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function unsaveTip(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { tipId } = req.params;
    const db = getFirestore();

    await db.collection('Clients').doc(uid).collection('Tips').doc(tipId).delete();

    const rowId = `${tipId}_${uid}`;
    dualWriteToSupabase(
      'user_saved_tips',
      {},
      { mode: 'delete', matchColumn: 'id', matchValue: rowId }
    ).catch(() => {});

    res.json({ message: 'Tip unsaved', tipId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getNews(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const db = getFirestore();
    const snapshot = await db
      .collection('News')
      .orderBy('date', 'desc')
      .get();

    const news = snapshot.docs.map((doc) => ({
      newsId: doc.id,
      ...doc.data(),
    }));

    res.json({ news });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getBreakingNews(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const db = getFirestore();
    const snapshot = await db
      .collection('News')
      .where('isBreaking', '==', true)
      .orderBy('date', 'desc')
      .get();

    const news = snapshot.docs.map((doc) => ({
      newsId: doc.id,
      ...doc.data(),
    }));

    res.json({ news });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
