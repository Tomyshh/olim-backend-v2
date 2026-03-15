import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { admin, getFirestore } from '../config/firebase.js';
import { supabase } from '../services/supabase.service.js';
import { dualWriteToSupabase, resolveSupabaseClientId } from '../services/dualWrite.service.js';

export async function getTips(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { category, search } = req.query as { category?: string; search?: string };

    let query = supabase
      .from('tips')
      .select('*, tip_translations(*)')
      .order('created_at', { ascending: false });

    if (category && String(category).trim()) {
      query = query.eq('category', String(category).trim());
    }

    const { data, error } = await query;
    if (error) {
      console.error('[tips] Supabase error:', error.message);
      res.json({ tips: [] });
      return;
    }

    let tips = (data || []).map((t: any) => ({
      tipId: t.id,
      ...t,
      title: t.title ?? '',
      content: t.content ?? t.body ?? '',
      category: t.category ?? '',
      isBreaking: t.is_breaking ?? false,
      isActive: t.is_active ?? true,
      isPinned: t.is_pinned ?? false,
      displayOrder: t.display_order ?? 0,
      createdAt: t.created_at ?? '',
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
    console.error('[tips] getTips unexpected error:', error.message);
    res.json({ tips: [] });
  }
}

export async function getPinnedTips(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('tips')
      .select('*, tip_translations(*)')
      .eq('is_pinned', true)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const tips = (data || []).map((t: any) => ({
      tipId: t.id,
      ...t,
      // Legacy aliases
      title: t.title ?? '',
      content: t.content ?? t.body ?? '',
      category: t.category ?? '',
      isBreaking: t.is_breaking ?? false,
      isActive: t.is_active ?? true,
      isPinned: t.is_pinned ?? false,
      displayOrder: t.display_order ?? 0,
      createdAt: t.created_at ?? '',
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
    const clientId = await resolveSupabaseClientId(uid);

    const { data, error } = await supabase
      .from('user_saved_tips')
      .select('*')
      .eq('client_id', clientId)
      .order('saved_at', { ascending: false });

    if (error) throw error;

    const tips = (data || []).map((t: any) => ({
      tipId: t.tip_id,
      ...t,
      // Legacy aliases
      savedAt: t.saved_at ?? '',
      createdAt: t.created_at ?? '',
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
    const { data, error } = await supabase
      .from('news')
      .select('*')
      .order('date', { ascending: false });

    if (error) throw error;

    const news = (data || []).map((n: any) => ({
      newsId: n.id,
      ...n,
      // Legacy aliases
      title: n.title ?? '',
      content: n.content ?? n.body ?? '',
      category: n.category ?? '',
      isBreaking: n.is_breaking ?? false,
      isActive: n.is_active ?? true,
      displayOrder: n.display_order ?? 0,
      createdAt: n.created_at ?? '',
    }));

    res.json({ news });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getBreakingNews(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('news')
      .select('*')
      .eq('is_breaking', true)
      .order('date', { ascending: false });

    if (error) throw error;

    const news = (data || []).map((n: any) => ({
      newsId: n.id,
      ...n,
      // Legacy aliases
      title: n.title ?? '',
      content: n.content ?? n.body ?? '',
      category: n.category ?? '',
      isBreaking: n.is_breaking ?? false,
      isActive: n.is_active ?? true,
      displayOrder: n.display_order ?? 0,
      createdAt: n.created_at ?? '',
    }));

    res.json({ news });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
