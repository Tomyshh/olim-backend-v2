import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import { getFirestore } from '../../config/firebase.js';

export async function v1GetMeMembership(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid!;
  const db = getFirestore();

  const clientDoc = await db.collection('Clients').doc(uid).get();
  if (!clientDoc.exists) {
    res.status(404).json({ message: 'Client not found', error: 'Client not found' });
    return;
  }

  const clientData = clientDoc.data() || {};

  // Priorité: freeAccess > membership (nouveau) > Membership (legacy)
  let subscription: any = null;

  if ((clientData as any).freeAccess?.isEnabled) {
    subscription = {
      type: 'freeAccess',
      status: 'active',
      expiresAt: (clientData as any).freeAccess.expiresAt,
      membership: (clientData as any).freeAccess.membership
    };
  } else if ((clientData as any).membership) {
    subscription = {
      type: 'membership',
      ...(clientData as any).membership
    };
  } else if ((clientData as any).Membership) {
    subscription = {
      type: 'membership',
      status: (clientData as any).isUnpaid ? 'unpaid' : 'active',
      plan: (clientData as any)['Membership Plan'],
      legacy: true
    };
  }

  // Abonnement actuel (nouvelle structure)
  const currentSubscriptionDoc = await db.collection('Clients').doc(uid).collection('subscription').doc('current').get();
  if (currentSubscriptionDoc.exists) {
    subscription = {
      ...subscription,
      ...currentSubscriptionDoc.data()
    };
  }

  // Membres famille (utile pour l'écran membership)
  const membersSnapshot = await db.collection('Clients').doc(uid).collection('Family Members').get();
  const familyMembers = membersSnapshot.docs.map((d) => ({ memberId: d.id, ...d.data() }));

  res.json({ subscription, familyMembers });
}


