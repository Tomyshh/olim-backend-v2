import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { admin, getFirestore } from '../config/firebase.js';
import { HttpError } from '../utils/errors.js';
import {
  calculateSubscriptionStartDate,
  paymeCancelSubscription,
  paymeGenerateSale,
  paymeGenerateHostedSale,
  paymeGenerateSubscription,
  paymeGetSubscriptionDetails,
  paymeGetSubscriptionStatus,
  paymeListSubscriptions,
  paymePauseSubscription,
  paymeResumeSubscription,
  paymeSetSubscriptionDescription,
  paymeSetSubscriptionPrice
} from '../services/payme.service.js';
import { validateAndApplyPromo, type PromoValidationOk } from '../services/promoCode.service.js';
import { computeMembershipPricing, normalizePlan } from '../services/membershipPricing.service.js';
import { memberIsEligibleAdultSupplement } from '../services/familyBilling.service.js';
import { getFamilyMemberPricingNis, nisToCents } from '../services/remoteConfigPricing.service.js';
import { dualWriteSubscription, dualWriteClient, dualWritePaymentCredential, dualWriteToSupabase, dualWritePromoRevert, dualWritePromotion, resolveSupabaseClientId, resolveClientFirebaseUid } from '../services/dualWrite.service.js';
import { readClientInfo, readSubscription, readAllPaymentCredentials, readPaymentCredential, readFamilyMembers } from '../services/supabaseFirstRead.service.js';
import { supabase } from '../services/supabase.service.js';

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function pickClientId(req: { params?: any }): Promise<string> {
  const raw = pickString((req.params as any)?.clientId);
  if (!raw) throw new HttpError(400, 'clientId manquant.');
  const uid = await resolveClientFirebaseUid(raw);
  if (!uid) throw new HttpError(404, 'Client introuvable (ID non résolu).');
  return uid;
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

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0);
  return d;
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
    const auditData = {
      action: params.action,
      callerUid: params.callerUid,
      clientId: params.clientId,
      payload: params.payload ?? null,
      ...((params.extra || {}) as any),
      ip: params.req.ip || null,
      userAgent: params.req.get('user-agent') || null,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    const auditRef = await db.collection('AdminAuditLogs').add(auditData);
    dualWriteToSupabase('admin_audit_logs', {
      firestore_id: auditRef.id,
      action: params.action,
      caller_uid: params.callerUid,
      client_firebase_uid: params.clientId,
      payload: params.payload ?? null,
      ip: params.req.ip || null,
      user_agent: params.req.get('user-agent') || null,
      created_at: new Date().toISOString()
    }, { mode: 'insert' }).catch(() => {});
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

  // PayMe 371 = "מנוי לא נמצא" (abonnement non trouvé). Si l'abonnement n'existe plus côté PayMe,
  // on continue pour créer un nouvel abonnement (réabonnement depuis le CRM).
  if (errorCode === 371) return true;

  // Si PayMe renvoie 404 sur l'action (endpoint ou subId inexistant), on continue aussi.
  if (statusCode === 404) return true;

  // Heuristique: message explicite indiquant que l'action n'est pas possible selon le statut
  if (message.includes('סטטוס') || message.toLowerCase().includes('statut')) return true;

  // Abonnement non trouvé (hébreu "לא נמצא" ou variantes) => on continue pour créer un nouvel abonnement
  if (message.includes('לא נמצא') || message.toLowerCase().includes('not found') || message.toLowerCase().includes('n\'est pas trouvé')) return true;

  return false;
}

async function loadClientAndSubscription(params: { clientId: string }): Promise<{
  clientRef: FirebaseFirestore.DocumentReference;
  client: Record<string, any>;
  subscriptionRef: FirebaseFirestore.DocumentReference;
  subscription: Record<string, any> | null;
  firebaseUid: string;
}> {
  const firebaseUid = await resolveClientFirebaseUid(params.clientId) ?? params.clientId;

  const db = getFirestore();
  const clientRef = db.collection('Clients').doc(firebaseUid);

  const [clientData, subResult] = await Promise.all([
    readClientInfo(firebaseUid, async () => {
      const snap = await clientRef.get();
      if (!snap.exists) return null as any;
      return (snap.data() || {}) as any;
    }),
    readSubscription(firebaseUid, async () => {
      const snap = await clientRef.collection('subscription').doc('current').get();
      return { exists: snap.exists, data: snap.exists ? ((snap.data() || {}) as any) : null };
    })
  ]);

  if (!clientData) throw new HttpError(404, 'Client introuvable.');

  return {
    clientRef,
    client: clientData,
    subscriptionRef: clientRef.collection('subscription').doc('current'),
    subscription: subResult.exists ? subResult.data : null,
    firebaseUid,
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

function pickPaymeOverrideIdentifiers(body: any): { subId: string | null; subCode: number | string | null } {
  const subIdRaw =
    pickString(body?.subId) ||
    pickString(body?.subID) ||
    pickString(body?.paymeSubId) ||
    pickString(body?.paymeSubID) ||
    pickString(body?.sub_payme_id) ||
    '';
  const subId = subIdRaw ? subIdRaw : null;

  const subCodeRaw = body?.subCode ?? body?.sub_payme_code ?? body?.paymeSubCode ?? null;
  const subCode =
    typeof subCodeRaw === 'number' && Number.isFinite(subCodeRaw)
      ? subCodeRaw
      : typeof subCodeRaw === 'string' && subCodeRaw.trim()
        ? subCodeRaw.trim()
        : null;

  return { subId, subCode };
}

async function resolvePaymeTarget(params: {
  client: Record<string, any>;
  subscription: Record<string, any> | null;
  override?: { subId: string | null; subCode: number | string | null };
  forceList?: boolean;
}): Promise<{
  subId: string;
  subCode: number | string | null;
  source: 'override' | 'firestore' | 'payme_list';
  diagnostics: {
    email: string | null;
    extracted: { subId: string | null; subCode: number | string | null };
    override: { subId: string | null; subCode: number | string | null };
    remoteStatusFromExtractedSubCode: number | null;
    listCandidates: number;
  };
}> {
  const email = pickString(params.client?.Email) || null;
  const override = params.override || { subId: null, subCode: null };

  if (override.subId) {
    return {
      subId: override.subId,
      subCode: override.subCode ?? null,
      source: 'override',
      diagnostics: {
        email,
        extracted: extractPaymeIdentifiers({ client: params.client, subscription: params.subscription }),
        override,
        remoteStatusFromExtractedSubCode: null,
        listCandidates: 0
      }
    };
  }

  const extracted = extractPaymeIdentifiers({ client: params.client, subscription: params.subscription });
  let remoteStatusFromExtractedSubCode: number | null = null;

  // Heuristique: si subCode pointe vers un status=5 (annulé), il est probable qu'on pointe une ancienne subscription.
  // Dans ce cas, on tente de résoudre via la liste PayMe (email + status).
  let shouldUseList = Boolean(params.forceList);
  if (!shouldUseList && extracted.subCode != null) {
    try {
      remoteStatusFromExtractedSubCode = await paymeGetSubscriptionStatus(extracted.subCode);
      if (remoteStatusFromExtractedSubCode === 5) shouldUseList = true;
    } catch {
      // best-effort: si PayMe est indispo, on ne bascule pas automatiquement sur list
      remoteStatusFromExtractedSubCode = null;
    }
  }

  // Sans subId, on doit résoudre via list (si possible).
  if (!extracted.subId) shouldUseList = true;

  if (!shouldUseList) {
    return {
      subId: extracted.subId!,
      subCode: extracted.subCode ?? null,
      source: 'firestore',
      diagnostics: {
        email,
        extracted,
        override,
        remoteStatusFromExtractedSubCode,
        listCandidates: 0
      }
    };
  }

  // Résolution via PayMe list
  const all = await paymeListSubscriptions();
  const emailLc = (email || '').toLowerCase();
  const candidates = all.filter((it) => (it.subId || '').trim() && (it.email || '').toLowerCase() === emailLc);
  const listCandidates = candidates.length;

  // Statut PayMe observé en prod:
  // - 5 = annulé
  // - 2 = actif (observé dans vos logs)
  const active = candidates.filter((it) => it.subStatus != null && it.subStatus !== 5);
  const prefer = active.length > 0 ? active : candidates;

  // Choix: privilégier status=2, puis date la plus récente.
  const sorted = [...prefer].sort((a, b) => {
    const aActive = a.subStatus === 2 ? 1 : 0;
    const bActive = b.subStatus === 2 ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    const aT = (a.startDate?.getTime() || a.lastPaymentDate?.getTime() || 0) as number;
    const bT = (b.startDate?.getTime() || b.lastPaymentDate?.getTime() || 0) as number;
    return bT - aT;
  });

  const chosen = sorted[0] || null;
  if (!chosen?.subId) {
    throw new HttpError(409, "Impossible de résoudre la subscription PayMe active (aucun subId trouvé).");
  }

  return {
    subId: String(chosen.subId),
    subCode: chosen.subCode ?? null,
    source: 'payme_list',
    diagnostics: {
      email,
      extracted,
      override,
      remoteStatusFromExtractedSubCode,
      listCandidates
    }
  };
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
  const clientId = await pickClientId(req);
  const rawClientId = pickString((req.params as any)?.clientId);

  let membership: string | null = null;
  let paymeStatus: number | null = null;
  let sessionStatus: string | null = null;
  let isActive = false;

  // 1. Check Supabase subscriptions table directly (source of truth for CRM)
  const { data: subRow } = await supabase
    .from('subscriptions')
    .select('membership_type, payme_status, payme_sub_code, is_active')
    .or(`client_id.eq.${rawClientId}`)
    .limit(1)
    .maybeSingle();

  if (!subRow) {
    const resolvedId = await resolveSupabaseClientId(clientId);
    if (resolvedId) {
      const { data: subRow2 } = await supabase
        .from('subscriptions')
        .select('membership_type, payme_status, payme_sub_code, is_active')
        .eq('client_id', resolvedId)
        .maybeSingle();
      if (subRow2) {
        Object.assign(subRow ?? {}, subRow2);
      }
    }
  }

  const effectiveSub = subRow as any;
  if (effectiveSub?.membership_type) {
    membership = effectiveSub.membership_type;
    isActive = effectiveSub.is_active === true;
    const rawStatus = effectiveSub.payme_status;
    if (rawStatus != null) {
      paymeStatus = typeof rawStatus === 'number' ? rawStatus : parseInt(rawStatus, 10) || null;
    }
    if (effectiveSub.payme_sub_code && !paymeStatus) {
      try {
        paymeStatus = await paymeGetSubscriptionStatus(effectiveSub.payme_sub_code);
      } catch { /* ignore */ }
    }
  }

  // 2. Fallback: check Firestore subscription/current
  if (!membership) {
    try {
      const { subscription } = await loadClientAndSubscription({ clientId });
      membership = extractMembershipFromSubscriptionCurrent(subscription);
      if (subscription?.payme?.status != null) {
        paymeStatus = typeof subscription.payme.status === 'number' ? subscription.payme.status : parseInt(subscription.payme.status, 10) || null;
      }
      isActive = subscription?.states?.isActive === true;
    } catch { /* client not found is ok */ }
  }

  // 3. Check pending_payment_sessions for recent completed session
  const { data: recentSession } = await supabase
    .from('pending_payment_sessions')
    .select('status, membership, plan_type')
    .eq('client_firebase_uid', clientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recentSession) {
    sessionStatus = recentSession.status;
    if (recentSession.status === 'completed' && !membership) {
      membership = recentSession.membership;
      isActive = true;
    }
  }

  const confirmed = (paymeStatus === 1) || isActive || (sessionStatus === 'completed');

  res.status(200).json({
    success: true,
    membership: membership || null,
    paymeStatus: confirmed ? 1 : paymeStatus,
    payme_status: confirmed ? 1 : paymeStatus,
    status: confirmed ? 1 : paymeStatus,
    sessionStatus,
    isActive,
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
  const clientId = await pickClientId(req);

  const callerUid = req.uid || null;
  const body = (req.body || {}) as CreateOrReplaceBody;

  const membership = pickString(body.membership);
  if (!membership) throw new HttpError(400, 'membership requis.');

  const plan = pickString(body.plan);
  if (plan !== 'monthly' && plan !== 'annual') throw new HttpError(400, 'plan invalide (monthly|annual).');
  const planNumber: 3 | 4 = plan === 'monthly' ? 3 : 4;

  const paymentCredentialId = pickString(body.paymentCredentialId);
  if (!paymentCredentialId) throw new HttpError(400, 'paymentCredentialId requis.');

  let priceInCents = coercePositiveInt(body.priceInCents, 'priceInCents');
  const installments = coerceOptionalPositiveInt(body.installments);
  const promoCode = pickString(body.promoCode) || null;
  const isReplacement = body.isReplacement === true;

  // Validation du code promo (optionnel)
  let promoResult: PromoValidationOk | null = null;
  let basePriceBeforePromo = priceInCents;
  if (promoCode) {
    // Priorité: prix custom admin > Remote Config > fallback
    if (body.useCustomPrice === true) {
      // Le conseiller a choisi un prix manuellement, on l'utilise comme base promo
      basePriceBeforePromo = priceInCents;
    } else {
      const basePricing = await computeMembershipPricing({ membershipType: membership, plan });
      if (basePricing.ok) {
        basePriceBeforePromo = basePricing.serverPriceInCents;
      }
    }

    const promoValidation = await validateAndApplyPromo({
      promoCode,
      membershipTypeNormalized: membership,
      planNormalized: plan as 'monthly' | 'annual',
      basePriceInCents: basePriceBeforePromo
    });

    if (!promoValidation.ok) {
      throw new HttpError(400, `Code promo invalide: ${promoValidation.code}`, promoValidation.code);
    }

    promoResult = promoValidation;
    priceInCents = promoValidation.finalPriceInCents;
  }

  const { clientRef, client, subscriptionRef, subscription } = await loadClientAndSubscription({ clientId });

  const email = pickString(client.Email);
  if (!email) throw new HttpError(400, 'Client: Email manquant (requis pour PayMe).');

  // Si remplacement demandé: on annule d'abord l'abonnement mensuel existant (si présent)
  const existing = extractPaymeIdentifiers({ client, subscription });
  let cancelAttempted = false;
  let cancelSkippedAsNonFatal = false;
  // IMPORTANT: si on sait déjà (Firestore) que l'abonnement est annulé (status=5),
  // ne pas appeler PayMe cancel: ça peut renvoyer un 500/305 ("sale status not suitable") et ralentir inutilement la requête.
  const localSubStatusRaw =
    (subscription as any)?.payme?.status ??
    (subscription as any)?.payme?.sub_status ??
    (subscription as any)?.payme?.subStatus ??
    (subscription as any)?.status ??
    (subscription as any)?.sub_status ??
    (subscription as any)?.subStatus ??
    null;
  const localSubStatus =
    typeof localSubStatusRaw === 'string'
      ? Number(localSubStatusRaw)
      : typeof localSubStatusRaw === 'number'
        ? localSubStatusRaw
        : NaN;
  const isLocallyCancelled = Number.isFinite(localSubStatus) && localSubStatus === 5;

  if (isReplacement && existing.subId && !isLocallyCancelled) {
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
  } else if (isReplacement && existing.subId && isLocallyCancelled) {
    cancelSkippedAsNonFatal = true;
    console.warn('[subscription] PayMe cancel skip (déjà annulé en DB)', {
      clientId,
      subId: existing.subId,
      localSubStatus
    });
  }

  // Charger buyerKey depuis Payment credentials/{paymentCredentialId}
  const db = getFirestore();
  const paymentResult = await readPaymentCredential(clientId, paymentCredentialId, async () => {
    const snap = await clientRef.collection('Payment credentials').doc(paymentCredentialId).get();
    return { exists: snap.exists, data: snap.exists ? ((snap.data() || {}) as Record<string, any>) : null };
  });
  if (!paymentResult.exists || !paymentResult.data) throw new HttpError(404, 'Payment credential introuvable.');
  const buyerKey = pickString(paymentResult.data['Isracard Key']);
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
    promoCode: promoResult ? promoResult.promoCodeNormalized : promoCode,
    createdByUid: callerUid,
    nextPaymentDate,
    previousMembership,
    previousPlan
  });

  // Ajout du bloc pricing.promo si un code promo a été validé
  if (promoResult) {
    const promoDurationCycles = promoResult.durationCycles;
    const promoRevertAt = promoDurationCycles && promoDurationCycles > 0
      ? addMonths(nextPaymentDate || new Date(), promoDurationCycles)
      : null;
    (subscriptionDoc as any).pricing = {
      basePriceInCents: basePriceBeforePromo,
      discountInCents: promoResult.discountInCents,
      chargedPriceInCents: promoResult.finalPriceInCents,
      pricingSource: 'promo_applied',
      membershipTypeNormalized: membership,
      planNormalized: plan,
      promo: {
        promoCode: promoResult.promoCodeNormalized,
        promotionId: promoResult.promotionId,
        discountType: promoResult.discountType,
        discountValue: promoResult.discountValue,
        expiresAt: promoResult.expiresAt,
        durationCycles: promoDurationCycles,
        appliedAt: admin.firestore.FieldValue.serverTimestamp(),
        revertAt: promoRevertAt
      }
    };
    (subscriptionDoc as any).promoCode = {
      code: promoResult.promoCodeNormalized,
      reduction: promoResult.discountValue,
      appliedDate: new Date().toISOString(),
      expirationDate: promoResult.expiresAt ? promoResult.expiresAt.toISOString() : null,
      source: promoResult.promoCodeNormalized
    };
  }

  batch.set(subscriptionRef, subscriptionDoc, { merge: true });

  await batch.commit();

  // Dual-write: subscription/current + client
  dualWriteSubscription(clientId, subscriptionDoc).catch(() => {});
  dualWriteClient(clientId, {
    Membership: membership,
    subPlan: planNumber,
    isUnpaid: false,
    ...(promoCode ? { promoCodeUsed: promoCode } : {})
  }).catch(() => {});

  // Post-commit: gestion promo (désactivation usage unique + PromoReverts)
  if (promoResult) {
    const db2 = getFirestore();
    // Désactivation des codes à usage unique (forEveryone === false)
    if (!promoResult.forEveryone && promoResult.promotionId) {
      try {
        await db2.collection('Promotions').doc(promoResult.promotionId).set(
          { isValid: false, usedByUid: clientId, usedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
        dualWritePromotion(promoResult.promotionId, { isValid: false, usedByUid: clientId, usedAt: new Date() }).catch(() => {});
      } catch (e: any) {
        console.error('[createOrReplaceClientSubscription] Échec désactivation code promo:', e?.message);
      }
    }

    // Créer le PromoReverts pour la réversion automatique
    const promoDurationCycles = promoResult.durationCycles;
    if (promoDurationCycles && promoDurationCycles > 0) {
      const promoRevertAt = addMonths(nextPaymentDate || new Date(), promoDurationCycles);
      try {
        const promoRevertRef = await db2.collection('PromoReverts').add({
          uid: clientId,
          promoCode: promoResult.promoCodeNormalized,
          promotionId: promoResult.promotionId,
          revertAt: promoRevertAt,
          basePriceInCents: basePriceBeforePromo,
          discountedPriceInCents: priceInCents,
          planType: plan,
          membershipType: membership,
          paymeSubId: subID || null,
          durationCycles: promoDurationCycles,
          status: 'pending',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          source: 'crm_createOrReplace'
        });
        dualWritePromoRevert(promoRevertRef.id, {
          uid: clientId,
          promoCode: promoResult.promoCodeNormalized,
          promotionId: promoResult.promotionId,
          revertAt: promoRevertAt,
          basePriceInCents: basePriceBeforePromo,
          discountedPriceInCents: priceInCents,
          planType: plan,
          membershipType: membership,
          paymeSubId: subID || null,
          durationCycles: promoDurationCycles,
          status: 'pending',
          createdAt: new Date(),
          source: 'crm_createOrReplace'
        }).catch(() => {});
      } catch (e: any) {
        console.error('[createOrReplaceClientSubscription] Échec écriture PromoReverts:', e?.message);
      }
    }
  }

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
      cancelSkippedAsNonFatal,
      promoApplied: !!promoResult
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

type AdminPatchMembershipBody = {
  membership?: unknown;
};

type AdminSetPriceBody = {
  newPriceInCents?: unknown;
  // Optional overrides (debug/admin rescue):
  subId?: unknown;
  subCode?: unknown;
  paymeSubId?: unknown;
  paymeSubCode?: unknown;
};

/**
 * POST /api/clients/:clientId/subscription/modify
 * Le backend décide: set-price si possible, sinon replace.
 */
export async function modifyClientSubscription(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientId = await pickClientId(req);

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
  let requestedPrice = body.newPriceInCents != null ? coercePositiveInt(body.newPriceInCents, 'newPriceInCents') : currentPrice;
  if (!requestedMembership) throw new HttpError(400, 'membership manquant (aucun membership actuel détecté).');
  if (!requestedPrice) throw new HttpError(400, 'newPriceInCents manquant (aucun prix actuel détecté).');

  const installments = coerceOptionalPositiveInt(body.installments);
  const promoCode = pickString(body.promoCode) || null;

  // Validation du code promo (optionnel)
  let modifyPromoResult: PromoValidationOk | null = null;
  let modifyBasePriceBeforePromo = requestedPrice;
  if (promoCode) {
    // Priorité: prix custom admin > Remote Config > fallback
    if (body.useCustomPrice === true && body.newPriceInCents != null) {
      // Le conseiller a choisi un prix manuellement, on l'utilise comme base promo
      modifyBasePriceBeforePromo = requestedPrice;
    } else {
      const basePricing = await computeMembershipPricing({ membershipType: requestedMembership, plan: requestedPlan });
      if (basePricing.ok) {
        modifyBasePriceBeforePromo = basePricing.serverPriceInCents;
      }
    }

    const promoValidation = await validateAndApplyPromo({
      promoCode,
      membershipTypeNormalized: requestedMembership,
      planNormalized: requestedPlan as 'monthly' | 'annual',
      basePriceInCents: modifyBasePriceBeforePromo
    });

    if (!promoValidation.ok) {
      throw new HttpError(400, `Code promo invalide: ${promoValidation.code}`, promoValidation.code);
    }

    modifyPromoResult = promoValidation;
    requestedPrice = promoValidation.finalPriceInCents;
  }

  const { subId, subCode } = extractPaymeIdentifiers({ client, subscription });

  const planChanged = requestedPlan !== currentPlanType;
  const membershipChanged = requestedMembership !== currentMembership;

  // Cas simple: abonnement mensuel existant + changement de prix uniquement => set-price
  // IMPORTANT: si l'abonnement est annulé (PayMe status=5), PayMe peut refuser set-price (ex: errorCode 377).
  // Dans ce cas, on doit réabonner (replacement: sale + subscription).
  const localSubStatusRaw =
    (subscription as any)?.payme?.status ??
    (subscription as any)?.payme?.sub_status ??
    (subscription as any)?.payme?.subStatus ??
    (subscription as any)?.status ??
    (subscription as any)?.sub_status ??
    (subscription as any)?.subStatus ??
    null;
  const localSubStatus =
    typeof localSubStatusRaw === 'string'
      ? Number(localSubStatusRaw)
      : typeof localSubStatusRaw === 'number'
        ? localSubStatusRaw
        : NaN;
  const isLocallyCancelled = Number.isFinite(localSubStatus) && localSubStatus === 5;

  const eligibleForSetPrice =
    !planChanged && !membershipChanged && requestedPlan === 'monthly' && subId && body.newPriceInCents != null;

  let remoteStatus: number | null = null;
  if (eligibleForSetPrice && !isLocallyCancelled && subCode != null) {
    try {
      remoteStatus = await paymeGetSubscriptionStatus(subCode);
    } catch {
      // Best effort: si PayMe est indispo ici, on tentera set-price puis fallback si refus.
      remoteStatus = null;
    }
  }
  const isRemotelyCancelled = remoteStatus === 5;

  if (eligibleForSetPrice && !isLocallyCancelled && !isRemotelyCancelled) {
    try {
      await paymeSetSubscriptionPrice({ subId, priceInCents: requestedPrice });

      const db = getFirestore();
      const batch = db.batch();
      const now = admin.firestore.FieldValue.serverTimestamp();

      const setPriceSubUpdate: Record<string, any> = {
        plan: { price: requestedPrice },
        updatedAt: now,
        history: { lastModified: now, modifiedBy: callerUid || 'system' }
      };

      // Ajout du bloc pricing.promo si un code promo a été validé
      if (modifyPromoResult) {
        const promoDurationCycles = modifyPromoResult.durationCycles;
        const promoRevertAt = promoDurationCycles && promoDurationCycles > 0
          ? addMonths(new Date(), promoDurationCycles)
          : null;
        setPriceSubUpdate.pricing = {
          basePriceInCents: modifyBasePriceBeforePromo,
          discountInCents: modifyPromoResult.discountInCents,
          chargedPriceInCents: modifyPromoResult.finalPriceInCents,
          pricingSource: 'promo_applied',
          membershipTypeNormalized: requestedMembership,
          planNormalized: requestedPlan,
          promo: {
            promoCode: modifyPromoResult.promoCodeNormalized,
            promotionId: modifyPromoResult.promotionId,
            discountType: modifyPromoResult.discountType,
            discountValue: modifyPromoResult.discountValue,
            expiresAt: modifyPromoResult.expiresAt,
            durationCycles: promoDurationCycles,
            appliedAt: admin.firestore.FieldValue.serverTimestamp(),
            revertAt: promoRevertAt
          }
        };
        setPriceSubUpdate.promoCode = {
          code: modifyPromoResult.promoCodeNormalized,
          reduction: modifyPromoResult.discountValue,
          appliedDate: new Date().toISOString(),
          expirationDate: modifyPromoResult.expiresAt ? modifyPromoResult.expiresAt.toISOString() : null,
          source: modifyPromoResult.promoCodeNormalized
        };
      }

      batch.set(subscriptionRef, setPriceSubUpdate, { merge: true });
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

      // Dual-write: subscription set-price update
      dualWriteSubscription(clientId, { ...subscription, ...setPriceSubUpdate }).catch(() => {});

      // Post-commit: gestion promo (désactivation usage unique + PromoReverts)
      if (modifyPromoResult) {
        if (!modifyPromoResult.forEveryone && modifyPromoResult.promotionId) {
          try {
            await db.collection('Promotions').doc(modifyPromoResult.promotionId).set(
              { isValid: false, usedByUid: clientId, usedAt: admin.firestore.FieldValue.serverTimestamp() },
              { merge: true }
            );
            dualWritePromotion(modifyPromoResult.promotionId, { isValid: false, usedByUid: clientId, usedAt: new Date() }).catch(() => {});
          } catch (e: any) {
            console.error('[modifyClientSubscription] Échec désactivation code promo:', e?.message);
          }
        }

        const promoDurationCycles = modifyPromoResult.durationCycles;
        if (promoDurationCycles && promoDurationCycles > 0) {
          const promoRevertAt = addMonths(new Date(), promoDurationCycles);
          try {
            const promoRevertRef = await db.collection('PromoReverts').add({
              uid: clientId,
              promoCode: modifyPromoResult.promoCodeNormalized,
              promotionId: modifyPromoResult.promotionId,
              revertAt: promoRevertAt,
              basePriceInCents: modifyBasePriceBeforePromo,
              discountedPriceInCents: requestedPrice,
              planType: requestedPlan,
              membershipType: requestedMembership,
              paymeSubId: subId || null,
              durationCycles: promoDurationCycles,
              status: 'pending',
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              source: 'crm_modify_setPrice'
            });
            dualWritePromoRevert(promoRevertRef.id, {
              uid: clientId,
              promoCode: modifyPromoResult.promoCodeNormalized,
              promotionId: modifyPromoResult.promotionId,
              revertAt: promoRevertAt,
              basePriceInCents: modifyBasePriceBeforePromo,
              discountedPriceInCents: requestedPrice,
              planType: requestedPlan,
              membershipType: requestedMembership,
              paymeSubId: subId || null,
              durationCycles: promoDurationCycles,
              status: 'pending',
              createdAt: new Date(),
              source: 'crm_modify_setPrice'
            }).catch(() => {});
          } catch (e: any) {
            console.error('[modifyClientSubscription] Échec écriture PromoReverts:', e?.message);
          }
        }
      }

      await writeAdminAuditLog({
        action: 'CLIENT_SUBSCRIPTION_SET_PRICE',
        callerUid,
        clientId,
        payload: { newPriceInCents: requestedPrice, paymentCredentialId, promoCode, useCustomPrice: body.useCustomPrice === true },
        req,
        extra: {
          subId,
          subCode: subCode ?? null,
          localSubStatus: Number.isFinite(localSubStatus) ? localSubStatus : null,
          remoteStatus,
          promoApplied: !!modifyPromoResult
        }
      });

      res.status(200).json({ success: true });
      return;
    } catch (e: any) {
      console.warn('[subscription] set-price failed -> fallback to replacement', {
        clientId,
        subId,
        subCode: subCode ?? null,
        localSubStatus: Number.isFinite(localSubStatus) ? localSubStatus : null,
        remoteStatus,
        statusCode: e?.statusCode ?? e?.status ?? null,
        errorCode: e?.errorCode ?? null,
        message: String(e?.message || e)
      });
      // Fallback vers replacement ci-dessous
    }
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

/**
 * PATCH /api/clients/:clientId/subscription/admin/membership
 *
 * Admin-only safe operation:
 * - modifie UNIQUEMENT Firestore `Clients/{clientId}/subscription/current.plan.membership`
 * - ne touche PAS PayMe
 * - ne (re)crée JAMAIS de sale/subscription
 */
export async function adminPatchSubscriptionMembershipFirestoreOnly(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientId = await pickClientId(req);

  const callerUid = req.uid || null;
  const body = (req.body || {}) as AdminPatchMembershipBody;
  const membership = pickString(body.membership);
  if (!membership) throw new HttpError(400, 'membership requis.');

  const { subscriptionRef, subscription } = await loadClientAndSubscription({ clientId });
  if (!subscription) throw new HttpError(409, "Aucun doc subscription/current: impossible de modifier le membership.");

  const currentMembership = pickString(subscription?.plan?.membership) || null;
  const now = admin.firestore.FieldValue.serverTimestamp();

  const db = getFirestore();
  const batch = db.batch();
  batch.set(
    subscriptionRef,
    {
      plan: { membership },
      updatedAt: now,
      history: { lastModified: now, modifiedBy: callerUid || 'system', previousMembership: currentMembership }
    },
    { merge: true }
  );
  await batch.commit();
  dualWriteSubscription(clientId, { ...subscription, plan: { ...subscription?.plan, membership } }).catch(() => {});

  await writeAdminAuditLog({
    action: 'CLIENT_SUBSCRIPTION_ADMIN_PATCH_MEMBERSHIP_FIRESTORE_ONLY',
    callerUid,
    clientId,
    payload: { membership, previousMembership: currentMembership },
    req
  });

  res.status(200).json({ success: true });
}

/**
 * PATCH /api/clients/:clientId/subscription/admin/payme/price
 *
 * Admin-only safe operation:
 * - modifie UNIQUEMENT PayMe via set-price
 * - ne touche PAS Firestore
 * - ne (re)crée JAMAIS de sale/subscription
 */
export async function adminSetPaymeSubscriptionPriceOnly(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientId = await pickClientId(req);

  const callerUid = req.uid || null;
  const body = (req.body || {}) as AdminSetPriceBody;
  const newPriceInCents = coercePositiveInt(body.newPriceInCents, 'newPriceInCents');

  const { client, subscription } = await loadClientAndSubscription({ clientId });
  const override = pickPaymeOverrideIdentifiers(body);

  // Résoudre la bonne subscription PayMe (utile si Firestore pointe une ancienne sub annulée).
  const target = await resolvePaymeTarget({ client, subscription, override });

  // Ne pas bloquer sur subCode (souvent obsolète). On tente set-price sur subId.
  // Si PayMe refuse parce que l'abonnement est annulé/inactif, on renverra l'erreur PayMe telle quelle.
  try {
    await paymeSetSubscriptionPrice({ subId: target.subId, priceInCents: newPriceInCents });
  } catch (e: any) {
    // Tentative de secours: si la résolution venait de Firestore, retenter via list PayMe.
    if (target.source !== 'payme_list') {
      const target2 = await resolvePaymeTarget({ client, subscription, override, forceList: true });
      await paymeSetSubscriptionPrice({ subId: target2.subId, priceInCents: newPriceInCents });
      await writeAdminAuditLog({
        action: 'CLIENT_SUBSCRIPTION_ADMIN_SET_PAYME_PRICE_ONLY',
        callerUid,
        clientId,
        payload: { newPriceInCents, target: target2, recoveredFrom: target },
        req
      });
      res.status(200).json({ success: true, target: target2 });
      return;
    }
    throw e;
  }

  await writeAdminAuditLog({
    action: 'CLIENT_SUBSCRIPTION_ADMIN_SET_PAYME_PRICE_ONLY',
    callerUid,
    clientId,
    payload: { newPriceInCents, target },
    req
  });

  res.status(200).json({ success: true, target });
}

/**
 * PATCH /api/clients/:clientId/subscription/admin/membership-and-payme-price
 *
 * Admin-only safe operation:
 * - Firestore: modifie UNIQUEMENT `subscription/current.plan.membership`
 * - PayMe: set-price
 * - ne (re)crée JAMAIS de sale/subscription
 */
export async function adminPatchMembershipAndSetPaymePrice(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientId = await pickClientId(req);

  const callerUid = req.uid || null;
  const body = (req.body || {}) as (AdminPatchMembershipBody & AdminSetPriceBody);

  const membership = pickString((body as any).membership);
  if (!membership) throw new HttpError(400, 'membership requis.');

  const { client, subscriptionRef, subscription, firebaseUid } = await loadClientAndSubscription({ clientId });
  if (!subscription) throw new HttpError(409, "Aucun doc subscription/current: impossible de modifier le membership.");

  let newPriceInCents: number;
  if ((body as any).newPriceInCents != null) {
    newPriceInCents = coercePositiveInt((body as any).newPriceInCents, 'newPriceInCents');
  } else {
    const currentPlan = pickString(subscription?.plan?.type) || (Number(client.subPlan) === 4 ? 'annual' : 'monthly');
    const pricing = await computeMembershipPricing({ membershipType: membership, plan: currentPlan });
    if (!pricing.ok) throw new HttpError(400, `Impossible de calculer le prix pour ${membership} / ${currentPlan}`);
    let baseCents = pricing.serverPriceInCents;

    const db = getFirestore();
    const familyMembers = await readFamilyMembers(firebaseUid, async () => {
      const snap = await db.collection('Clients').doc(firebaseUid).collection('Family Members').get();
      return snap.docs.map((d) => ({ id: d.id, data: (d.data() || {}) as Record<string, any> }));
    });
    const eligibleAdults = familyMembers.filter((m) => memberIsEligibleAdultSupplement(m.id, m.data));
    if (eligibleAdults.length > 0) {
      const familyPricing = await getFamilyMemberPricingNis();
      baseCents += eligibleAdults.length * nisToCents(familyPricing.monthlyNis);
    }
    newPriceInCents = baseCents;
  }

  const override = pickPaymeOverrideIdentifiers(body);
  let target = await resolvePaymeTarget({ client, subscription, override });

  // 1) PayMe d'abord: si PayMe échoue, on ne touche pas Firestore.
  // Mettre aussi à jour la description pour qu'elle reflète le pack côté Isracard/PayMe.
  let descriptionUpdate: { ok: boolean; used?: any; error?: any } = { ok: true };
  try {
    const used = await paymeSetSubscriptionDescription({ subId: target.subId, subCode: target.subCode, description: membership });
    descriptionUpdate = { ok: true, used };
  } catch (e: any) {
    // Best-effort: la mise à jour de description peut ne pas être supportée par PayMe.
    // On continue quand même avec set-price (objectif principal).
    descriptionUpdate = { ok: false, error: { message: e?.message || String(e), code: (e as any)?.code || null } };
  }
  try {
    await paymeSetSubscriptionPrice({ subId: target.subId, priceInCents: newPriceInCents });
  } catch (e: any) {
    // Secours: si Firestore pointe une ancienne subscription, retenter via la liste PayMe.
    if (target.source !== 'payme_list') {
      const target2 = await resolvePaymeTarget({ client, subscription, override, forceList: true });
      target = target2;
      await paymeSetSubscriptionPrice({ subId: target2.subId, priceInCents: newPriceInCents });
    } else {
      throw e;
    }
  }

  // Vérifier (best-effort) la description réellement visible côté PayMe
  let observedDescription: string | null = null;
  try {
    const list = await paymeListSubscriptions();
    const found = list.find((it) => String(it.subId || '').trim() === String(target.subId).trim());
    observedDescription = found?.description ?? null;
  } catch {
    observedDescription = null;
  }

  // 2) Firestore: membership uniquement.
  const previousMembership = pickString(subscription?.plan?.membership) || null;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const db = getFirestore();
  const batch = db.batch();
  batch.set(
    subscriptionRef,
    {
      plan: { membership },
      updatedAt: now,
      history: { lastModified: now, modifiedBy: callerUid || 'system', previousMembership }
    },
    { merge: true }
  );
  await batch.commit();
  dualWriteSubscription(clientId, { ...subscription, plan: { ...subscription?.plan, membership } }).catch(() => {});

  await writeAdminAuditLog({
    action: 'CLIENT_SUBSCRIPTION_ADMIN_PATCH_MEMBERSHIP_AND_SET_PAYME_PRICE',
    callerUid,
    clientId,
    payload: {
      membership,
      previousMembership,
      newPriceInCents,
      target,
      descriptionUpdate,
      observedDescription
    },
    req
  });

  res.status(200).json({ success: true, target, descriptionUpdate, observedDescription });
}

/**
 * PATCH /api/clients/:clientId/subscription/admin/membership-and-payme-description
 *
 * Admin-only safe operation:
 * - Firestore: modifie UNIQUEMENT `subscription/current.plan.membership`
 * - PayMe: met à jour UNIQUEMENT la description (sub_description)
 * - ne (re)crée JAMAIS de sale/subscription
 */
export async function adminPatchMembershipAndSetPaymeDescription(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientId = await pickClientId(req);

  const callerUid = req.uid || null;
  const body = (req.body || {}) as AdminPatchMembershipBody;
  const membership = pickString(body.membership);
  if (!membership) throw new HttpError(400, 'membership requis.');

  const { client, subscriptionRef, subscription } = await loadClientAndSubscription({ clientId });
  if (!subscription) throw new HttpError(409, "Aucun doc subscription/current: impossible de modifier le membership.");

  const override = pickPaymeOverrideIdentifiers(body);
  let target = await resolvePaymeTarget({ client, subscription, override });

  // 1) PayMe d'abord: si PayMe échoue, on ne touche pas Firestore.
  let used: any = null;
  try {
    used = await paymeSetSubscriptionDescription({ subId: target.subId, subCode: target.subCode, description: membership });
  } catch (e: any) {
    if (target.source !== 'payme_list') {
      const target2 = await resolvePaymeTarget({ client, subscription, override, forceList: true });
      target = target2;
      used = await paymeSetSubscriptionDescription({ subId: target2.subId, subCode: target2.subCode, description: membership });
    } else {
      throw e;
    }
  }

  // Vérifier (best-effort) la description réellement visible côté PayMe
  let observedDescription: string | null = null;
  try {
    const list = await paymeListSubscriptions();
    const found = list.find((it) => String(it.subId || '').trim() === String(target.subId).trim());
    observedDescription = found?.description ?? null;
  } catch {
    observedDescription = null;
  }

  // 2) Firestore: membership uniquement.
  const previousMembership = pickString(subscription?.plan?.membership) || null;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const db = getFirestore();
  const batch = db.batch();
  batch.set(
    subscriptionRef,
    {
      plan: { membership },
      updatedAt: now,
      history: { lastModified: now, modifiedBy: callerUid || 'system', previousMembership }
    },
    { merge: true }
  );
  await batch.commit();
  dualWriteSubscription(clientId, { ...subscription, plan: { ...subscription?.plan, membership } }).catch(() => {});

  await writeAdminAuditLog({
    action: 'CLIENT_SUBSCRIPTION_ADMIN_PATCH_MEMBERSHIP_AND_SET_PAYME_DESCRIPTION',
    callerUid,
    clientId,
    payload: {
      membership,
      previousMembership,
      target,
      used,
      observedDescription
    },
    req
  });

  res.status(200).json({ success: true, target, used, observedDescription });
}

async function updateSubscriptionStateDoc(params: {
  clientId: string;
  patch: Record<string, any>;
}): Promise<void> {
  const db = getFirestore();
  await db.collection('Clients').doc(params.clientId).collection('subscription').doc('current').set(stripUndefinedDeep(params.patch), { merge: true });
  dualWriteSubscription(params.clientId, params.patch).catch(() => {});
}

export async function pauseClientSubscription(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientId = await pickClientId(req);
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
  const clientId = await pickClientId(req);
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
  const clientId = await pickClientId(req);
  const callerUid = req.uid || null;

  const { client, subscription } = await loadClientAndSubscription({ clientId });
  const { subId } = extractPaymeIdentifiers({ client, subscription });
  if (!subId) throw new HttpError(400, 'Aucun abonnement PayMe actif (subId manquant).');

  await paymeCancelSubscription({ subId });

  // IMPORTANT: "cancel" PayMe = status=5 => l'accès reste actif jusqu'à la fin de période.
  // On ne doit pas basculer le client en Visitor immédiatement.
  const accessUntil =
    (subscription?.payment?.nextPaymentDate as any) ??
    (subscription?.dates?.endDate as any) ??
    null;

  await updateSubscriptionStateDoc({
    clientId,
    patch: {
      states: { willExpire: true, isActive: true },
      dates: { cancelledDate: new Date(), ...(accessUntil ? { endDate: accessUntil } : {}) },
      payme: { status: 5, ...(accessUntil ? { nextPaymentDate: accessUntil } : {}) },
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
  const clientId = await pickClientId(req);
  const callerUid = req.uid || null;

  const body = (req.body || {}) as SetSubscriptionCardBody;
  const paymentCredentialId = pickString(body.paymentCredentialId);
  if (!paymentCredentialId) throw new HttpError(400, 'paymentCredentialId requis.');

  const db = getFirestore();
  const clientRef = db.collection('Clients').doc(clientId);

  const creds = await readAllPaymentCredentials(clientId, async () => {
    const snap = await clientRef.collection('Payment credentials').get();
    return snap.docs.map(d => ({ id: d.id, data: d.data() as Record<string, any> }));
  });
  if (creds.length === 0) throw new HttpError(404, 'Aucune carte trouvée.');

  const targetExists = creds.some((c) => c.id === paymentCredentialId);
  if (!targetExists) throw new HttpError(404, 'Payment credential introuvable.');

  const credsSnap = await clientRef.collection('Payment credentials').get();
  const batch = db.batch();
  for (const doc of credsSnap.docs) {
    batch.set(doc.ref, { isSubscriptionCard: doc.id === paymentCredentialId }, { merge: true });
  }
  await batch.commit();
  for (const doc of credsSnap.docs) {
    dualWritePaymentCredential(clientId, doc.id, { ...(doc.data() || {}), isSubscriptionCard: doc.id === paymentCredentialId }).catch(() => {});
  }

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
  const clientId = await pickClientId(req);
  const callerUid = req.uid || null;

  const body = (req.body || {}) as CustomSaleBody;
  const paymentCredentialId = pickString(body.paymentCredentialId);
  if (!paymentCredentialId) throw new HttpError(400, 'paymentCredentialId requis.');
  const amountInCents = coercePositiveInt(body.amountInCents, 'amountInCents');
  const description = pickString(body.description);
  if (!description) throw new HttpError(400, 'description requise.');
  const installments = coerceOptionalPositiveInt(body.installments);

  const paymentResult = await readPaymentCredential(clientId, paymentCredentialId, async () => {
    const snap = await getFirestore().collection('Clients').doc(clientId).collection('Payment credentials').doc(paymentCredentialId).get();
    return { exists: snap.exists, data: snap.exists ? ((snap.data() || {}) as Record<string, any>) : null };
  });
  if (!paymentResult.exists || !paymentResult.data) throw new HttpError(404, 'Payment credential introuvable.');
  const buyerKey = pickString(paymentResult.data['Isracard Key']);
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

/**
 * POST /api/clients/:clientId/sales/hosted
 * Generates a PayMe hosted sale URL for a one-time custom payment (no subscription).
 * Body: { amountInCents, description }
 */
export async function createCustomSaleHosted(req: AuthenticatedRequest, res: Response): Promise<void> {
  const rawClientId = pickString((req.params as any)?.clientId);
  const clientId = await pickClientId(req);
  const callerUid = req.uid || null;

  const body = (req.body || {}) as Record<string, any>;
  const amountInCents = coercePositiveInt(body.amountInCents, 'amountInCents');
  const description = pickString(body.description);
  if (!description) throw new HttpError(400, 'description requise.');

  const clientData = await readClientInfo(clientId, async () => {
    const snap = await getFirestore().collection('Clients').doc(clientId).get();
    if (!snap.exists) return null as any;
    return (snap.data() || {}) as any;
  });
  if (!clientData) throw new HttpError(404, 'Client introuvable.');

  const email = pickString(clientData.Email);
  const buyerName = [pickString(clientData['First Name']), pickString(clientData['Last Name'])].filter(Boolean).join(' ');

  const crmReturnBase = (process.env.CRM_PAYMENT_RETURN_URL || '').trim();
  const webhookUrl = (process.env.PAYME_WEBHOOK_URL || '').trim();

  const hostedSale = await paymeGenerateHostedSale({
    priceInCents: amountInCents,
    description,
    buyerEmail: email || undefined,
    buyerName: buyerName || undefined,
    callbackUrl: webhookUrl,
    returnUrl: `${crmReturnBase}?clientId=${encodeURIComponent(rawClientId)}&type=custom_sale`,
  });

  await writeAdminAuditLog({
    action: 'CLIENT_CUSTOM_SALE_HOSTED',
    callerUid,
    clientId,
    payload: { amountInCents, description },
    req,
    extra: { payme_sale_id: hostedSale.payme_sale_id },
  });

  res.status(200).json({ success: true, sale_url: hostedSale.sale_url });
}

/**
 * POST /api/clients/:clientId/subscription/create-payment-session
 * Generates a PayMe hosted sale URL for subscription creation.
 * The conseiller is redirected to PayMe to enter card details.
 */
export async function createPaymentSession(req: AuthenticatedRequest, res: Response): Promise<void> {
  const rawClientId = pickString((req.params as any)?.clientId);
  const clientId = await pickClientId(req);

  const callerUid = req.uid || null;
  const body = (req.body || {}) as Record<string, any>;

  const membership = pickString(body.membership);
  if (!membership) throw new HttpError(400, 'membership requis.');

  const plan = pickString(body.plan);
  if (plan !== 'monthly' && plan !== 'annual') throw new HttpError(400, 'plan invalide (monthly|annual).');

  let priceInCents = coercePositiveInt(body.priceInCents, 'priceInCents');
  const installments = coerceOptionalPositiveInt(body.installments);
  const promoCode = pickString(body.promoCode) || null;

  let promoResult: PromoValidationOk | null = null;
  if (promoCode) {
    const basePricing = await computeMembershipPricing({ membershipType: membership, plan });
    const basePriceBeforePromo = basePricing.ok ? basePricing.serverPriceInCents : priceInCents;

    const promoValidation = await validateAndApplyPromo({
      promoCode,
      membershipTypeNormalized: membership,
      planNormalized: plan as 'monthly' | 'annual',
      basePriceInCents: basePriceBeforePromo
    });

    if (!promoValidation.ok) {
      throw new HttpError(400, `Code promo invalide: ${promoValidation.code}`, promoValidation.code);
    }
    promoResult = promoValidation;
    priceInCents = promoValidation.finalPriceInCents;
  }

  const clientData = await readClientInfo(clientId, async () => {
    const snap = await getFirestore().collection('Clients').doc(clientId).get();
    if (!snap.exists) return null as any;
    return (snap.data() || {}) as any;
  });
  if (!clientData) throw new HttpError(404, 'Client introuvable.');

  const email = pickString(clientData.Email);
  const buyerName = [pickString(clientData['First Name']), pickString(clientData['Last Name'])].filter(Boolean).join(' ') || undefined;

  const webhookUrl = (process.env.PAYME_WEBHOOK_URL || '').trim();
  if (!webhookUrl) throw new HttpError(500, 'Configuration manquante: PAYME_WEBHOOK_URL.');

  const crmReturnBase = (process.env.CRM_PAYMENT_RETURN_URL || '').trim();
  if (!crmReturnBase) throw new HttpError(500, 'Configuration manquante: CRM_PAYMENT_RETURN_URL.');

  const returnUrl = `${crmReturnBase}?clientId=${encodeURIComponent(rawClientId)}`;

  const description = `${membership} - ${plan === 'annual' ? 'Annuel' : 'Mensuel'}`;

  const hostedSale = await paymeGenerateHostedSale({
    priceInCents,
    description,
    buyerEmail: email || undefined,
    buyerName,
    callbackUrl: webhookUrl,
    returnUrl,
  });

  const { error: insertError } = await supabase.from('pending_payment_sessions').insert({
    client_firebase_uid: clientId,
    payme_sale_id: hostedSale.payme_sale_id,
    status: 'pending',
    membership,
    plan_type: plan,
    price_cents: priceInCents,
    installments: installments ?? 1,
    promo_code: promoCode,
    created_by_uid: callerUid,
    metadata: {
      buyer_email: email || null,
      buyer_name: buyerName || null,
      promo_result: promoResult ? {
        promoCodeNormalized: promoResult.promoCodeNormalized,
        discountType: promoResult.discountType,
        discountValue: promoResult.discountValue,
        finalPriceInCents: promoResult.finalPriceInCents,
        discountInCents: promoResult.discountInCents,
        durationCycles: promoResult.durationCycles ?? null,
      } : null,
    },
  });

  if (insertError) {
    console.error('[createPaymentSession] Failed to insert pending session', insertError);
  }

  await writeAdminAuditLog({
    action: 'CREATE_PAYMENT_SESSION',
    callerUid,
    clientId,
    payload: { membership, plan, priceInCents, promoCode, payme_sale_id: hostedSale.payme_sale_id },
    req,
  });

  res.status(200).json({
    success: true,
    sale_url: hostedSale.sale_url,
    payme_sale_id: hostedSale.payme_sale_id,
  });
}

/**
 * PATCH /api/clients/:clientId/free-access
 * Toggle free access for a client.  Dual-writes to Firestore + Supabase.
 * Body: { isEnabled: boolean, membership?: string, expiresAt?: string (ISO), reason?: string, notes?: string }
 */
export async function toggleClientFreeAccess(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientId = await pickClientId(req);
  const callerUid = req.uid || null;
  const body = (req.body || {}) as Record<string, any>;

  const isEnabled = body.isEnabled === true;
  const membership = pickString(body.membership) || 'Pack Elite';
  const reason = pickString(body.reason) || '';
  const notes = pickString(body.notes) || '';

  const expiresAtRaw = pickString(body.expiresAt);
  let expiresAtDate: Date | null = null;
  if (expiresAtRaw) {
    expiresAtDate = new Date(expiresAtRaw);
    if (isNaN(expiresAtDate.getTime())) expiresAtDate = null;
  }
  if (isEnabled && !expiresAtDate) {
    expiresAtDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  }

  const now = new Date();

  // Resolver le nom affichable du conseiller
  let callerDisplayName = 'admin';
  if (callerUid) {
    const { data: conseillerData } = await supabase
      .from('conseillers')
      .select('name')
      .or(`id.eq.${callerUid},firestore_id.eq.${callerUid},firebase_uid.eq.${callerUid}`)
      .maybeSingle();
    callerDisplayName = conseillerData?.name || pickString((req.user as any)?.email) || pickString((req.user as any)?.name) || callerUid;
  }

  // Dual-write: Firestore (mobile app source of truth) + Supabase (CRM source of truth)
  const firestoreFreeAccess: Record<string, any> = {
    isEnabled,
    membership,
    reason,
    notes,
    isFirstVisit: false,
  };
  if (isEnabled) {
    firestoreFreeAccess.grantedAt = admin.firestore.Timestamp.fromDate(now);
    firestoreFreeAccess.grantedBy = callerDisplayName;
    if (expiresAtDate) {
      firestoreFreeAccess.expiresAt = admin.firestore.Timestamp.fromDate(expiresAtDate);
    }
  }

  const supabaseFreeAccess: Record<string, any> = {
    isEnabled,
    membership,
    reason,
    notes,
    isFirstVisit: false,
  };
  if (isEnabled) {
    supabaseFreeAccess.grantedAt = now.toISOString();
    supabaseFreeAccess.grantedBy = callerDisplayName;
    if (expiresAtDate) supabaseFreeAccess.expiresAt = expiresAtDate.toISOString();
  }

  const db = getFirestore();
  const clientRef = db.collection('Clients').doc(clientId);

  const [, supabaseResult] = await Promise.all([
    clientRef.set({ freeAccess: firestoreFreeAccess }, { merge: true }),
    supabase
      .from('clients')
      .update({ free_access: supabaseFreeAccess, updated_at: now.toISOString() })
      .eq('firebase_uid', clientId),
  ]);

  if (supabaseResult.error) throw new HttpError(500, `Erreur Supabase: ${supabaseResult.error.message}`);

  await writeAdminAuditLog({
    action: isEnabled ? 'FREE_ACCESS_GRANTED' : 'FREE_ACCESS_REVOKED',
    callerUid,
    clientId,
    payload: supabaseFreeAccess,
    req,
  });

  res.status(200).json({ success: true, freeAccess: supabaseFreeAccess });
}

/**
 * POST /api/clients/:clientId/subscription/sync-payme
 * Synchronise l'abonnement du client à partir de PayMe via subCode.
 * Body: { subCode: string }
 * - Interroge PayMe pour obtenir le statut, prix, dates, subId
 * - Met à jour Firestore (subscription/current) et Supabase (subscriptions) en dual-write
 */
export async function syncPaymeSubscription(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientId = await pickClientId(req);
  const rawClientId = pickString((req.params as any)?.clientId);
  const callerUid = req.uid || null;
  const body = (req.body || {}) as Record<string, any>;
  const subCode = pickString(body.subCode);
  if (!subCode) throw new HttpError(400, 'subCode est requis.');

  const details = await paymeGetSubscriptionDetails({ subCode });
  if (!details) throw new HttpError(404, 'Aucun abonnement trouvé sur PayMe avec ce subCode.');

  const rawData = details.raw;
  const items = Array.isArray(rawData?.items) ? rawData.items : [];
  const item = items.find((it: any) => {
    const code = it?.sub_payme_code ?? it?.subCode ?? it?.sub_code;
    return code != null && String(code).trim() === String(subCode).trim();
  }) || items[0] || {};

  const subStatus = details.subStatus;
  const isActive = subStatus === 2;
  const isPaused = subStatus === 3;
  const isCancelled = subStatus === 5;

  const subIdRaw = item?.sub_payme_id ?? item?.subscription_id ?? item?.subID ?? item?.subId ?? null;
  const subId = typeof subIdRaw === 'string' && subIdRaw.trim() ? subIdRaw.trim() : null;

  const priceRaw = item?.sub_price ?? item?.subPrice ?? item?.transaction_periodical_payment ?? item?.sale_price ?? item?.price ?? null;
  let priceCents: number | null = null;
  if (priceRaw != null) {
    const s = String(priceRaw).trim().replace(',', '.');
    if (s.includes('.')) {
      priceCents = Math.round(Number(s) * 100);
    } else {
      priceCents = Math.round(Number(s));
    }
    if (!Number.isFinite(priceCents) || priceCents <= 0) priceCents = null;
  }

  const nextPaymentDate = details.nextPaymentDate || null;

  const startDateRaw = item?.sub_created ?? item?.created_at ?? item?.sale_created ?? null;
  let startDate: Date | null = null;
  if (startDateRaw) {
    const d = new Date(startDateRaw);
    if (Number.isFinite(d.getTime())) startDate = d;
  }

  const descriptionRaw = item?.sale_name ?? item?.product_name ?? item?.description ?? null;
  const description = typeof descriptionRaw === 'string' ? descriptionRaw.trim() : null;

  const membershipFromDesc = description ? guessMembershipFromDescription(description) : null;
  let membershipFromPrice: string | null = null;
  if (priceCents) {
    const shekel = Math.round(priceCents / 100);
    if (shekel >= 95 && shekel <= 149) membershipFromPrice = 'Pack Start';
    else if (shekel >= 150 && shekel <= 249) membershipFromPrice = 'Pack Essential';
    else if (shekel >= 250 && shekel < 600) membershipFromPrice = 'Pack VIP';
    else if (shekel >= 600) membershipFromPrice = 'Pack Elite';
  }
  const membership = membershipFromDesc || membershipFromPrice || 'Pack Essential';

  const now = new Date();

  const firestorePatch: Record<string, any> = {
    payme: {
      subCode: subCode,
      sub_payme_code: subCode,
      status: subStatus,
      ...(subId ? { subID: subId, sub_payme_id: subId } : {}),
      ...(nextPaymentDate ? { nextPaymentDate: admin.firestore.Timestamp.fromDate(nextPaymentDate) } : {}),
    },
    plan: {
      type: 'monthly',
      membership,
      ...(priceCents ? { price: priceCents } : {}),
      ...(nextPaymentDate ? { nextPaymentDate: admin.firestore.Timestamp.fromDate(nextPaymentDate) } : {}),
    },
    payment: {
      method: 'credit-card',
      ...(nextPaymentDate ? { nextPaymentDate: admin.firestore.Timestamp.fromDate(nextPaymentDate) } : {}),
    },
    states: {
      isActive,
      isPaused,
      isCancelled,
    },
    dates: {
      ...(startDate ? { startDate: admin.firestore.Timestamp.fromDate(startDate) } : {}),
      ...(nextPaymentDate ? { endDate: admin.firestore.Timestamp.fromDate(nextPaymentDate) } : {}),
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const db = getFirestore();
  const subRef = db.collection('Clients').doc(clientId).collection('subscription').doc('current');
  await subRef.set(firestorePatch, { merge: true });

  const supabaseClientId = await resolveSupabaseClientId(clientId);

  const supabasePatch: Record<string, any> = {
    client_id: supabaseClientId || rawClientId,
    membership_type: membership,
    plan_type: 'monthly',
    payme_sub_code: subCode,
    payme_sub_id: subId,
    payme_status: String(subStatus ?? ''),
    is_active: isActive,
    is_paused: isPaused,
    payment_method: 'credit-card',
    ...(priceCents ? { price_cents: priceCents } : {}),
    ...(startDate ? { start_at: startDate.toISOString() } : {}),
    ...(nextPaymentDate ? { next_payment_at: nextPaymentDate.toISOString() } : {}),
    updated_at: now.toISOString(),
  };

  const { data: existingSub } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('client_id', supabaseClientId || rawClientId)
    .limit(1)
    .maybeSingle();

  if (existingSub) {
    await supabase.from('subscriptions').update(supabasePatch).eq('id', existingSub.id);
  } else {
    await supabase.from('subscriptions').insert(supabasePatch);
  }

  await dualWriteClient(clientId, {
    Membership: membership,
    membershipStatus: isActive ? 'active' : isCancelled ? 'cancelled' : 'inactive',
    isUnpaid: false,
  }).catch((e: any) => console.error('[sync-payme] dualWriteClient failed:', e?.message || e));

  await writeAdminAuditLog({
    action: 'SYNC_PAYME_SUBSCRIPTION',
    callerUid,
    clientId,
    payload: { subCode, subId, subStatus, membership, priceCents, isActive },
    req,
  });

  res.status(200).json({
    success: true,
    synced: {
      subCode,
      subId,
      subStatus,
      isActive,
      isPaused,
      isCancelled,
      membership,
      priceCents,
      priceNis: priceCents ? priceCents / 100 : null,
      startDate: startDate?.toISOString() || null,
      nextPaymentDate: nextPaymentDate?.toISOString() || null,
    },
  });
}

function guessMembershipFromDescription(desc: string): string | null {
  const lower = desc.toLowerCase();
  if (lower.includes('elite')) return 'Pack Elite';
  if (lower.includes('vip')) return 'Pack VIP';
  if (lower.includes('essential')) return 'Pack Essential';
  if (lower.includes('start')) return 'Pack Start';
  return null;
}
