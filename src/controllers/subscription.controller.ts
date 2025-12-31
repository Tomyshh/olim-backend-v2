import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { admin, getFirestore } from '../config/firebase.js';
import { paymeCaptureBuyerToken } from '../services/payme.service.js';
import {
  createSecurdenCreditCardAccountInFolder,
  normalizeCardNumberDigitsOnly,
  tryCreateSecurdenFolderAndCard
} from '../services/securden.service.js';

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function digitsOnly(value: unknown): string {
  return (typeof value === 'string' ? value : '').replace(/\D+/g, '');
}

function parseExpiryMmYy(value: unknown): { month: number | null; year: number | null; normalized: string } {
  const raw = pickString(value);
  // Accepte "MM/YY" ou "MM/YYYY"
  const m = raw.match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
  if (!m) return { month: null, year: null, normalized: raw };
  const month = Number(m[1]);
  let year = Number(m[2]);
  if (!Number.isFinite(month) || month < 1 || month > 12) return { month: null, year: null, normalized: raw };
  if (!Number.isFinite(year)) return { month: null, year: null, normalized: raw };
  if (year < 100) year = 2000 + year; // YY -> 20YY
  const normalized = `${String(month).padStart(2, '0')}/${String(year).slice(-2)}`;
  return { month, year, normalized };
}

function detectCardBrand(cardDigits: string): string {
  // Heuristique simple (non critique)
  if (/^4\d{12,18}$/.test(cardDigits)) return 'visa';
  if (/^(5[1-5]\d{14}|2(2[2-9]\d{12}|[3-6]\d{13}|7[01]\d{12}|720\d{12}))$/.test(cardDigits)) return 'mastercard';
  if (/^3[47]\d{13}$/.test(cardDigits)) return 'amex';
  if (/^6(011|5\d{2})\d{12}$/.test(cardDigits)) return 'discover';
  return '';
}

function mapPaymentCredentialToCard(docId: string, data: Record<string, any>): Record<string, any> {
  const suffix = pickString(data['Card Suffix']) || pickString(data.last4) || '';
  const masked = pickString(data['Card Number']);
  const last4 = suffix || (masked ? masked.replace(/\D+/g, '').slice(-4) : '');

  const expiryMonth = Number.isFinite(Number(data.expiryMonth)) ? Number(data.expiryMonth) : null;
  const expiryYear = Number.isFinite(Number(data.expiryYear)) ? Number(data.expiryYear) : null;
  const isDefault = data.isDefault === true;
  const brand = pickString(data.brand);

  return {
    cardId: docId,
    last4: last4 || '',
    brand: brand || '',
    expiryMonth: expiryMonth ?? null,
    expiryYear: expiryYear ?? null,
    isDefault,
    createdAt: data.createdAt ?? data['Created At'] ?? null,
    updatedAt: data.updatedAt ?? data['Updated At'] ?? null,
    // Champs additionnels utiles à l’app
    cardHolder: data['Card Holder'] ?? null,
    cardName: data['Card Name'] ?? null
  };
}

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

    // Source principale: Payment credentials (aligné CRM / PayMe tokenisation)
    const paymentSnapshot = await db
      .collection('Clients')
      .doc(uid)
      .collection('Payment credentials')
      .get();

    if (paymentSnapshot.size > 0) {
      const cards = paymentSnapshot.docs.map((d) => mapPaymentCredentialToCard(d.id, d.data() as any));
      res.json({ cards });
      return;
    }

    // Fallback legacy: Clients/{uid}/cards (si existe dans d’anciens environnements)
    const legacySnapshot = await db.collection('Clients').doc(uid).collection('cards').get();
    const cards = legacySnapshot.docs.map((doc) => ({
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
    const db = getFirestore();

    const body = (req.body || {}) as {
      cardNumber?: unknown;
      expirationDate?: unknown; // "MM/YY"
      cvv?: unknown;
      cardHolder?: unknown;
      cardName?: unknown;
      isSubscriptionCard?: unknown;
      isDefault?: unknown;
    };

    // Validation minimale
    const norm = normalizeCardNumberDigitsOnly(body.cardNumber);
    const expParsed = parseExpiryMmYy(body.expirationDate);
    const expirationDate = expParsed.normalized; // normalisé vers "MM/YY"
    const cvv = pickString(body.cvv);
    if (!norm.ok) {
      res.status(400).json({ error: 'cardNumber invalide.' });
      return;
    }
    if (!expirationDate) {
      res.status(400).json({ error: 'expirationDate requis.' });
      return;
    }
    if (!cvv) {
      res.status(400).json({ error: 'cvv requis.' });
      return;
    }

    // Charger client (nom + email) pour PayMe
    const clientRef = db.collection('Clients').doc(uid);
    const clientSnap = await clientRef.get();
    if (!clientSnap.exists) {
      res.status(404).json({ error: 'Client introuvable.' });
      return;
    }
    const clientData = (clientSnap.data() || {}) as Record<string, any>;
    const firstName = pickString(clientData['First Name'] ?? clientData.firstName);
    const lastName = pickString(clientData['Last Name'] ?? clientData.lastName);
    const clientName = `${firstName} ${lastName}`.trim() || pickString(clientData.Email) || uid;
    const email = pickString(clientData.Email);
    if (!email) {
      res.status(400).json({ error: 'Email requis pour générer le buyer token (PayMe).' });
      return;
    }

    // 1) PayMe: tokenisation (buyerKey)
    const cardHolder = pickString(body.cardHolder) || clientName;
    const buyerToken = await paymeCaptureBuyerToken({
      email,
      buyerName: clientName,
      cardHolder,
      cardNumber: norm.digitsOnly,
      expirationDate,
      cvv
    });

    // 2) Securden: best effort (ne doit pas bloquer l’app)
    let folderId = pickString(clientData.securden_Folder);
    let accountId: string | undefined;
    const securdenWarnings: string[] = [];

    try {
      if (folderId) {
        const result = await createSecurdenCreditCardAccountInFolder({
          folderId,
          clientName,
          cardNumber: norm.digitsOnly,
          expirationDate,
          cvv,
          isRegistration: false
        });
        accountId = result.accountId;
        securdenWarnings.push(...(result.warnings || []));
      } else if (firstName && lastName) {
        const securden = await tryCreateSecurdenFolderAndCard({
          firstName,
          lastName,
          isPayingClient: true,
          cardNumber: norm.digitsOnly,
          expirationDate,
          cvv
        });
        folderId = securden.folderId || '';
        accountId = securden.accountId;
        securdenWarnings.push(...(securden.warnings || []));
        if (folderId) {
          await clientRef.set({ securden_Folder: folderId }, { merge: true }).catch(() => {});
        }
      }
    } catch (e: any) {
      securdenWarnings.push('Securden: erreur inattendue (ignorée).');
    }

    // 3) Firestore: Payment credentials (sans carte en clair)
    const cardDigits = digitsOnly(body.cardNumber);
    const last4 = cardDigits.length >= 4 ? cardDigits.slice(-4) : '';
    const maskedCardNumber = last4 ? `${'*'.repeat(Math.max(0, cardDigits.length - 4))}${last4}` : null;
    const cardName = pickString(body.cardName) || cardHolder;
    const isSubscriptionCard = body.isSubscriptionCard === true;
    const isDefault = body.isDefault === true;
    const brand = detectCardBrand(norm.digitsOnly);

    const paymentDoc: Record<string, any> = {
      // Format "Payment credentials" (aligné avec CRM)
      'Card Name': cardName,
      'Card Number': maskedCardNumber,
      'Card Holder': cardHolder || null,
      'Isracard Key': buyerToken.buyerKey,
      'Card Suffix': last4 || null,
      isSubscriptionCard,
      'Securden ID': accountId || null,
      'Created At': admin.firestore.FieldValue.serverTimestamp(),
      'Created From': 'Mobile App',

      // Champs "Card" (OpenAPI / app)
      last4: last4 || buyerToken.buyerCard.replace(/\D+/g, '').slice(-4) || '',
      brand,
      expiryMonth: expParsed.month,
      expiryYear: expParsed.year,
      isDefault,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: null
    };

    const paymentRef = await clientRef.collection('Payment credentials').add(paymentDoc as any);

    // Compat legacy (optionnel): garder un doc minimal dans Clients/{uid}/cards
    await clientRef
      .collection('cards')
      .doc(paymentRef.id)
      .set(
        {
          last4: paymentDoc.last4,
          brand: paymentDoc.brand,
          expiryMonth: paymentDoc.expiryMonth,
          expiryYear: paymentDoc.expiryYear,
          isDefault: paymentDoc.isDefault,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      )
      .catch(() => {});

    res.status(201).json(mapPaymentCredentialToCard(paymentRef.id, paymentDoc));
  } catch (error: any) {
    res.status(error?.status || 500).json({ error: error.message });
  }
}

export async function updateCard(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { cardId } = req.params;
    const db = getFirestore();

    const updates = (req.body || {}) as Record<string, any>;
    // Sécurité: ne jamais accepter les champs sensibles
    delete updates.cardNumber;
    delete updates.cvv;
    delete updates.expirationDate;
    delete updates['Isracard Key'];
    delete updates.buyerKey;

    const paymentRef = db.collection('Clients').doc(uid).collection('Payment credentials').doc(cardId);
    const snap = await paymentRef.get();
    if (snap.exists) {
      await paymentRef.set(
        {
          ...updates,
          'Updated At': admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      res.json({ message: 'Card updated', cardId });
      return;
    }

    // fallback legacy
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

    // Supprimer dans Payment credentials (principal)
    await db.collection('Clients').doc(uid).collection('Payment credentials').doc(cardId).delete().catch(() => {});
    // Supprimer fallback legacy
    await db.collection('Clients').doc(uid).collection('cards').doc(cardId).delete().catch(() => {});

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

    const clientRef = db.collection('Clients').doc(uid);
    const batch = db.batch();

    // Ne pas créer un doc vide par accident si cardId est invalide
    const [credDoc, legacyDoc] = await Promise.all([
      clientRef.collection('Payment credentials').doc(cardId).get(),
      clientRef.collection('cards').doc(cardId).get()
    ]);
    if (!credDoc.exists && !legacyDoc.exists) {
      res.status(404).json({ error: 'Card not found' });
      return;
    }

    // Payment credentials
    const credsSnap = await clientRef.collection('Payment credentials').get();
    credsSnap.docs.forEach((d) => batch.set(d.ref, { isDefault: false }, { merge: true }));
    batch.set(clientRef.collection('Payment credentials').doc(cardId), { isDefault: true }, { merge: true });

    // Legacy cards (fallback)
    const legacySnap = await clientRef.collection('cards').get();
    legacySnap.docs.forEach((d) => batch.set(d.ref, { isDefault: false }, { merge: true }));
    batch.set(clientRef.collection('cards').doc(cardId), { isDefault: true }, { merge: true });

    await batch.commit();

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

