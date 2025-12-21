import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { getFirestore } from '../config/firebase.js';

export async function getSubscriptionStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();
    const clientDoc = await db.collection('Clients').doc(uid).get();

    if (!clientDoc.exists) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

    const clientData = clientDoc.data()!;

    // Priorité: freeAccess > membership (nouveau) > Membership (legacy)
    let subscription = null;

    if (clientData.freeAccess?.isEnabled) {
      subscription = {
        type: 'freeAccess',
        status: 'active',
        expiresAt: clientData.freeAccess.expiresAt,
        membership: clientData.freeAccess.membership
      };
    } else if (clientData.membership) {
      subscription = {
        type: 'membership',
        ...clientData.membership
      };
    } else if (clientData.Membership) {
      // Legacy
      subscription = {
        type: 'membership',
        status: clientData.isUnpaid ? 'unpaid' : 'active',
        plan: clientData['Membership Plan'],
        legacy: true
      };
    }

    // Récupérer abonnement actuel (nouvelle structure)
    const currentSubscriptionDoc = await db
      .collection('Clients')
      .doc(uid)
      .collection('subscription')
      .doc('current')
      .get();

    if (currentSubscriptionDoc.exists) {
      subscription = {
        ...subscription,
        ...currentSubscriptionDoc.data()
      };
    }

    res.json({ subscription });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getCards(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();
    const cardsSnapshot = await db
      .collection('Clients')
      .doc(uid)
      .collection('cards')
      .get();

    const cards = cardsSnapshot.docs.map(doc => ({
      cardId: doc.id,
      ...doc.data()
    }));

    res.json({ cards });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function addCard(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const cardData = req.body;
    const db = getFirestore();

    // TODO: Intégrer avec processeur de paiement (Stripe, etc.)
    // TODO: Stocker token sécurisé

    const cardRef = await db
      .collection('Clients')
      .doc(uid)
      .collection('cards')
      .add({
        ...cardData,
        createdAt: new Date()
      });

    res.status(201).json({ cardId: cardRef.id, ...cardData });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateCard(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { cardId } = req.params;
    const updates = req.body;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('cards')
      .doc(cardId)
      .update({
        ...updates,
        updatedAt: new Date()
      });

    res.json({ message: 'Card updated', cardId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function deleteCard(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { cardId } = req.params;
    const db = getFirestore();

    await db
      .collection('Clients')
      .doc(uid)
      .collection('cards')
      .doc(cardId)
      .delete();

    res.json({ message: 'Card deleted', cardId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function setDefaultCard(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { cardId } = req.params;
    const db = getFirestore();

    // Retirer isDefault de toutes les cartes
    const allCards = await db
      .collection('Clients')
      .doc(uid)
      .collection('cards')
      .get();

    const batch = db.batch();
    allCards.docs.forEach(doc => {
      batch.update(doc.ref, { isDefault: false });
    });
    await batch.commit();

    // Définir la nouvelle carte par défaut
    await db
      .collection('Clients')
      .doc(uid)
      .collection('cards')
      .doc(cardId)
      .update({ isDefault: true });

    res.json({ message: 'Default card set', cardId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getInvoices(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { limit = 50 } = req.query;
    const db = getFirestore();

    const invoicesSnapshot = await db
      .collection('Clients')
      .doc(uid)
      .collection('invoices')
      .orderBy('createdAt', 'desc')
      .limit(Number(limit))
      .get();

    const invoices = invoicesSnapshot.docs.map(doc => ({
      invoiceId: doc.id,
      ...doc.data()
    }));

    res.json({ invoices });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getInvoiceDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { invoiceId } = req.params;
    const db = getFirestore();

    const invoiceDoc = await db
      .collection('Clients')
      .doc(uid)
      .collection('invoices')
      .doc(invoiceId)
      .get();

    if (!invoiceDoc.exists) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }

    res.json({ invoiceId, ...invoiceDoc.data() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getRefundRequests(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();

    const refundsSnapshot = await db
      .collection('Clients')
      .doc(uid)
      .collection('refund_requests')
      .orderBy('createdAt', 'desc')
      .get();

    const refunds = refundsSnapshot.docs.map(doc => ({
      refundId: doc.id,
      ...doc.data()
    }));

    res.json({ refunds });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function createRefundRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { requestId, amount, reason } = req.body;
    const db = getFirestore();

    const refundRef = await db
      .collection('Clients')
      .doc(uid)
      .collection('refund_requests')
      .add({
        requestId: requestId || null,
        amount: Number(amount),
        reason: reason || '',
        status: 'pending',
        createdAt: new Date()
      });

    // ⚠️ TODO: Créer aussi dans RefundRequests global (admin)
    // ⚠️ TODO: Déclencher trigger onRefundRequestCreated (si activé)

    res.status(201).json({
      refundId: refundRef.id,
      requestId,
      amount,
      reason,
      status: 'pending'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getRefundRequestDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { refundId } = req.params;
    const db = getFirestore();

    const refundDoc = await db
      .collection('Clients')
      .doc(uid)
      .collection('refund_requests')
      .doc(refundId)
      .get();

    if (!refundDoc.exists) {
      res.status(404).json({ error: 'Refund request not found' });
      return;
    }

    res.json({ refundId, ...refundDoc.data() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

