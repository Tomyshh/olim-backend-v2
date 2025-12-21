import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';

export async function getPartners(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const db = getFirestore();
    const { category, limit = 100 } = req.query;

    let query = db.collection('Partenaires');

    if (category) {
      query = query.where('category', '==', category) as any;
    }

    const snapshot = await query.limit(Number(limit)).get();

    const partners = snapshot.docs.map(doc => ({
      partnerId: doc.id,
      ...doc.data()
    }));

    res.json({ partners });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getPartnerDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { partnerId } = req.params;
    const db = getFirestore();

    const partnerDoc = await db.collection('Partenaires').doc(partnerId).get();

    if (!partnerDoc.exists) {
      res.status(404).json({ error: 'Partner not found' });
      return;
    }

    res.json({ partnerId, ...partnerDoc.data() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getVIPPartners(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const db = getFirestore();

    const vipSnapshot = await db
      .collection('Partenaires')
      .where('isVIP', '==', true)
      .get();

    const partners = vipSnapshot.docs.map(doc => ({
      partnerId: doc.id,
      ...doc.data()
    }));

    res.json({ partners });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

