import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';

// ⚠️ Toutes les routes admin sont stubées pour sécurité
// TODO: Ajouter middleware vérification rôle admin

export async function getRefundRequests(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const db = getFirestore();
    const { status, limit = 100 } = req.query;

    let query = db.collection('RefundRequests').orderBy('createdAt', 'desc');

    if (status) {
      query = query.where('status', '==', status) as any;
    }

    const snapshot = await query.limit(Number(limit)).get();

    const refunds = snapshot.docs.map(doc => ({
      refundId: doc.id,
      ...doc.data()
    }));

    res.json({ refunds });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateRefundRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { refundId } = req.params;
    const { status, processedAt } = req.body;
    const db = getFirestore();

    await db.collection('RefundRequests').doc(refundId).update({
      status,
      processedAt: processedAt || new Date(),
      updatedAt: new Date()
    });

    res.json({ message: 'Refund request updated', refundId, status });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getSystemAlerts(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const db = getFirestore();
    const { active, limit = 50 } = req.query;

    let query = db.collection('SystemAlerts').orderBy('createdAt', 'desc');

    if (active === 'true') {
      query = query.where('active', '==', true) as any;
    }

    const snapshot = await query.limit(Number(limit)).get();

    const alerts = snapshot.docs.map(doc => ({
      alertId: doc.id,
      ...doc.data()
    }));

    res.json({ alerts });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function createSystemAlert(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { title, message, type, active = true } = req.body;
    const db = getFirestore();

    const alertRef = await db.collection('SystemAlerts').add({
      title,
      message,
      type: type || 'info',
      active,
      createdAt: new Date()
    });

    res.status(201).json({
      alertId: alertRef.id,
      title,
      message,
      type,
      active
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

// ⚠️ DÉSACTIVÉ - Sync Supabase (manuel)
export async function syncFirestoreToSupabaseManual(req: AuthenticatedRequest, res: Response): Promise<void> {
  res.status(501).json({
    message: 'Not implemented - syncFirestoreToSupabaseManual',
    note: 'Fonction désactivée pour sécurité. À implémenter avec Supabase client.'
  });
}

// ⚠️ DÉSACTIVÉ - Génération token FCM OAuth
export async function generateFCMAccessToken(req: AuthenticatedRequest, res: Response): Promise<void> {
  res.status(501).json({
    message: 'Not implemented - generateFCMAccessToken',
    note: 'Fonction désactivée pour sécurité. À implémenter avec OAuth2 pour FCM.'
  });
}

