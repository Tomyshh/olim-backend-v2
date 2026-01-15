import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { admin, getFirestore } from '../config/firebase.js';
import { HttpError } from '../utils/errors.js';
import {
  calculateSubscriptionStartDate,
  paymeCancelSubscription,
  paymeGenerateSale,
  paymeGenerateSubscription,
  paymeGetSubscriptionStatus,
  paymePauseSubscription,
  paymeResumeSubscription,
  paymeSetSubscriptionPrice
} from '../services/payme.service.js';

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function coercePositiveInt(value: unknown, label: string): number {
  const n = typeof value === 'string' ? Number(value.trim()) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${label} invalide.`);
  return Math.floor(n);
}

function coerceOptionalPositiveInt(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'string' ? Number(value.trim()) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function parseDdMmYyyy(value: string): Date | null {
  const m = String(value || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yyyy)) return null;
  // Date en timezone locale (cohérent avec le reste du code qui stocke des Date)
  return new Date(yyyy, mm - 1, dd, 12, 0, 0, 0);
}

function stripUndefinedDeep<T>(value: T): T {
  // IMPORTANT: ne jamais "cloner" certains objets Firestore (FieldValue, Timestamp, etc.)
  // sinon ils deviennent des maps vides ({}) dans Firestore.
  if (!value) return value;
  if (value instanceof Date) return value;
  if (value instanceof (admin.firestore as any).Timestamp) return value;
  // FieldValue (serverTimestamp, delete, increment, arrayUnion, etc.)
  if (typeof value === 'object' && typeof (value as any)._methodName === 'string') return value;

  if (Array.isArray(value)) return value.map((v) => stripUndefinedDeep(v)) as any;
  if (typeof value !== 'object') return value;

  const out: any = {};
  for (const [k, v] of Object.entries(value as any)) {
    if (v === undefined) continue;
    out[k] = stripUndefinedDeep(v as any);
  }
  return out;
}

async function writeAdminAuditLog(params: {
  action: string;
  callerUid: string | null;
  clientId: string;
  payload?: any;
  req: AuthenticatedRequest;
  extra?: Record<string, any>;
}): Promise<void> {
  try {
    const db = getFirestore();
    await db.collection('AdminAuditLogs').add({
      action: params.action,
      callerUid: params.callerUid,
      clientId: params.clientId,
      payload: params.payload ?? null,
      ...((params.extra || {}) as any),
      ip: params.req.ip || null,
      userAgent: params.req.get('user-agent') || null,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error: any) {
    console.error('AdminAuditLogs failed', { message: error?.message || String(error) });
  }
}

function isNonFatalPaymeCancelError(err: any): boolean {
  // PayMe peut refuser un cancel selon le statut côté PayMe (déjà annulé, non actif, etc.).
  // Dans ces cas, on veut quand même permettre un réabonnement (sale + subscription).
  const errorCode = (err as any)?.errorCode;
  const statusCode = Number((err as any)?.statusCode || 0);
  const message = String((err as any)?.message || '');

  // Observé en prod: errorCode 305 + message hébreu => on continue.
  if (errorCode === 305) return true;

  // Si PayMe renvoie 404 sur l'action (endpoint ou subId inexistant), on continue aussi.
  if (statusCode === 404) return true;

  // Heuristique: message explicite indiquant que l'action n'est pas possible selon le statut
  if (message.includes('סטטוס') || message.toLowerCase().includes('statut')) return true;

  return false;
}

async function loadClientAndSubscription(params: { clientId: string }): Promise<{
  clientRef: FirebaseFirestore.DocumentReference;
  client: Record<string, any>;
  subscriptionRef: FirebaseFirestore.DocumentReference;
  subscription: Record<string, any> | null;
}> {
  const db = getFirestore();
  const clientRef = db.collection('Clients').doc(params.clientId);
  const [clientSnap, subSnap] = await Promise.all([
    clientRef.get(),
    clientRef.collection('subscription').doc('current').get()
  ]);
  if (!clientSnap.exists) throw new HttpError(404, 'Client introuvable.');
  return {
    clientRef,
    client: (clientSnap.data() || {}) as any,
    subscriptionRef: clientRef.collection('subscription').doc('current'),
    subscription: subSnap.exists ? ((subSnap.data() || {}) as any) : null
  };
}

function extractPaymeIdentifiers(params: { client: Record<string, any>; subscription: Record<string, any> | null }): {
  subCode: number | string | null;
  subId: string | null;
} {
  // IMPORTANT: priorité au doc Clients/{uid}/subscription/current (source of truth backend).
  const subCode =
    params.subscription?.subCode ??
    params.subscription?.sub_payme_code ??
    params.subscription?.payme?.subCode ??
    params.subscription?.payme?.sub_payme_code ??
    // Fallback legacy
    params.client.israCard_subCode ??
    params.client.subCode ??
    params.client.paymeSubCode ??
    null;

  const subIdRaw =
    params.subscription?.payme?.subID ??
    params.subscription?.payme?.subId ??
    // Fallback legacy
    params.client.paymeSubID ??
    params.client['IsraCard Sub ID'] ??
    params.client.subID ??
    null;
  const subId = typeof subIdRaw === 'string' && subIdRaw.trim() ? subIdRaw.trim() : null;

  const normalizedSubCode =
    typeof subCode === 'number' && Number.isFinite(subCode)
      ? subCode
      : typeof subCode === 'string' && subCode.trim()
        ? subCode.trim()
        : null;

  return { subCode: normalizedSubCode, subId };
}

function extractMembershipFromSubscriptionCurrent(s: Record<string, any> | null): string {
  if (!s) return '';
  return (
    pickString(s?.plan?.membership) ||
    pickString(s?.plan?.Membership) ||
    pickString(s?.membership) ||
    ''
  );
}

function buildSubscriptionCurrentDoc(params: {
  planNumber: 3 | 4;
  membership: string;
  priceInCents: number;
  installments?: number | null;
  payme: { buyerKey: string; subCode?: number | string | null; subID?: string | null } | null;
  promoCode?: string | null;
  createdByUid?: string | null;
  nextPaymentDate?: Date | null;
  previousMembership?: string | null;
  previousPlan?: string | null;
}): Record<string, any> {
  const now = new Date();
  const isAnnual = params.planNumber === 4;
  const planType = isAnnual ? 'annual' : 'monthly';

  const endDate = new Date(now);
  if (isAnnual) endDate.setFullYear(endDate.getFullYear() + 1);
  else endDate.setMonth(endDate.getMonth() + 1);

  const nextPaymentDate = params.nextPaymentDate || new Date(endDate);

  return stripUndefinedDeep({
    plan: {
      type: planType,
      membership: params.membership,
      price: params.priceInCents,
      currency: 'ILS',
      basePriceInCents: params.priceInCents
    },
    payment: {
      method: 'credit-card',
      installments: params.installments && params.installments > 1 ? params.installments : 1,
      nextPaymentDate,
      lastPaymentDate: now
    },
    payme: {
      subCode: params.payme?.subCode ?? null,
      subID: params.payme?.subID ?? null,
      buyerKey: params.payme?.buyerKey ?? null,
      status: params.payme ? 1 : null
    },
    dates: {
      startDate: now,
      endDate,
      pausedDate: null,
      cancelledDate: null,
      resumedDate: null
    },
    states: {
      isActive: true,
      isPaused: false,
      willExpire: false,
      isAnnual
    },
    history: {
      previousMembership: params.previousMembership ?? null,
      previousPlan: params.previousPlan ?? null,
      lastModified: now,
      modifiedBy: params.createdByUid || 'system'
    },
    ...(params.promoCode ? { promoCode: params.promoCode } : {}),
    createdAt: now,
    updatedAt: now
  });
}

/**
 * GET /api/clients/:clientId/subscription/state
 * Retour: { success: true, paymeStatus: number|null }
 */
export async function getClientSubscriptionState(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientId = pickString((req.params as any)?.clientId);
  if (!clientId) throw new HttpError(400, 'clientId manquant.');

  const { client, subscription } = await loadClientAndSubscription({ clientId });

  // Règle: on "vérifie" d'abord le membership du doc subscription/current (source of truth).
  const membership = extractMembershipFromSubscriptionCurrent(subscription);

  // Si pas de doc subscription/current ou pas de membership, on considère qu'il n'y a pas d'abonnement PayMe à checker.
  const { subCode } = extractPaymeIdentifiers({ client, subscription });
  const paymeStatus = membership && subCode != null ? await paymeGetSubscriptionStatus(subCode) : null;

  res.status(200).json({
    success: true,
    membership: membership || null,
    paymeStatus,
    payme_status: paymeStatus,
    status: paymeStatus
  });
}

type CreateOrReplaceBody = {
  membership?: unknown;
  plan?: unknown; // "monthly" | "annual"
  paymentCredentialId?: unknown;
  priceInCents?: unknown;
  isReplacement?: unknown;
  installments?: unknown;
  promoCode?: unknown;
  useCustomPrice?: unknown;
};

/**
 * POST /api/clients/:clientId/subscription
 * Crée ou remplace l'abonnement PayMe (sale + subscription) pour un client existant.
 */
export async function createOrReplaceClientSubscription(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientId = pickString((req.params as any)?.clientId);
  if (!clientId) throw new HttpError(400, 'clientId manquant.');

  const callerUid = req.uid || null;
  const body = (req.body || {}) as CreateOrReplaceBody;

  const membership = pickString(body.membership);
  if (!membership) throw new HttpError(400, 'membership requis.');

  const plan = pickString(body.plan);
  if (plan !== 'monthly' && plan !== 'annual') throw new HttpError(400, 'plan invalide (monthly|annual).');
  const planNumber: 3 | 4 = plan === 'monthly' ? 3 : 4;

  const paymentCredentialId = pickString(body.paymentCredentialId);
  if (!paymentCredentialId) throw new HttpError(400, 'paymentCredentialId requis.');

  const priceInCents = coercePositiveInt(body.priceInCents, 'priceInCents');
  const installments = coerceOptionalPositiveInt(body.installments);
  const promoCode = pickString(body.promoCode) || null;
  const isReplacement = body.isReplacement === true;

  const { clientRef, client, subscriptionRef, subscription } = await loadClientAndSubscription({ clientId });

  const email = pickString(client.Email);
  if (!email) throw new HttpError(400, 'Client: Email manquant (requis pour PayMe).');

  // Si remplacement demandé: on annule d'abord l'abonnement mensuel existant (si présent)
  const existing = extractPaymeIdentifiers({ client, subscription });
  let cancelAttempted = false;
  let cancelSkippedAsNonFatal = false;
  if (isReplacement && existing.subId) {
    // Sécurité: bloquant => évite double abonnement actif
    cancelAttempted = true;
    try {
      await paymeCancelSubscription({ subId: existing.subId });
    } catch (e: any) {
      if (isNonFatalPaymeCancelError(e)) {
        cancelSkippedAsNonFatal = true;
        console.warn('[subscription] PayMe cancel non-bloquant (on continue le réabonnement)', {
          clientId,
          subId: existing.subId,
          statusCode: (e as any)?.statusCode,
          errorCode: (e as any)?.errorCode,
          message: String(e?.message || e)
        });
      } else {
        throw e;
      }
    }
  }

  // Charger buyerKey depuis Payment credentials/{paymentCredentialId}
  const db = getFirestore();
  const paymentRef = clientRef.collection('Payment credentials').doc(paymentCredentialId);
  const paymentSnap = await paymentRef.get();
  if (!paymentSnap.exists) throw new HttpError(404, 'Payment credential introuvable.');
  const buyerKey = pickString((paymentSnap.data() || {})['Isracard Key']);
  if (!buyerKey) throw new HttpError(400, 'Payment credential invalide: buyerKey PayMe manquant.');

  let salePaymeId: string | null = null;
  let subCode: number | string | null = null;
  let subID: string | null = null;
  let startDateDdMmYyyy: string | null = null;

  if (planNumber === 4) {
    // Annual: sale unique
    const sale = await paymeGenerateSale({
      priceInCents,
      description: membership,
      buyerKey,
      installments: installments && installments > 1 ? installments : undefined
    });
    salePaymeId = sale.salePaymeId;
  } else {
    // Monthly: sale immédiat + subscription future
    const sale = await paymeGenerateSale({
      priceInCents,
      description: `${membership} - Premier mois`,
      buyerKey
    });
    salePaymeId = sale.salePaymeId;

    startDateDdMmYyyy = calculateSubscriptionStartDate(3);
    const sub = await paymeGenerateSubscription({
      priceInCents,
      description: membership,
      email,
      buyerKey,
      planIterationType: 3,
      startDateDdMmYyyy
    });
    subCode = sub.subCode;
    subID = sub.subID;
  }

  const nextPaymentDate = planNumber === 3 && startDateDdMmYyyy ? parseDdMmYyyy(startDateDdMmYyyy) : null;

  // Firestore update (batch)
  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  batch.set(
    clientRef,
    stripUndefinedDeep({
      Membership: membership,
      subPlan: planNumber,
      isUnpaid: false,
      sale_payme_id: salePaymeId,
      // Legacy fields (si utilisés ailleurs)
      ...(subID ? { paymeSubID: subID, 'IsraCard Sub ID': subID } : {}),
      ...(subCode != null ? { israCard_subCode: subCode } : {}),
      updatedAt: now,
      updatedByAdminUid: callerUid,
      updatedByAdminAt: now,
      ...(promoCode ? { promoCodeUsed: promoCode } : {}),
      ...(body.useCustomPrice === true ? { useCustomPrice: true } : {})
    }),
    { merge: true }
  );

  const previousMembership =
    pickString(subscription?.plan?.membership) || pickString(subscription?.plan?.membershipType) || pickString(client.Membership) || null;
  const previousPlan = pickString(subscription?.plan?.type) || null;

  const subscriptionDoc = buildSubscriptionCurrentDoc({
    planNumber,
    membership,
    priceInCents,
    installments: installments,
    payme: planNumber === 3 ? { buyerKey, subCode, subID } : null,
    promoCode,
    createdByUid: callerUid,
    nextPaymentDate,
    previousMembership,
    previousPlan
  });
  batch.set(subscriptionRef, subscriptionDoc, { merge: true });

  await batch.commit();

  await writeAdminAuditLog({
    action: isReplacement ? 'CLIENT_SUBSCRIPTION_REPLACE' : 'CLIENT_SUBSCRIPTION_CREATE',
    callerUid,
    clientId,
    payload: { membership, plan, paymentCredentialId, priceInCents, installments, promoCode, isReplacement, useCustomPrice: body.useCustomPrice === true },
    req,
    extra: {
      salePaymeId,
      subCode: subCode ?? null,
      subID: subID ?? null,
      cancelAttempted,
      cancelSkippedAsNonFatal
    }
  });

  res.status(200).json({
    success: true,
    salePaymeId,
    subCode,
    subID,
    data: { salePaymeId, subCode, subID }
  });
}

type ModifyBody = {
  paymentCredentialId?: unknown;
  membership?: unknown;
  plan?: unknown;
  newPriceInCents?: unknown;
  installments?: unknown;
  promoCode?: unknown;
  useCustomPrice?: unknown;
};

/**
 * POST /api/clients/:clientId/subscription/modify
 * Le backend décide: set-price si possible, sinon replace.
 */
export async function modifyClientSubscription(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientId = pickString((req.params as any)?.clientId);
  if (!clientId) throw new HttpError(400, 'clientId manquant.');

  const callerUid = req.uid || null;
  const body = (req.body || {}) as ModifyBody;

  const paymentCredentialId = pickString(body.paymentCredentialId);
  if (!paymentCredentialId) throw new HttpError(400, 'paymentCredentialId requis.');

  const { clientRef, client, subscriptionRef, subscription } = await loadClientAndSubscription({ clientId });
  const currentPlanType = pickString(subscription?.plan?.type) || (Number(client.subPlan) === 4 ? 'annual' : 'monthly');
  const currentMembership = pickString(subscription?.plan?.membership) || pickString(client.Membership) || '';
  const currentPrice = Number(subscription?.plan?.price || 0) || null;

  const requestedPlan = pickString(body.plan) || currentPlanType;
  if (requestedPlan !== 'monthly' && requestedPlan !== 'annual') throw new HttpError(400, 'plan invalide (monthly|annual).');

  const requestedMembership = pickString(body.membership) || currentMembership;
  const requestedPrice = body.newPriceInCents != null ? coercePositiveInt(body.newPriceInCents, 'newPriceInCents') : currentPrice;
  if (!requestedMembership) throw new HttpError(400, 'membership manquant (aucun membership actuel détecté).');
  if (!requestedPrice) throw new HttpError(400, 'newPriceInCents manquant (aucun prix actuel détecté).');

  const installments = coerceOptionalPositiveInt(body.installments);
  const promoCode = pickString(body.promoCode) || null;

  const { subId } = extractPaymeIdentifiers({ client, subscription });

  const planChanged = requestedPlan !== currentPlanType;
  const membershipChanged = requestedMembership !== currentMembership;

  // Cas simple: abonnement mensuel existant + changement de prix uniquement => set-price
  if (!planChanged && !membershipChanged && requestedPlan === 'monthly' && subId && body.newPriceInCents != null) {
    await paymeSetSubscriptionPrice({ subId, priceInCents: requestedPrice });

    const db = getFirestore();
    const batch = db.batch();
    const now = admin.firestore.FieldValue.serverTimestamp();
    batch.set(
      subscriptionRef,
      {
        plan: { price: requestedPrice },
        updatedAt: now,
        history: { lastModified: now, modifiedBy: callerUid || 'system' }
      },
      { merge: true }
    );
    batch.set(
      clientRef,
      stripUndefinedDeep({
        updatedAt: now,
        updatedByAdminUid: callerUid,
        updatedByAdminAt: now,
        ...(promoCode ? { promoCodeUsed: promoCode } : {}),
        ...(body.useCustomPrice === true ? { useCustomPrice: true } : {})
      }),
      { merge: true }
    );
    await batch.commit();

    await writeAdminAuditLog({
      action: 'CLIENT_SUBSCRIPTION_SET_PRICE',
      callerUid,
      clientId,
      payload: { newPriceInCents: requestedPrice, paymentCredentialId, promoCode, useCustomPrice: body.useCustomPrice === true },
      req,
      extra: { subId }
    });

    res.status(200).json({ success: true });
    return;
  }

  // Sinon: replacement (crée un nouveau sale + (sub si monthly))
  (req as any).body = {
    membership: requestedMembership,
    plan: requestedPlan,
    paymentCredentialId,
    priceInCents: String(requestedPrice),
    isReplacement: true,
    installments: installments ?? undefined,
    promoCode: promoCode ?? undefined,
    useCustomPrice: body.useCustomPrice === true
  } satisfies CreateOrReplaceBody;

  await createOrReplaceClientSubscription(req, res);
}

async function updateSubscriptionStateDoc(params: {
  clientId: string;
  patch: Record<string, any>;
}): Promise<void> {
  const db = getFirestore();
  await db.collection('Clients').doc(params.clientId).collection('subscription').doc('current').set(stripUndefinedDeep(params.patch), { merge: true });
}

export async function pauseClientSubscription(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientId = pickString((req.params as any)?.clientId);
  if (!clientId) throw new HttpError(400, 'clientId manquant.');
  const callerUid = req.uid || null;

  const { client, subscription } = await loadClientAndSubscription({ clientId });
  const { subId } = extractPaymeIdentifiers({ client, subscription });
  if (!subId) throw new HttpError(400, 'Aucun abonnement PayMe actif (subId manquant).');

  await paymePauseSubscription({ subId });
  await updateSubscriptionStateDoc({
    clientId,
    patch: {
      states: { isPaused: true },
      dates: { pausedDate: new Date() },
      history: { lastModified: admin.firestore.FieldValue.serverTimestamp(), modifiedBy: callerUid || 'system' },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }
  });

  await writeAdminAuditLog({ action: 'CLIENT_SUBSCRIPTION_PAUSE', callerUid, clientId, payload: {}, req, extra: { subId } });
  res.status(200).json({ success: true });
}

export async function resumeClientSubscription(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientId = pickString((req.params as any)?.clientId);
  if (!clientId) throw new HttpError(400, 'clientId manquant.');
  const callerUid = req.uid || null;

  const { client, subscription } = await loadClientAndSubscription({ clientId });
  const { subId } = extractPaymeIdentifiers({ client, subscription });
  if (!subId) throw new HttpError(400, 'Aucun abonnement PayMe actif (subId manquant).');

  await paymeResumeSubscription({ subId });
  await updateSubscriptionStateDoc({
    clientId,
    patch: {
      states: { isPaused: false },
      dates: { resumedDate: new Date() },
      history: { lastModified: admin.firestore.FieldValue.serverTimestamp(), modifiedBy: callerUid || 'system' },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }
  });

  await writeAdminAuditLog({ action: 'CLIENT_SUBSCRIPTION_RESUME', callerUid, clientId, payload: {}, req, extra: { subId } });
  res.status(200).json({ success: true });
}

export async function cancelClientSubscription(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientId = pickString((req.params as any)?.clientId);
  if (!clientId) throw new HttpError(400, 'clientId manquant.');
  const callerUid = req.uid || null;

  const { client, subscription } = await loadClientAndSubscription({ clientId });
  const { subId } = extractPaymeIdentifiers({ client, subscription });
  if (!subId) throw new HttpError(400, 'Aucun abonnement PayMe actif (subId manquant).');

  await paymeCancelSubscription({ subId });
  await updateSubscriptionStateDoc({
    clientId,
    patch: {
      states: { willExpire: true, isActive: false },
      dates: { cancelledDate: new Date() },
      history: { lastModified: admin.firestore.FieldValue.serverTimestamp(), modifiedBy: callerUid || 'system' },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }
  });

  await writeAdminAuditLog({ action: 'CLIENT_SUBSCRIPTION_CANCEL', callerUid, clientId, payload: {}, req, extra: { subId } });
  res.status(200).json({ success: true });
}

type SetSubscriptionCardBody = { paymentCredentialId?: unknown };

/**
 * POST /api/clients/:clientId/payment-credentials/subscription-card
 * Body: { paymentCredentialId }
 */
export async function setClientSubscriptionCard(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientId = pickString((req.params as any)?.clientId);
  if (!clientId) throw new HttpError(400, 'clientId manquant.');
  const callerUid = req.uid || null;

  const body = (req.body || {}) as SetSubscriptionCardBody;
  const paymentCredentialId = pickString(body.paymentCredentialId);
  if (!paymentCredentialId) throw new HttpError(400, 'paymentCredentialId requis.');

  const db = getFirestore();
  const clientRef = db.collection('Clients').doc(clientId);
  const credsSnap = await clientRef.collection('Payment credentials').get();
  if (credsSnap.empty) throw new HttpError(404, 'Aucune carte trouvée.');

  const targetExists = credsSnap.docs.some((d) => d.id === paymentCredentialId);
  if (!targetExists) throw new HttpError(404, 'Payment credential introuvable.');

  const batch = db.batch();
  for (const doc of credsSnap.docs) {
    batch.set(doc.ref, { isSubscriptionCard: doc.id === paymentCredentialId }, { merge: true });
  }
  await batch.commit();

  await writeAdminAuditLog({
    action: 'CLIENT_SUBSCRIPTION_SET_CARD',
    callerUid,
    clientId,
    payload: { paymentCredentialId },
    req
  });

  res.status(200).json({ success: true });
}

type CustomSaleBody = {
  paymentCredentialId?: unknown;
  amountInCents?: unknown;
  description?: unknown;
  installments?: unknown;
};

/**
 * POST /api/clients/:clientId/sales
 * Body: { paymentCredentialId, amountInCents, description, installments? }
 */
export async function createClientCustomSale(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientId = pickString((req.params as any)?.clientId);
  if (!clientId) throw new HttpError(400, 'clientId manquant.');
  const callerUid = req.uid || null;

  const body = (req.body || {}) as CustomSaleBody;
  const paymentCredentialId = pickString(body.paymentCredentialId);
  if (!paymentCredentialId) throw new HttpError(400, 'paymentCredentialId requis.');
  const amountInCents = coercePositiveInt(body.amountInCents, 'amountInCents');
  const description = pickString(body.description);
  if (!description) throw new HttpError(400, 'description requise.');
  const installments = coerceOptionalPositiveInt(body.installments);

  const db = getFirestore();
  const paymentSnap = await db.collection('Clients').doc(clientId).collection('Payment credentials').doc(paymentCredentialId).get();
  if (!paymentSnap.exists) throw new HttpError(404, 'Payment credential introuvable.');
  const buyerKey = pickString((paymentSnap.data() || {})['Isracard Key']);
  if (!buyerKey) throw new HttpError(400, 'Payment credential invalide: buyerKey PayMe manquant.');

  const sale = await paymeGenerateSale({
    priceInCents: amountInCents,
    description,
    buyerKey,
    installments: installments && installments > 1 ? installments : undefined
  });

  await writeAdminAuditLog({
    action: 'CLIENT_CUSTOM_SALE',
    callerUid,
    clientId,
    payload: { paymentCredentialId, amountInCents, description, installments: installments ?? undefined },
    req,
    extra: { salePaymeId: sale.salePaymeId }
  });

  res.status(200).json({ success: true, salePaymeId: sale.salePaymeId });
}


