import type { Response } from 'express';
import crypto from 'crypto';
import { admin, getAuth, getFirestore } from '../config/firebase.js';
import type { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { HttpError } from '../utils/errors.js';
import {
  createSecurdenCreditCardAccountInFolder,
  normalizeCardNumberDigitsOnly,
  tryCreateSecurdenFolderAndCard
} from '../services/securden.service.js';
import {
  calculateSubscriptionStartDate,
  paymeCaptureBuyerToken,
  paymeGenerateSale,
  paymeGenerateSubscription
} from '../services/payme.service.js';

type CreateClientBody = {
  email?: unknown;
  password?: unknown;
  clientData?: unknown;
};

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeClientDataForFirestore(raw: Record<string, any>): Record<string, any> {
  // Jamais stocker ces champs (conformité)
  const { cardNumber, cvv, expirationDate, password, ...rest } = raw;
  void cardNumber;
  void cvv;
  void expirationDate;
  void password;
  return rest;
}

function coercePhoneField(value: unknown): string | string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
    if (normalized.length === 0) return undefined;
    if (normalized.length === 1) return normalized[0]!;
    return Array.from(new Set(normalized));
  }
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function coerceObject(value: unknown): Record<string, any> | undefined {
  if (!isPlainObject(value)) return undefined;
  if (Object.keys(value).length === 0) return undefined;
  return value;
}

function digitsOnly(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  return raw.replace(/\D+/g, '');
}

/**
 * Construit le document subscription/current avec la structure complète attendue.
 */
function buildSubscriptionCurrentDoc(params: {
  plan: number; // 3=monthly, 4=annual
  membershipType: string;
  priceInCents: number;
  payme: { buyerKey: string; buyerCard: string; subCode?: string | number | null; subID?: string | null } | null;
  installments?: number;
  subscriptionDataFromPayload?: Record<string, any>;
  createdByUid?: string;
}): Record<string, any> {
  const now = new Date();
  const isAnnual = params.plan === 4;
  const planType = isAnnual ? 'annual' : 'monthly';

  // Calculer endDate (1 mois ou 1 an après now)
  const endDate = new Date(now);
  if (isAnnual) {
    endDate.setFullYear(endDate.getFullYear() + 1);
  } else {
    endDate.setMonth(endDate.getMonth() + 1);
  }

  // Calculer nextPaymentDate (même logique que endDate pour le premier paiement)
  const nextPaymentDate = new Date(endDate);

  return {
    // 1. plan
    plan: {
      ...(params.subscriptionDataFromPayload?.plan || {}),
      type: planType,
      membership: params.membershipType || 'Pack Start',
      price: params.priceInCents,
      currency: 'ILS'
    },

    // 2. payment
    payment: {
      ...(params.subscriptionDataFromPayload?.payment || {}),
      method: 'credit-card',
      installments: params.installments && params.installments > 1 ? params.installments : 1,
      nextPaymentDate: nextPaymentDate,
      lastPaymentDate: now
    },

    // 3. payme
    payme: {
      ...(params.subscriptionDataFromPayload?.payme || {}),
      subCode: params.payme?.subCode ?? null,
      subID: params.payme?.subID ?? null,
      buyerKey: params.payme?.buyerKey ?? null,
      status: params.payme ? 1 : null, // 1 = actif
    },

    // 4. dates
    dates: {
      ...(params.subscriptionDataFromPayload?.dates || {}),
      startDate: now,
      endDate: endDate,
      pausedDate: null,
      cancelledDate: null,
      resumedDate: null
    },

    // 5. states
    states: {
      ...(params.subscriptionDataFromPayload?.states || {}),
      isActive: true,
      isPaused: false,
      willExpire: false,
      isAnnual: isAnnual
    },

    // 6. history
    history: {
      ...(params.subscriptionDataFromPayload?.history || {}),
      previousMembership: null,
      lastModified: now,
      modifiedBy: params.createdByUid || 'system'
    },

    // 7. promoCode (optionnel, depuis payload si fourni)
    ...(params.subscriptionDataFromPayload?.promoCode ? { promoCode: params.subscriptionDataFromPayload.promoCode } : {}),

    // Timestamps système
    createdAt: now,
    updatedAt: now
  };
}

function emailLockId(email: string): string {
  // Firestore docId safe
  return crypto.createHash('sha256').update(email).digest('hex');
}

function timestampToMs(value: any): number {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const d = value instanceof Date ? value : null;
  if (d) return d.getTime();
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapClientDoc(params: { uid: string; email: string; clientData: Record<string, any> }): Record<string, any> {
  const cd = params.clientData;

  // Champs STRICTS (ni plus ni moins) selon votre tableau (2 parties).
  // IMPORTANT: ne pas ajouter de champs “confort” en dehors de cette whitelist.
  const firstName = pickString(cd.firstName);
  const lastName = pickString(cd.lastName);
  const fatherName = pickString(cd.fatherName);
  const teoudatZeout = pickString(cd.teoudatZeout);
  const birthday = pickString(cd.birthday);
  const koupatHolim = pickString(cd.koupatHolim);
  const civility = pickString(cd.civility);
  const phone = coercePhoneField(cd.phoneNumber);

  const isFreeClient = cd.isFreeClient === true;
  const membership = pickString(cd.membershipType) || (isFreeClient ? 'Visitor' : '');
  const subPlanRaw = cd.plan;
  const subPlan = typeof subPlanRaw === 'number' ? subPlanRaw : isFreeClient ? 0 : Number(subPlanRaw || 0);

  const promoCodeUsed = pickString(cd.promoCodeUsed || cd.promoCode);
  const codePromoExpirationDate = cd.codePromoExpirationDate ?? null;

  const israCardSubCode = cd.subCode ?? cd.paymeSubCode ?? null;
  const israCardSubId = pickString(cd.paymeSubID || cd.subID);

  const doc: Record<string, any> = {
    'Client ID': params.uid,
    ...(params.email ? { Email: params.email } : {}),
    ...(lastName ? { 'Last Name': lastName } : {}),
    ...(firstName ? { 'First Name': firstName } : {}),
    ...(fatherName ? { 'Father Name': fatherName } : {}),
    ...(phone ? { 'Phone Number': phone } : {}),
    ...(teoudatZeout ? { 'Teoudat Zeout': teoudatZeout } : {}),
    ...(birthday ? { Birthday: birthday } : {}),
    ...(membership ? { Membership: membership } : {}),
    ...(koupatHolim ? { 'Koupat Holim': koupatHolim } : {}),
    ...(civility ? { Civility: civility } : {}),
    ...(typeof israCardSubCode === 'number' || typeof israCardSubCode === 'string' ? { israCard_subCode: israCardSubCode } : {}),
    Devices: Array.isArray(cd.Devices) ? cd.Devices : [],
    ...(pickString(cd.securden_Folder) ? { securden_Folder: pickString(cd.securden_Folder) } : {}),
    subPlan: Number.isFinite(subPlan) ? subPlan : isFreeClient ? 0 : 0,
    ...(promoCodeUsed ? { promoCodeUsed: promoCodeUsed } : {}),
    ...(codePromoExpirationDate ? { codePromoExpirationDate } : {}),
    createdFrom: 'CRM',
    language: 'fr',
    registrationComplete: true,
    registrationCompletedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  // Champs additionnels si inscription avec paiement
  if (!isFreeClient) {
    // Votre tableau mentionne aussi "Client UID" en supplément (paiement)
    doc['Client UID'] = params.uid;
    doc['Created At'] = admin.firestore.FieldValue.serverTimestamp();
    if (israCardSubId) doc['IsraCard Sub ID'] = israCardSubId;
    const salePaymeId = pickString(cd.sale_payme_id);
    if (salePaymeId) doc.sale_payme_id = salePaymeId;
    doc['Registration Status'] = 'completed';
  }

  return doc;
}

export async function createClient(req: AuthenticatedRequest, res: Response): Promise<void> {
  const startedAt = Date.now();
  const body = (req.body || {}) as CreateClientBody;

  const email = pickString(body.email).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !email.includes('@')) throw new HttpError(400, 'Email invalide.');
  if (!password || password.length < 6) throw new HttpError(400, 'Mot de passe invalide (min 6 caractères).');
  if (!isPlainObject(body.clientData)) throw new HttpError(400, 'clientData invalide.');

  const clientDataRaw = body.clientData;
  const clientData = sanitizeClientDataForFirestore(clientDataRaw);

  const firstName = pickString(clientData.firstName);
  const lastName = pickString(clientData.lastName);
  if (!firstName || !lastName) throw new HttpError(400, 'firstName/lastName requis.');

  const isPayingClient = clientData.isFreeClient === false;

  const auth = getAuth();
  const db = getFirestore();

  // ---------------------------------------------------------------------------
  // Idempotence (anti double-charge): lock Firestore par email AVANT PayMe
  // ---------------------------------------------------------------------------
  const lockRef = db.collection('ClientCreationLocks').doc(emailLockId(email));
  const lockTtlMs = 2 * 60 * 1000; // 2 min (clic double / retry réseau)

  // Si déjà traité récemment, éviter de relancer PayMe (risque de double prélèvement)
  const existingLock = await lockRef.get().catch(() => null as any);
  if (existingLock?.exists) {
    const data = existingLock.data() as any;
    const status = String(data?.status || '');
    const updatedAtMs = Math.max(timestampToMs(data?.updatedAt), timestampToMs(data?.startedAt));
    const ageMs = updatedAtMs ? Date.now() - updatedAtMs : Number.POSITIVE_INFINITY;
    const existingUid = typeof data?.uid === 'string' ? data.uid : null;

    if (status === 'completed' && existingUid) {
      res.status(200).json({
        success: true,
        uid: existingUid,
        securden: { folderId: null, accountId: null, warnings: ['Requête dupliquée: réponse idempotente (déjà créé).'] },
        payme: null,
        durationMs: Date.now() - startedAt
      });
      return;
    }

    if (status === 'in_progress' && ageMs <= lockTtlMs) {
      throw new HttpError(409, 'Création déjà en cours. Réessayez dans quelques secondes.');
    }
  }

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(lockRef);
    if (snap.exists) {
      const data = snap.data() as any;
      const status = String(data?.status || '');
      const updatedAtMs = Math.max(timestampToMs(data?.updatedAt), timestampToMs(data?.startedAt));
      const ageMs = updatedAtMs ? Date.now() - updatedAtMs : Number.POSITIVE_INFINITY;
      if (status === 'in_progress' && ageMs <= lockTtlMs) {
        throw new HttpError(409, 'Création déjà en cours. Réessayez dans quelques secondes.');
      }
    }
    tx.set(lockRef, { email, status: 'in_progress', startedAt: new Date(), updatedAt: new Date() }, { merge: true });
  });

  // Éviter de débiter si l'email existe déjà
  try {
    await auth.getUserByEmail(email);
    // si on arrive ici => user existe
    await lockRef.set({ status: 'failed', updatedAt: new Date(), lastError: 'email-already-exists' }, { merge: true }).catch(() => {});
    throw new HttpError(400, 'Email déjà existant.');
  } catch (e: any) {
    // ok si user-not-found
    if (e?.code && e.code !== 'auth/user-not-found') {
      await lockRef.set({ status: 'failed', updatedAt: new Date(), lastError: 'auth-check-failed' }, { merge: true }).catch(() => {});
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // PayMe.io (bloquant si échec) - avant création Auth/Firestore
  // ---------------------------------------------------------------------------
  let payme: null | { buyerKey: string; buyerCard: string; subCode?: string | number | null; subID?: string | null } = null;
  // Variables pour subscription/current (accessibles après PayMe)
  let planNumber = 0;
  let priceInCentsFinal = 0;
  let membershipTypeFinal = pickString(clientData.membershipType) || 'Pack Start';
  let installmentsUsed = 1;

  if (isPayingClient) {
    try {
      planNumber = Number(clientData.plan || 0);
      if (![3, 4].includes(planNumber)) throw new HttpError(400, 'Plan invalide (PayMe).');

      const cardNumberRaw = (body.clientData as any)?.cardNumber;
      const expRaw = (body.clientData as any)?.expirationDate;
      const cvvRaw = (body.clientData as any)?.cvv;

      if (!pickString(cardNumberRaw) || !pickString(expRaw) || !pickString(cvvRaw)) {
        throw new HttpError(400, 'Carte requise (cardNumber/expirationDate/cvv) pour un client payant.');
      }

      // Prix (centimes) - fallback sur valeurs connues si non fourni
      const priceFromPayload = Number((clientData as any).membershipPrice || 0);
      priceInCentsFinal = Number.isFinite(priceFromPayload) && priceFromPayload > 0 ? priceFromPayload : planNumber === 4 ? 249000 : 24900;
      membershipTypeFinal = pickString(clientData.membershipType) || 'Pack Start';
      const fullName = `${firstName} ${lastName}`.trim();
      const cardHolder = pickString((clientData as any).cardHolder) || fullName;
      const cardDigits = digitsOnly(cardNumberRaw);
      const cardSuffix = cardDigits.length >= 4 ? cardDigits.slice(-4) : '';

      // 1) capture buyer token (buyer_key)
      const buyerToken = await paymeCaptureBuyerToken({
        email,
        buyerName: fullName,
        cardHolder,
        cardNumber: cardNumberRaw,
        expirationDate: expRaw,
        cvv: cvvRaw
      });

      let subCode: string | number | null = null;
      let subID: string | null = null;

      if (planNumber === 4) {
        // Annuel: sale unique (installments optionnel)
        installmentsUsed = Number((clientData as any).selectedInstallments || 0);
        const sale = await paymeGenerateSale({
          priceInCents: priceInCentsFinal,
          description: membershipTypeFinal,
          buyerKey: buyerToken.buyerKey,
          installments: Number.isFinite(installmentsUsed) && installmentsUsed > 1 ? installmentsUsed : undefined
        });
        if (sale?.salePaymeId) clientData.sale_payme_id = sale.salePaymeId;
        subCode = null;
        subID = null;
      } else {
        // Mensuel: sale immédiat + subscription future (J+1 mois)
        const sale = await paymeGenerateSale({
          priceInCents: priceInCentsFinal,
          description: `${membershipTypeFinal} - Premier mois`,
          buyerKey: buyerToken.buyerKey
        });
        if (sale?.salePaymeId) clientData.sale_payme_id = sale.salePaymeId;

        const startDateDdMmYyyy = calculateSubscriptionStartDate(3);
        const sub = await paymeGenerateSubscription({
          priceInCents: priceInCentsFinal,
          description: membershipTypeFinal,
          email,
          buyerKey: buyerToken.buyerKey,
          planIterationType: 3,
          startDateDdMmYyyy
        });
        subCode = sub.subCode;
        subID = sub.subID;
      }

      payme = { buyerKey: buyerToken.buyerKey, buyerCard: buyerToken.buyerCard, subCode, subID };

      // Injecter dans clientData pour stockage Firestore (sans stocker la carte)
      clientData.buyerKey = buyerToken.buyerKey;
      clientData.buyerCard = buyerToken.buyerCard;
      if (cardSuffix) clientData.cardSuffix = cardSuffix;
      clientData.cardHolder = cardHolder;
      if (subCode != null) clientData.subCode = subCode;
      if (subID != null) clientData.paymeSubID = subID;
    } catch (err: any) {
      // IMPORTANT: PayMe est avant Firebase. Si PayMe échoue, on marque le lock en failed
      // pour éviter de bloquer en 409 "in_progress" puis de re-déclencher PayMe.
      await lockRef
        .set({ status: 'failed', updatedAt: new Date(), lastError: String(err?.message || err?.code || 'payme-failed') }, { merge: true })
        .catch(() => {});
      throw err;
    }
  }

  let uid: string | undefined;
  try {
    // 1) Firebase Auth
    const user = await auth.createUser({ email, password });
    uid = user.uid;

    // 2) Firestore
    const clientRef = db.collection('Clients').doc(uid);
    const batch = db.batch();

    const clientDoc = mapClientDoc({ uid, email, clientData });
    batch.set(clientRef, clientDoc, { merge: false });

    // Addresses (nouveau format)
    const addressRaw = pickString(clientData.address);
    const apartmentRaw = pickString(clientData.appartment);
    const floorRaw = pickString(clientData.etage);
    const additionalInfoRaw = pickString(clientData.additionalAddress);

    const hasAddress = Boolean(addressRaw);
    if (hasAddress) {
      batch.set(
        clientRef.collection('Addresses').doc('primary'),
        {
          name: pickString((clientData as any).addressName) || 'Adresse principale',
          address: addressRaw,
          apartment: apartmentRaw || null,
          floor: floorRaw || null,
          additionalInfo: additionalInfoRaw || null,
          details: pickString((clientData as any).addressDetails) || null,
          attachments: Array.isArray((clientData as any).addressAttachments)
            ? (clientData as any).addressAttachments.map((x: any) => String(x)).filter(Boolean)
            : [],
          isActive: true,
          deactivatedAt: null,
          orderIndex: 0,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          paymentInfo: (clientData as any).addressPaymentInfo && typeof (clientData as any).addressPaymentInfo === 'object'
            ? (clientData as any).addressPaymentInfo
            : null
        },
        { merge: true }
      );
    }

    // Family Members - Account Owner (le titulaire du compte)
    const accountOwnerDoc: Record<string, any> = {
      'Last Name': lastName,
      'First Name': firstName,
      'Father Name': pickString(clientData.fatherName),
      'Teoudat Zeout': pickString(clientData.teoudatZeout),
      Birthday: pickString(clientData.birthday),
      'Family Member Status': 'Account Owner',
      'Koupat Holim': pickString(clientData.koupatHolim),
      'Phone Number': coercePhoneField(clientData.phoneNumber) || [],
      Email: email,
      isConnected: false,
      hasGOVacces: false,
      createdAt: new Date()
    };
    batch.set(clientRef.collection('Family Members').doc('account_owner'), accountOwnerDoc, { merge: true });

    // NOTE: on ne crée qu'un seul document Family Members : account_owner

    // Payment credentials (si payant) - sans carte
    const paymentRef = clientRef.collection('Payment credentials').doc('first_registration');
    if (isPayingClient) {
      // IMPORTANT: selon votre tableau, Payment credentials doit contenir EXACTEMENT les champs listés.
      // Donc: pas de champ "payme" imbriqué, pas de champs "Updated *", pas de warnings, etc.
      const rawCardNumber = (body.clientData as any)?.cardNumber;
      const cardDigitsOnly = digitsOnly(rawCardNumber);
      const cardSuffix = cardDigitsOnly.length >= 4 ? cardDigitsOnly.slice(-4) : pickString((clientData as any).cardSuffix);
      const maskedCardNumber =
        cardDigitsOnly && cardSuffix
          ? `${'*'.repeat(Math.max(0, cardDigitsOnly.length - 4))}${cardSuffix}`
          : null;
      const cardHolder = pickString((clientData as any).cardHolder) || `${firstName} ${lastName}`.trim();
      const cardName = pickString((clientData as any).cardName) || cardHolder;
      batch.set(
        paymentRef,
        {
          // Champs attendus (doc) — STRICTEMENT comme dans le tableau.
          'Card Name': cardName,
          // Afficher uniquement les 4 derniers chiffres, le reste masqué par "*"
          'Card Number': maskedCardNumber,
          'Card Suffix': cardSuffix || null,
          'Card Holder': cardHolder || null,
          'Isracard Key': payme?.buyerKey ?? null,
          isSubscriptionCard: planNumber === 3,
          'Securden ID': null,
          'Created At': admin.firestore.FieldValue.serverTimestamp(),
          'Created From': 'CRM'
        },
        { merge: true }
      );
    }

    // subscription/current (structure complète pour clients payants, ou payload brut pour visiteurs)
    const subscriptionDataFromPayload = coerceObject((body.clientData as any)?.subscriptionData);
    if (isPayingClient) {
      const subscriptionDoc = buildSubscriptionCurrentDoc({
        plan: planNumber,
        membershipType: membershipTypeFinal,
        priceInCents: priceInCentsFinal,
        payme,
        installments: installmentsUsed,
        subscriptionDataFromPayload,
        createdByUid: req.uid
      });
      batch.set(clientRef.collection('subscription').doc('current'), subscriptionDoc, { merge: true });
    } else if (subscriptionDataFromPayload) {
      // Visiteur: stocker le payload tel quel (si fourni)
      batch.set(
        clientRef.collection('subscription').doc('current'),
        { ...subscriptionDataFromPayload, updatedAt: new Date(), createdAt: new Date() },
        { merge: true }
      );
    }

    await batch.commit();

    // 3) Securden (best effort)
    const securden = await tryCreateSecurdenFolderAndCard({
      firstName,
      lastName,
      isPayingClient,
      cardNumber: (body.clientData as any)?.cardNumber,
      expirationDate: (body.clientData as any)?.expirationDate,
      cvv: (body.clientData as any)?.cvv
    });

    // Stocker uniquement les IDs/état (jamais la carte)
    if (isPayingClient && (securden.folderId || securden.accountId || securden.warnings.length)) {
      // Mettre à jour le doc client avec l'ID du folder Securden (schéma Clients)
      if (securden.folderId) {
        await clientRef.set(
          {
            // IMPORTANT: selon votre tableau, seul `securden_Folder` est autorisé dans Clients
            securden_Folder: securden.folderId
          },
          { merge: true }
        ).catch(() => {});
      }

      await paymentRef
        .set(
          {
            // STRICT: uniquement le champ attendu par le tableau
            'Securden ID': securden.accountId || null
          },
          { merge: true }
        )
        .catch(() => {});
    }

    res.status(200).json({
      success: true,
      uid,
      securden: {
        folderId: securden.folderId || null,
        accountId: securden.accountId || null,
        warnings: securden.warnings || []
      },
      payme: payme
        ? { buyerCard: payme.buyerCard, subCode: payme.subCode ?? null, subID: payme.subID ?? null }
        : null,
      durationMs: Date.now() - startedAt
    });

    // Marquer lock completed
    await lockRef.set({ status: 'completed', uid, updatedAt: new Date() }, { merge: true }).catch(() => {});
  } catch (err: any) {
    // Si Firestore a échoué après création Auth => rollback user Auth
    if (uid) {
      await auth.deleteUser(uid).catch(() => {});
    }

    await lockRef
      .set({ status: 'failed', updatedAt: new Date(), lastError: String(err?.message || err?.code || 'unknown') }, { merge: true })
      .catch(() => {});

    // Firebase errors -> 400
    if (err?.code === 'auth/email-already-exists') throw new HttpError(400, 'Email déjà existant.');
    if (err?.code === 'auth/invalid-password') throw new HttpError(400, 'Mot de passe invalide.');
    if (err?.status) throw err;
    throw err;
  }
}

type AddClientCreditCardBody = {
  cardNumber?: unknown;
  expirationDate?: unknown;
  cvv?: unknown;
  cardHolder?: unknown;
  cardName?: unknown;
  isSubscriptionCard?: unknown;
  createdFrom?: unknown;
};

/**
 * POST /api/clients/:clientId/payment-credentials/credit-card
 * 1) Crée un compte "Credit Card 2" dans Securden (dans le folder du client si connu)
 * 2) Ajoute un doc dans Clients/{clientId}/Payment credentials (sans carte en clair)
 */
export async function addClientCreditCardPaymentCredential(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  if (req.method !== 'POST') throw new HttpError(405, 'Method Not Allowed');

  const clientId = pickString((req.params as any)?.clientId);
  if (!clientId) throw new HttpError(400, 'clientId manquant.');

  const body = (req.body || {}) as AddClientCreditCardBody;

  // Validation minimale
  const norm = normalizeCardNumberDigitsOnly(body.cardNumber);
  const expirationDate = typeof body.expirationDate === 'string' ? body.expirationDate.trim() : '';
  const cvv = typeof body.cvv === 'string' ? body.cvv.trim() : '';
  if (!norm.ok) throw new HttpError(400, 'cardNumber invalide.');
  if (!expirationDate) throw new HttpError(400, 'expirationDate requis.');
  if (!cvv) throw new HttpError(400, 'cvv requis.');

  const db = getFirestore();
  const clientRef = db.collection('Clients').doc(clientId);
  const clientSnap = await clientRef.get();
  if (!clientSnap.exists) throw new HttpError(404, 'Client introuvable.');

  const clientData = (clientSnap.data() || {}) as Record<string, any>;
  const firstName = pickString(clientData['First Name'] ?? clientData.firstName);
  const lastName = pickString(clientData['Last Name'] ?? clientData.lastName);
  const clientName = `${firstName} ${lastName}`.trim() || pickString(clientData.Email) || clientId;
  const email = pickString(clientData.Email);
  if (!email) throw new HttpError(400, 'Client: Email requis pour générer le buyer token (PayMe).');

  let folderId = pickString(clientData.securden_Folder);

  // 0) PayMe: capture buyer token (Isracard Key)
  // On le fait AVANT Securden pour éviter de créer une carte Securden si PayMe échoue.
  // NOTE: PayMe attend expirationDate au format "MM/YY".
  const cardHolder = pickString(body.cardHolder) || clientName;
  const buyerToken = await paymeCaptureBuyerToken({
    email,
    buyerName: clientName,
    cardHolder,
    cardNumber: norm.digitsOnly,
    expirationDate,
    cvv
  });

  // 1) Securden: créer account carte (réutiliser folder si présent)
  let accountId: string | undefined;
  const securdenWarnings: string[] = [];

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
  } else {
    if (!firstName || !lastName) throw new HttpError(400, 'Client: First Name / Last Name requis pour créer le folder Securden.');

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

  if (!accountId) {
    // Securden n'a pas créé l'account => on n'écrit pas dans Firestore
    throw new HttpError(502, `Securden: échec création de la carte. ${securdenWarnings[0] || ''}`.trim());
  }

  // 2) Firestore: Payment credentials (sans carte en clair)
  const cardSuffix = norm.digitsOnly.length >= 4 ? norm.digitsOnly.slice(-4) : null;
  const maskedCardNumber =
    cardSuffix ? `${'*'.repeat(Math.max(0, norm.digitsOnly.length - 4))}${cardSuffix}` : null;

  const cardName = pickString(body.cardName) || cardHolder;
  const isSubscriptionCard = body.isSubscriptionCard === true;
  const createdFrom = pickString(body.createdFrom) || 'CRM';

  const paymentDoc = {
    'Card Name': cardName,
    'Card Number': maskedCardNumber,
    'Card Holder': cardHolder || null,
    'Isracard Key': buyerToken.buyerKey,
    'Card Suffix': cardSuffix,
    isSubscriptionCard,
    'Securden ID': accountId,
    'Created At': admin.firestore.FieldValue.serverTimestamp(),
    'Created From': createdFrom
  };

  const paymentRef = await clientRef.collection('Payment credentials').add(paymentDoc as any);

  res.status(200).json({
    success: true,
    paymentCredentialId: paymentRef.id,
    payme: {
      buyerKey: buyerToken.buyerKey,
      buyerCard: buyerToken.buyerCard
    },
    securden: {
      folderId: folderId || null,
      accountId: accountId || null,
      warnings: securdenWarnings
    }
  });
}


