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
    const { limit = 200 } = req.query;
    // Certains documents historiques utilisent VIP / isVip / categories[].
    // On charge puis on filtre côté serveur pour éviter les trous de mapping.
    const snapshot = await db.collection('Partenaires').limit(Number(limit)).get();

    const partners = snapshot.docs
      .map(doc => ({ partnerId: doc.id, ...doc.data() }))
      .filter((partner: any) => {
        if (partner == null || typeof partner !== 'object') return false;
        if (partner.isVIP === true || partner.isVip === true || partner.VIP === true) {
          return true;
        }
        const tier = String(partner.tier || partner.type || partner.level || '').toLowerCase();
        if (tier.includes('vip')) return true;
        const tags = Array.isArray(partner.tags) ? partner.tags.map((x: any) => String(x).toLowerCase()) : [];
        const categories = Array.isArray(partner.categories) ? partner.categories.map((x: any) => String(x).toLowerCase()) : [];
        return tags.includes('vip') || categories.includes('vip');
      });

    res.json({ partners });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

