import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore, getAuth } from '../config/firebase.js';

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
      await clientRef.update({
        fcmTokens: [...existingTokens, token],
        lastFcmToken: token,
        fcmTokenUpdatedAt: new Date()
      });
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
    const db = getFirestore();

    let query = db
      .collection('Clients')
      .doc(uid)
      .collection('notifications')
      .orderBy('createdAt', 'desc');

    if (unreadOnly === 'true') {
      query = query.where('read', '==', false) as any;
    }

    const snapshot = await query.limit(Number(limit)).get();

    const notifications = snapshot.docs.map(doc => ({
      notificationId: doc.id,
      ...doc.data()
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
    const db = getFirestore();

    const notificationDoc = await db
      .collection('Clients')
      .doc(uid)
      .collection('notifications')
      .doc(notificationId)
      .get();

    if (!notificationDoc.exists) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }

    res.json({ notificationId, ...notificationDoc.data() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function markAsRead(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { notificationId } = req.params;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('notifications')
      .doc(notificationId)
      .update({
        read: true,
        readAt: new Date()
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

    const unreadNotifications = await db
      .collection('Clients')
      .doc(uid)
      .collection('notifications')
      .where('read', '==', false)
      .get();

    const batch = db.batch();
    unreadNotifications.docs.forEach(doc => {
      batch.update(doc.ref, { read: true, readAt: new Date() });
    });
    await batch.commit();

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

    res.json({ message: 'Notification deleted', notificationId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getNotificationSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();

    const settingsDoc = await db
      .collection('Clients')
      .doc(uid)
      .collection('settings')
      .doc('notifications')
      .get();

    if (!settingsDoc.exists) {
      res.json({ settings: {} });
      return;
    }

    res.json({ settings: settingsDoc.data() });
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

    res.json({ message: 'Notification settings updated', settings });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

