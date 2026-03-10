import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore, getAuth } from '../config/firebase.js';
import { dualWriteToSupabase, dualWriteClient, dualWriteDelete, resolveSupabaseClientId } from '../services/dualWrite.service.js';
import { supabase } from '../services/supabase.service.js';

export async function registerFCMToken(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid;
    if (!uid) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { token } = req.body;
    const db = getFirestore();

    const clientRef = db.collection('Clients').doc(uid);
    const clientDoc = await clientRef.get();

    if (!clientDoc.exists) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

    const clientData = clientDoc.data()!;
    const existingTokens = clientData.fcmTokens || [];

    if (!existingTokens.includes(token)) {
      const updatedData = {
        fcmTokens: [...existingTokens, token],
        lastFcmToken: token,
        fcmTokenUpdatedAt: new Date()
      };
      await clientRef.update(updatedData);

      dualWriteClient(uid!, { ...clientData, ...updatedData }).catch(() => {});
    }

    res.json({ message: 'FCM token registered', token });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getNotifications(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { limit = 50, unreadOnly } = req.query;

    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) { res.json({ notifications: [] }); return; }

    let query = supabase
      .from('notifications')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(Number(limit));

    if (unreadOnly === 'true') {
      query = query.eq('is_read', false);
    }

    const { data, error } = await query;
    if (error) throw error;

    const notifications = (data || []).map(n => ({
      notificationId: n.firestore_id || n.id,
      ...n
    }));

    res.json({ notifications });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getNotificationDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { notificationId } = req.params;

    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .or(`firestore_id.eq.${notificationId},id.eq.${notificationId}`)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }

    res.json({ notificationId: data.firestore_id || data.id, ...data });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function markAsRead(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { notificationId } = req.params;
    const db = getFirestore();

    const readAt = new Date();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('notifications')
      .doc(notificationId)
      .update({
        read: true,
        readAt
      });

    dualWriteToSupabase('notifications', { is_read: true, read_at: readAt.toISOString() }, { mode: 'update', matchColumn: 'firestore_id', matchValue: notificationId }).catch(() => {});

    res.json({ message: 'Notification marked as read', notificationId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function markAllAsRead(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();

    const unreadNotifications = await db
      .collection('Clients')
      .doc(uid)
      .collection('notifications')
      .where('read', '==', false)
      .get();

    const readAt = new Date();
    const batch = db.batch();
    unreadNotifications.docs.forEach(doc => {
      batch.update(doc.ref, { read: true, readAt });
    });
    await batch.commit();

    if (unreadNotifications.size > 0) {
      const notifIds = unreadNotifications.docs.map(d => d.id);
      Promise.resolve(
        supabase.from('notifications')
          .update({ is_read: true, read_at: readAt.toISOString() })
          .in('firestore_id', notifIds)
      ).catch(() => {});
    }

    res.json({ message: 'All notifications marked as read', count: unreadNotifications.size });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function deleteNotification(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { notificationId } = req.params;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('notifications')
      .doc(notificationId)
      .delete();

    dualWriteDelete('notifications', 'firestore_id', notificationId).catch(() => {});

    res.json({ message: 'Notification deleted', notificationId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getNotificationSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;

    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) { res.json({ settings: {} }); return; }

    const { data, error } = await supabase
      .from('notification_settings')
      .select('*')
      .eq('client_id', clientId)
      .single();

    if (error || !data) {
      res.json({ settings: {} });
      return;
    }

    res.json({ settings: data });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateNotificationSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const settings = req.body;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('settings')
      .doc('notifications')
      .set(settings, { merge: true });

    resolveSupabaseClientId(uid).then(cid => {
      if (cid) dualWriteToSupabase('notification_settings', { client_id: cid, ...settings, updated_at: new Date().toISOString() }, { onConflict: 'client_id' });
    }).catch(() => {});

    res.json({ message: 'Notification settings updated', settings });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

