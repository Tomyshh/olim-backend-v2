import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore, getAuth } from '../config/firebase.js';
import { dualWriteToSupabase, dualWriteClient, dualWriteDelete, resolveSupabaseClientId } from '../services/dualWrite.service.js';
import { supabase } from '../services/supabase.service.js';
import { readClientInfo } from '../services/supabaseFirstRead.service.js';
import { supabaseUpdateThenFirestore, supabaseDeleteThenFirestore, supabaseUpsertThenFirestore } from '../services/supabaseFirstWrite.service.js';

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

    const clientData = await readClientInfo(uid, async () => {
      const doc = await clientRef.get();
      if (!doc.exists) return null as any;
      return doc.data()!;
    });

    if (!clientData) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

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
      ...n,
      // Legacy aliases
      title: n.title ?? '',
      body: n.body ?? '',
      type: n.type ?? '',
      read: n.is_read ?? false,
      isRead: n.is_read ?? false,
      readAt: n.read_at ?? null,
      data: n.data ?? null,
      createdAt: n.created_at ?? '',
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

    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) { res.status(404).json({ error: 'Notification not found' }); return; }

    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('client_id', clientId)
      .or(`firestore_id.eq.${notificationId},id.eq.${notificationId}`)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }

    res.json({
      notificationId: data.firestore_id || data.id,
      ...data,
      // Legacy aliases
      title: data.title ?? '',
      body: data.body ?? '',
      type: data.type ?? '',
      read: data.is_read ?? false,
      isRead: data.is_read ?? false,
      readAt: data.read_at ?? null,
      data: data.data ?? null,
      createdAt: data.created_at ?? '',
    });
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

    await supabaseUpdateThenFirestore({
      table: 'notifications',
      supabaseData: { is_read: true, read_at: readAt.toISOString() },
      matchColumn: 'firestore_id',
      matchValue: notificationId,
      firestoreWrite: async () => {
        await db.collection('Clients').doc(uid).collection('notifications').doc(notificationId)
          .update({ read: true, readAt });
      },
      context: 'notifications.markAsRead',
    });

    res.json({ message: 'Notification marked as read', notificationId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function markAllAsRead(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();
    const readAt = new Date();

    const clientId = await resolveSupabaseClientId(uid);
    let count = 0;

    if (clientId) {
      // Supabase-first: find and update unread notifications
      const { data: unread } = await supabase
        .from('notifications')
        .select('id, firestore_id')
        .eq('client_id', clientId)
        .eq('is_read', false);

      if (unread && unread.length > 0) {
        count = unread.length;
        const ids = unread.map((n: any) => n.id);
        await supabase
          .from('notifications')
          .update({ is_read: true, read_at: readAt.toISOString() })
          .in('id', ids);

        // Firestore best-effort sync
        try {
          const firestoreIds = unread.map((n: any) => n.firestore_id).filter(Boolean);
          if (firestoreIds.length > 0) {
            const batch = db.batch();
            for (const fid of firestoreIds) {
              const ref = db.collection('Clients').doc(uid).collection('notifications').doc(fid);
              batch.update(ref, { read: true, readAt });
            }
            await batch.commit();
          }
        } catch (firestoreErr) {
          console.warn('[notifications.markAllAsRead] Firestore sync failed (best-effort)', firestoreErr);
        }
      }
    } else {
      // Fallback: Firestore if client not found in Supabase
      const unreadNotifications = await db
        .collection('Clients')
        .doc(uid)
        .collection('notifications')
        .where('read', '==', false)
        .get();

      const batch = db.batch();
      unreadNotifications.docs.forEach(doc => {
        batch.update(doc.ref, { read: true, readAt });
      });
      await batch.commit();
      count = unreadNotifications.size;

      if (unreadNotifications.size > 0) {
        const notifIds = unreadNotifications.docs.map(d => d.id);
        Promise.resolve(
          supabase.from('notifications')
            .update({ is_read: true, read_at: readAt.toISOString() })
            .in('firestore_id', notifIds)
        ).catch(() => {});
      }
    }

    res.json({ message: 'All notifications marked as read', count });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function deleteNotification(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { notificationId } = req.params;
    const db = getFirestore();

    await supabaseDeleteThenFirestore({
      table: 'notifications',
      matchColumn: 'firestore_id',
      matchValue: notificationId,
      firestoreWrite: async () => {
        await db.collection('Clients').doc(uid).collection('notifications').doc(notificationId).delete();
      },
      context: 'notifications.delete',
    });

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

    res.json({
      settings: {
        ...data,
        // Legacy aliases
        pushEnabled: data.push_enabled ?? true,
        emailEnabled: data.email_enabled ?? true,
        smsEnabled: data.sms_enabled ?? false,
        createdAt: data.created_at ?? '',
        updatedAt: data.updated_at ?? '',
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateNotificationSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const settings = req.body;
    const db = getFirestore();

    const clientId = await resolveSupabaseClientId(uid);
    if (clientId) {
      await supabaseUpsertThenFirestore({
        table: 'notification_settings',
        supabaseData: { client_id: clientId, ...settings, updated_at: new Date().toISOString() },
        onConflict: 'client_id',
        firestoreWrite: async () => {
          await db.collection('Clients').doc(uid).collection('settings').doc('notifications').set(settings, { merge: true });
        },
        context: 'notifications.updateSettings',
      });
    } else {
      await db.collection('Clients').doc(uid).collection('settings').doc('notifications').set(settings, { merge: true });
    }

    res.json({ message: 'Notification settings updated', settings });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

