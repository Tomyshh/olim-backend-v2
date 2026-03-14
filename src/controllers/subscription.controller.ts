import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { admin, getFirestore } from '../config/firebase.js';
import { paymeCaptureBuyerToken } from '../services/payme.service.js';
import { isRevolutBin6 } from '../services/revolutCardBins.service.js';
import {
  calculateSubscriptionStartDate,
  paymeCancelSubscription,
  paymeGenerateSale,
  paymeGenerateSubscription,
  paymeGetSubscriptionDetails,
  paymeListSubscriptions,
  paymeSetSubscriptionPrice
} from '../services/payme.service.js';
import { computeMembershipPricing } from '../services/membershipPricing.service.js';
import { validateAndApplyPromo } from '../services/promoCode.service.js';
import {
  createSecurdenCreditCardAccountInFolder,
  deleteSecurdenAccounts,
  normalizeCardNumberDigitsOnly,
  tryCreateSecurdenFolderAndCard
} from '../services/securden.service.js';
import { dualWriteSubscription, dualWritePaymentCredential, dualWriteDelete, dualWriteToSupabase, dualWritePromoRevert, dualWritePromotion, mapRefundRequestToSupabase, resolveSupabaseClientId } from '../services/dualWrite.service.js';
import { supabase } from '../services/supabase.service.js';
import { readClientInfo, readSubscription, readPaymentCredential, readAllPaymentCredentials } from '../services/supabaseFirstRead.service.js';

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

function parseDdMmYyyy(value: string): Date | null {
  const m = String(value || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yyyy)) return null;
  return new Date(yyyy, mm - 1, dd, 12, 0, 0, 0);
}

function buildSubscriptionCurrentDoc(params: {
  planNumber: 3 | 4;
  membership: string;
  priceInCents: number; // prix facturé (après promo)
  basePriceInCents: number; // prix de base (avant promo)
  payme: { buyerKey: string; subCode?: number | string | null; subID?: string | null } | null;
  nextPaymentDate?: Date | null;
  createdByUid?: string | null;
}): Record<string, any> {
  const now = new Date();
  const isAnnual = params.planNumber === 4;
  const planType = isAnnual ? 'annual' : 'monthly';

  const endDate = new Date(now);
  if (isAnnual) endDate.setFullYear(endDate.getFullYear() + 1);
  else endDate.setMonth(endDate.getMonth() + 1);

  const nextPaymentDate = params.nextPaymentDate || new Date(endDate);

  return {
    // Canonique (mobile): le read-model d'impayé est ici (pas dans Clients/{uid})
    isUnpaid: false,
    plan: {
      type: planType,
      membership: params.membership,
      price: params.priceInCents,
      currency: 'ILS',
      basePriceInCents: params.basePriceInCents
    },
    payment: {
      method: 'credit-card',
      installments: 1,
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
      lastModified: now,
      modifiedBy: params.createdByUid || 'system'
    },
    createdAt: now,
    updatedAt: now
  };
}

function parsePlanToPlanNumber(planRaw: unknown): 3 | 4 | null {
  // On accepte plusieurs formats pour éviter les frictions côté app.
  // - "monthly" / "annual"
  // - 3 / 4 (legacy interne)
  // - 1 / 12 (mois) => 1 => monthly, 12 => annual
  const s = typeof planRaw === 'string' ? planRaw.trim().toLowerCase() : '';
  const n = typeof planRaw === 'number' ? planRaw : typeof planRaw === 'string' ? Number(planRaw.trim()) : NaN;

  if (s === 'monthly' || s === 'mensuel' || s === 'month' || s === 'mois') return 3;
  if (s === 'annual' || s === 'annuel' || s === 'yearly' || s === 'an' || s === 'année') return 4;
  if (Number.isFinite(n)) {
    if (n === 3 || n === 1) return 3;
    if (n === 4 || n === 12) return 4;
  }
  return null;
}

function formatDdMmYyyy(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  // Ajuster si on dépasse (ex: 31 -> mois court)
  if (d.getDate() < day) d.setDate(0);
  return d;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const ts = (admin.firestore as any).Timestamp;
  if (ts && value instanceof ts) return value.toDate();
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function coerceIntOrNull(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value.trim()) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function formatYyyyMmDd(d: Date): string {
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export async function getSubscriptionStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();
    const clientRef = db.collection('Clients').doc(uid);
    const currentSubscriptionRef = clientRef.collection('subscription').doc('current');

    // Supabase-first: read subscription, fallback to Firestore
    const subResult = await readSubscription(uid, async () => {
      const doc = await currentSubscriptionRef.get();
      return { exists: doc.exists, data: doc.exists ? (doc.data() || {}) as Record<string, any> : null };
    });

    if (!subResult.exists || !subResult.data) {
      res.status(200).json({
        success: true,
        subscription: {
          uid,
          payme: { subCode: null, subId: null, status: null, sub_status: null, next_payment_date: null },
          entitlement: { isEntitled: false, state: 'none', accessUntil: null, hadSubscription: false },
          updatedAt: new Date().toISOString()
        }
      });
      return;
    }

    let subscription = subResult.data as Record<string, any>;

    if (subResult.exists) {
      const subData = subscription;

      // Hook "sans cron": réversion automatique promo multi-cycles (mensuel) si revertAt dépassé
      const promo = subData?.pricing?.promo as any;
      const revertAt = toDate(promo?.revertAt);
      const revertedAt = promo?.revertedAt;
      const isMonthly = pickString(subData?.plan?.type) === 'monthly';
      const subId = pickString(subData?.payme?.subID);
      const basePriceInCents =
        Number(subData?.pricing?.basePriceInCents ?? subData?.plan?.basePriceInCents ?? 0) || 0;

      if (isMonthly && subId && revertAt && !revertedAt && basePriceInCents > 0 && Date.now() > revertAt.getTime()) {
        try {
          await paymeSetSubscriptionPrice({ subId, priceInCents: Math.floor(basePriceInCents) });
          // IMPORTANT: promoCode = delete pour que le frontend masque la carte "Période promotionnelle"
          await currentSubscriptionRef.set(
            {
              plan: { price: Math.floor(basePriceInCents) },
              pricing: {
                discountInCents: 0,
                chargedPriceInCents: Math.floor(basePriceInCents),
                pricingSource: 'promo_reverted',
                promo: { ...(promo || {}), revertedAt: admin.firestore.FieldValue.serverTimestamp() }
              },
              promoCode: admin.firestore.FieldValue.delete(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            },
            { merge: true }
          );
          dualWriteSubscription(uid, { ...subData, plan: { ...subData.plan, price: Math.floor(basePriceInCents) }, pricing: { discountInCents: 0, chargedPriceInCents: Math.floor(basePriceInCents), pricingSource: 'promo_reverted' } }).catch(() => {});
          // Recharge local pour répondre avec l'état post-réversion
          const refreshed = await currentSubscriptionRef.get();
          if (refreshed.exists) {
            Object.assign(subData, refreshed.data() || {});
          }
        } catch (e: any) {
          // best effort: ne pas bloquer la route status si PayMe est indisponible
        }
      }
    }

    const now = new Date();

    // ---- Entitlement & PayMe "cancelled but still active" (status=5) ----
    const subObj = (subscription || {}) as Record<string, any>;
    const paymeObj = (subObj.payme || {}) as Record<string, any>;

    // Prefer stored values, otherwise fetch from PayMe (cached côté service)
    const storedSubStatus =
      coerceIntOrNull(paymeObj.status) ?? coerceIntOrNull(paymeObj.sub_status) ?? coerceIntOrNull(paymeObj.subStatus);
    const storedNextPaymentDate = toDate(paymeObj.nextPaymentDate);
    const storedEndDate = toDate(subObj?.dates?.endDate);
    const storedPaymentNext = toDate(subObj?.payment?.nextPaymentDate);

    const membership = pickString(subObj?.plan?.membership) || pickString(subObj?.membership) || '';
    const isVisitor = membership.trim().toLowerCase() === 'visitor';

    // Source-of-truth: subscription/current.payme.subCode uniquement
    const subCode = paymeObj.subCode ?? null;
    const details = !isVisitor && subCode != null ? await paymeGetSubscriptionDetails({ subCode }) : null;
    // IMPORTANT: pour réduire les divergences (Firestore vs PayMe), on préfère PayMe quand disponible.
    // Les conversions Visitor restent protégées par un durcissement (exigeant storedSubStatus===5).
    const paymeSubStatus = details?.subStatus ?? storedSubStatus ?? null;

    // accessUntil: date jusqu'à laquelle l'accès est garanti. Pour éviter de "faire expirer" à tort un abonnement actif
    // quand dates.endDate est en retard sur payment.nextPaymentDate (ex. endDate = fin période courante, nextPaymentDate = prochain prélèvement),
    // on prend la date la plus tardive parmi les candidats.
    const accessUntilCandidates = [
      storedEndDate,
      storedNextPaymentDate,
      storedPaymentNext,
      details?.nextPaymentDate ?? null
    ].filter((d): d is Date => d instanceof Date && Number.isFinite(d.getTime()));
    const accessUntil =
      accessUntilCandidates.length > 0
        ? new Date(Math.max(...accessUntilCandidates.map((d) => d.getTime())))
        : null;
    const nextPaymentDateYmd = details?.nextPaymentDateYmd || (accessUntil ? formatYyyyMmDd(accessUntil) : null);

    type EntitlementState = 'active' | 'cancelled_pending' | 'expired' | 'unpaid_grace' | 'unpaid' | 'none';
    let entitlementState: EntitlementState = 'expired';
    let isEntitled = false;

    // IMPORTANT: ne pas utiliser Clients/{uid}.isUnpaid (legacy).
    // Le mobile lit d'abord subscription/current.isUnpaid (canonique), puis fallback possible.
    const isUnpaidFromCurrent =
      subObj?.isUnpaid === true ||
      subObj?.states?.isUnpaid === true ||
      pickString(subObj?.status).toLowerCase() === 'unpaid' ||
      subObj?.payment?.status === 'unpaid';

    if (isUnpaidFromCurrent) {
      entitlementState = 'unpaid';
      isEntitled = false;
    } else if (accessUntil) {
      // CRITIQUE: accessUntil est la source de vérité principale
      // Si accessUntil existe, on l'utilise pour déterminer l'état, indépendamment de states.isActive
      const isBeforeAccessUntil = now.getTime() < accessUntil.getTime();
      if (paymeSubStatus === 5) {
        // Règle métier obligatoire pour status=5
        if (isBeforeAccessUntil) {
          entitlementState = 'cancelled_pending';
          isEntitled = true;
        } else {
          entitlementState = 'expired';
          isEntitled = false;
        }
      } else {
        // Autres statuts PayMe: actif si accessUntil dans le futur
        const statesIsActive = subObj?.states?.isActive !== false;
        const willExpire = subObj?.states?.willExpire === true;
        if (isBeforeAccessUntil) {
          entitlementState = willExpire ? 'cancelled_pending' : 'active';
          isEntitled = true;
        } else {
          entitlementState = 'expired';
          isEntitled = false;
        }
      }
    } else {
      // Fallback: pas d'accessUntil → on se base sur states.isActive
      const statesIsActive = subObj?.states?.isActive !== false;
      const willExpire = subObj?.states?.willExpire === true;
      if (statesIsActive) {
        entitlementState = willExpire ? 'cancelled_pending' : 'active';
        isEntitled = true;
      } else {
        entitlementState = 'expired';
        isEntitled = false;
      }
    }

    // ---- hadSubscription: le user a-t-il déjà eu un abonnement PayMe ? ----
    // Vérification rapide: si subCode existe, le user a eu un abonnement.
    // Sinon, on interroge PayMe par email pour savoir s'il a un historique.
    let hadSubscription = subCode != null;
    if (!hadSubscription) {
      try {
        const clientData = await readClientInfo(uid, async () => {
          const doc = await clientRef.get();
          return (doc.data() || {}) as Record<string, any>;
        });
        const clientEmail = pickString(clientData?.Email);
        if (clientEmail) {
          const allSubs = await paymeListSubscriptions();
          const emailLc = clientEmail.toLowerCase();
          hadSubscription = allSubs.some((it) => (it.email || '').toLowerCase() === emailLc);
        }
      } catch {
        // best effort
      }
    }

    // Si le user n'a jamais eu d'abonnement et n'est pas entitled → state = 'none'
    if (!hadSubscription && !isEntitled) {
      entitlementState = 'none';
    }

    // ---- Firestore maintenance (best effort) ----
    if (subResult.exists) {
      const patch: Record<string, any> = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      if (paymeSubStatus != null || accessUntil) {
        patch.payme = {
          ...(paymeSubStatus != null ? { status: paymeSubStatus } : {}),
          ...(accessUntil ? { nextPaymentDate: accessUntil } : {})
        };
      }
      if (accessUntil) {
        patch.dates = { endDate: accessUntil };
        // CRITIQUE: maintenir states.isActive cohérent avec accessUntil (source de vérité)
        const stillActive = now.getTime() < accessUntil.getTime();
        if (paymeSubStatus === 5) {
          patch.states = { isActive: stillActive, willExpire: stillActive };
        } else {
          // Pour les autres statuts, on met à jour isActive si accessUntil existe
          patch.states = { isActive: stillActive };
        }
      }

      await currentSubscriptionRef.set(patch, { merge: true }).catch(() => {});
      dualWriteSubscription(uid, { ...subObj, ...patch }).catch(() => {});
    }

    // ---- Conversion Visitor when truly expired (recommended) ----
    // IMPORTANT: ne pas modifier Clients/{uid} (legacy). Conversion Visitor = uniquement subscription/current.
    // Durcissement: éviter toute conversion abusive.
    // - on ne convertit que si le status=5 est déjà stocké dans Firestore (pas uniquement via PayMe/cache)
    // - et uniquement si l'entitlement est vraiment "expired" (pas impayé / pas encore dans la période d'accès)
    const shouldConvertToVisitor =
      storedSubStatus === 5 &&
      entitlementState === 'expired' &&
      isEntitled === false &&
      isUnpaidFromCurrent === false &&
      Boolean(accessUntil && now.getTime() >= accessUntil.getTime()) &&
      !isVisitor;

    if (shouldConvertToVisitor) {
      await currentSubscriptionRef
        .set(
          {
            plan: { membership: 'Visitor' },
            states: { isActive: false, willExpire: false },
            dates: { endDate: accessUntil },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        )
        .catch(() => {});
      dualWriteSubscription(uid, { ...subObj, plan: { ...subObj.plan, membership: 'Visitor' }, states: { isActive: false, willExpire: false }, dates: { ...subObj.dates, endDate: accessUntil } }).catch(() => {});
    }

    const entitlement = {
      isEntitled,
      state: entitlementState,
      accessUntil: accessUntil ? accessUntil.toISOString() : null,
      hadSubscription
    };

    const subIdAlias =
      typeof (paymeObj as any)?.subId === 'string' && String((paymeObj as any).subId).trim()
        ? String((paymeObj as any).subId).trim()
        : typeof (paymeObj as any)?.subID === 'string' && String((paymeObj as any).subID).trim()
          ? String((paymeObj as any).subID).trim()
          : null;

    res.json({
      success: true,
      subscription: {
        ...subObj,
        payme: {
          ...(paymeObj || {}),
          ...(subIdAlias && !(paymeObj as any)?.subId ? { subId: subIdAlias } : {}),
          ...(paymeSubStatus != null ? { status: paymeSubStatus, sub_status: paymeSubStatus } : {}),
          ...(nextPaymentDateYmd ? { next_payment_date: nextPaymentDateYmd } : {})
        },
        entitlement,
        updatedAt: now.toISOString()
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function quoteSubscriptionChange(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();
    const body = (req.body || {}) as {
      membershipType?: unknown;
      membership?: unknown;
      plan?: unknown;
      cardId?: unknown;
      promoCode?: unknown;
      promoCodeSource?: unknown;
      expectedPriceInCents?: unknown;
    };

    const membershipRaw = pickString(body.membershipType) || pickString(body.membership);
    if (!membershipRaw) {
      res.status(400).json({ error: 'membershipType requis.', code: 'MEMBERSHIP_REQUIRED' });
      return;
    }

    const cardId = pickString(body.cardId) || null;

    const clientRef = db.collection('Clients').doc(uid);

    const clientData = await readClientInfo(uid, async () => {
      const snap = await clientRef.get();
      if (!snap.exists) return null as any;
      return (snap.data() || {}) as Record<string, any>;
    });
    if (!clientData) {
      res.status(404).json({ error: 'Client introuvable.' });
      return;
    }

    const subResult = await readSubscription(uid, async () => {
      const doc = await clientRef.collection('subscription').doc('current').get();
      return { exists: doc.exists, data: doc.exists ? (doc.data() || {}) as Record<string, any> : null };
    });
    const current = (subResult.data || {}) as Record<string, any>;
    const currentPlanType = pickString(current?.plan?.type) || '';
    const currentMembership = pickString(current?.plan?.membership) || '';
    const currentPrice = Number(current?.plan?.price || 0);
    const currentIsMonthly = currentPlanType === 'monthly';

    const pricing = await computeMembershipPricing({
      membershipType: membershipRaw,
      plan: body.plan,
      clientPriceInCents: undefined
    });
    if (!pricing.ok) {
      if (pricing.code === 'MEMBERSHIP_INVALID') {
        res.status(400).json({ error: 'membershipType invalide.', code: 'MEMBERSHIP_INVALID' });
        return;
      }
      if (pricing.code === 'PLAN_INVALID') {
        res.status(400).json({ error: 'plan invalide (monthly|annual).', code: 'PLAN_INVALID' });
        return;
      }
      res.status(400).json({ error: 'Requête invalide.', code: pricing.code });
      return;
    }

    const targetMembership = pricing.membershipTypeNormalized;
    const targetPlan = pricing.planNormalized;

    // Refuser quote si même plan/membership (requested behavior)
    if (currentMembership && currentPlanType && currentMembership === targetMembership && currentPlanType === targetPlan) {
      res.status(409).json({ error: 'Même pack/plan.', code: 'SAME_PLAN' });
      return;
    }

    const basePriceInCents = pricing.serverPriceInCents;
    const promoCodeRaw = pickString(body.promoCode);
    const promoCodeSource = pickString(body.promoCodeSource) || null;
    const promoResult = promoCodeRaw
      ? await validateAndApplyPromo({
          promoCode: promoCodeRaw,
          membershipTypeNormalized: targetMembership,
          planNormalized: targetPlan,
          basePriceInCents
        })
      : null;
    if (promoResult && !promoResult.ok) {
      res.status(400).json({ error: 'Code promo invalide.', code: promoResult.code });
      return;
    }

    const finalPriceInCents = promoResult?.ok ? promoResult.finalPriceInCents : basePriceInCents;
    const discountInCents = promoResult?.ok ? promoResult.discountInCents : 0;

    // Estimer ratio restant jusqu'au prochain paiement (mensuel)
    const nextPaymentDate = toDate(current?.payment?.nextPaymentDate);
    const lastPaymentDate = toDate(current?.payment?.lastPaymentDate);
    const now = new Date();
    const DEFAULT_PERIOD_MS = 30 * 24 * 3600 * 1000;
    const MAX_MONTHLY_PERIOD_MS = 35 * 24 * 3600 * 1000;
    const rawPeriodMs =
      nextPaymentDate && lastPaymentDate && nextPaymentDate.getTime() > lastPaymentDate.getTime()
        ? nextPaymentDate.getTime() - lastPaymentDate.getTime()
        : DEFAULT_PERIOD_MS;
    // Garde-fou: si lastPaymentDate est obsolète (non mis à jour par le sync),
    // periodMs peut couvrir plusieurs mois au lieu d'un seul cycle.
    // On plafonne à ~35 jours pour un abonnement mensuel.
    const periodMs = rawPeriodMs > MAX_MONTHLY_PERIOD_MS ? DEFAULT_PERIOD_MS : rawPeriodMs;
    const remainingMs = nextPaymentDate ? nextPaymentDate.getTime() - now.getTime() : 0;
    const ratioRemaining = nextPaymentDate ? clamp01(remainingMs / periodMs) : 0;

    const oldMonthlyPriceInCents = currentIsMonthly && Number.isFinite(currentPrice) && currentPrice > 0 ? Math.floor(currentPrice) : 0;
    const proratedChargeInCents =
      currentIsMonthly && targetPlan === 'monthly'
        ? Math.max(0, Math.round((finalPriceInCents - oldMonthlyPriceInCents) * ratioRemaining))
        : 0;

    const oneShotChargeInCents = targetPlan === 'annual' ? finalPriceInCents : 0;

    const quoteRef = clientRef.collection('subscriptionChangeQuotes').doc();
    const ttlMinutes = Number(process.env.SUBSCRIPTION_CHANGE_QUOTE_TTL_MINUTES || 10);
    const expiresAt = new Date(Date.now() + (Number.isFinite(ttlMinutes) ? ttlMinutes : 10) * 60 * 1000);

    await quoteRef.set(
      {
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt,
        operation: 'change',
        target: { membership: targetMembership, plan: targetPlan, cardId },
        current: {
          membership: currentMembership || null,
          plan: currentPlanType || null,
          oldMonthlyPriceInCents: oldMonthlyPriceInCents || null
        },
        pricing: {
          basePriceInCents,
          finalPriceInCents,
          discountInCents,
          remoteConfigKeyUsed: pricing.remoteConfigKeyUsed,
          remoteConfigValueNisUsed: pricing.remoteConfigValueNisUsed
        },
        proration: {
          ratioRemaining,
          nextPaymentDate: nextPaymentDate || null,
          lastPaymentDate: lastPaymentDate || null,
          proratedChargeInCents,
          rule: 'difference_prorated_non_negative'
        },
        oneShotChargeInCents,
        promo: promoResult?.ok
          ? {
              promoCode: promoResult.promoCodeNormalized,
              promotionId: promoResult.promotionId,
              discountType: promoResult.discountType,
              discountValue: promoResult.discountValue,
              expiresAt: promoResult.expiresAt,
              source: promoCodeSource,
              durationCycles: promoResult.durationCycles
            }
          : null
      },
      { merge: true }
    );

    res.status(200).json({
      success: true,
      quoteId: quoteRef.id,
      expiresAt,
      current: {
        membershipType: currentMembership || null,
        plan: currentPlanType || null,
        oldMonthlyPriceInCents: oldMonthlyPriceInCents || null
      },
      target: { membershipTypeNormalized: targetMembership, planNormalized: targetPlan, cardId },
      pricing: {
        basePriceInCents,
        discountInCents,
        chargedPriceInCents: finalPriceInCents,
        remoteConfigKeyUsed: pricing.remoteConfigKeyUsed,
        remoteConfigValueNisUsed: pricing.remoteConfigValueNisUsed
      },
      proration: {
        ratioRemaining,
        proratedChargeInCents,
        nextPaymentDate: nextPaymentDate || null
      },
      oneShotChargeInCents,
      promo: promoResult?.ok
        ? {
            promoCode: promoResult.promoCodeNormalized,
            promotionId: promoResult.promotionId,
            discountType: promoResult.discountType,
            discountValue: promoResult.discountValue,
            expiresAt: promoResult.expiresAt,
            source: promoCodeSource,
            durationCycles: promoResult.durationCycles
          }
        : null
    });
  } catch (error: any) {
    res.status(error?.status || 500).json({ error: error.message || String(error), code: error?.code });
  }
}

export async function subscribe(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const db = getFirestore();

    const body = (req.body || {}) as {
      membershipType?: unknown;
      membership?: unknown;
      plan?: unknown; // "monthly"|"annual" (ou 1/12, ou 3/4 legacy)
      operation?: unknown; // "subscribe" | "change"
      quoteId?: unknown;
      currentMembershipType?: unknown; // logs only
      currentPlan?: unknown; // logs only
      cardId?: unknown;
      paymentCredentialId?: unknown;
      // Mode inscription (carte inline) - permet de ne rien écrire sur Firestore si PayMe échoue
      cardNumber?: unknown;
      expirationDate?: unknown; // "MM/YY" ou "MM/YYYY"
      cvv?: unknown;
      cardHolder?: unknown;
      cardName?: unknown;
      isDefault?: unknown;
      buyerZipCode?: unknown; // Revolut uniquement (best-effort)
      priceInCents?: unknown;
      expectedPriceInCents?: unknown;
      promoCode?: unknown;
      promoCodeSource?: unknown;
    };

    const operationRaw = pickString(body.operation).toLowerCase();
    const operation = operationRaw ? operationRaw : 'subscribe';
    if (operation !== 'subscribe' && operation !== 'change') {
      res.status(400).json({ error: 'operation invalide.', code: 'OPERATION_INVALID' });
      return;
    }

    const membershipRaw = pickString(body.membershipType) || pickString(body.membership);
    if (!membershipRaw) {
      res.status(400).json({ error: 'membershipType requis.', code: 'MEMBERSHIP_REQUIRED' });
      return;
    }

    const paymentCredentialId = pickString(body.cardId) || pickString(body.paymentCredentialId);
    const hasInlineCard =
      pickString(body.cardNumber) && pickString(body.expirationDate) && pickString(body.cvv);
    if (!paymentCredentialId && !hasInlineCard) {
      res.status(400).json({ error: 'cardId requis (ou carte inline).', code: 'CARD_REQUIRED' });
      return;
    }

    const pricing = await computeMembershipPricing({
      membershipType: membershipRaw,
      plan: body.plan,
      // IMPORTANT: on valide le prix client plus bas (après promo), sinon on compare base vs final
      clientPriceInCents: undefined
    });
    if (!pricing.ok) {
      if (pricing.code === 'MEMBERSHIP_INVALID') {
        res.status(400).json({ error: 'membershipType invalide.', code: 'MEMBERSHIP_INVALID' });
        return;
      }
      if (pricing.code === 'PLAN_INVALID') {
        res.status(400).json({ error: 'plan invalide (monthly|annual).', code: 'PLAN_INVALID' });
        return;
      }
      // Safety net (ne devrait pas arriver)
      res.status(400).json({ error: 'Requête invalide.', code: pricing.code });
      return;
    }

    const membership = pricing.membershipTypeNormalized;
    const planNumber = pricing.planNormalized === 'annual' ? 4 : 3;
    const basePriceInCents = pricing.serverPriceInCents;

    // Diagnostic: tracer la source de prix utilisée pour le calcul promo
    console.info('[subscribe] Pricing resolved', {
      membership,
      plan: pricing.planNormalized,
      basePriceInCents,
      pricingSource: pricing.pricingSource,
      remoteConfigKeyUsed: pricing.remoteConfigKeyUsed,
      remoteConfigValueNisUsed: pricing.remoteConfigValueNisUsed
    });

    // Promo (optionnel) => calcule le prix final serveur
    const promoCodeRaw = pickString(body.promoCode);
    const promoCodeSource = pickString(body.promoCodeSource) || null;
    const promoResult = promoCodeRaw
      ? await validateAndApplyPromo({
          promoCode: promoCodeRaw,
          membershipTypeNormalized: membership,
          planNormalized: pricing.planNormalized,
          basePriceInCents
        })
      : null;

    if (promoResult && !promoResult.ok) {
      res.status(400).json({ error: 'Code promo invalide.', code: promoResult.code });
      return;
    }

    const finalPriceInCents = promoResult?.ok ? promoResult.finalPriceInCents : basePriceInCents;
    const discountInCents = promoResult?.ok ? promoResult.discountInCents : 0;

    // Validation prix côté client (anti falsification)
    const clientExpectedRaw = pickString(body.expectedPriceInCents);
    const clientPriceRaw = pickString(body.priceInCents);
    const clientExpectedParsed = clientExpectedRaw ? Number(clientExpectedRaw) : NaN;
    const clientPriceParsed = clientPriceRaw ? Number(clientPriceRaw) : NaN;
    const clientFinalPriceInCents =
      Number.isFinite(clientExpectedParsed) && clientExpectedParsed > 0
        ? Math.floor(clientExpectedParsed)
        : Number.isFinite(clientPriceParsed) && clientPriceParsed > 0
          ? Math.floor(clientPriceParsed)
          : null;

    if (clientFinalPriceInCents != null && clientFinalPriceInCents !== finalPriceInCents) {
      res.status(409).json({
        error: 'Prix incohérent.',
        code: 'PRICE_MISMATCH',
        serverBasePriceInCents: basePriceInCents,
        serverDiscountInCents: discountInCents,
        serverFinalPriceInCents: finalPriceInCents,
        clientFinalPriceInCents,
        membershipTypeNormalized: membership,
        planNormalized: pricing.planNormalized,
        remoteConfigKeyUsed: pricing.remoteConfigKeyUsed,
        remoteConfigValueNisUsed: pricing.remoteConfigValueNisUsed,
        promoCodeNormalized: promoResult?.ok ? promoResult.promoCodeNormalized : null
      });
      return;
    }

    const clientRef = db.collection('Clients').doc(uid);

    const clientData = await readClientInfo(uid, async () => {
      const snap = await clientRef.get();
      if (!snap.exists) return null as any;
      return (snap.data() || {}) as Record<string, any>;
    });
    if (!clientData) {
      res.status(404).json({ error: 'Client introuvable.' });
      return;
    }

    const subResult = await readSubscription(uid, async () => {
      const doc = await clientRef.collection('subscription').doc('current').get();
      return { exists: doc.exists, data: doc.exists ? (doc.data() || {}) as Record<string, any> : null };
    });

    const existingSub = (subResult.data || {}) as Record<string, any>;
    const currentPlanType = pickString(existingSub?.plan?.type);
    const currentMembership = pickString(existingSub?.plan?.membership);
    const currentSubId = pickString(existingSub?.payme?.subID) || pickString(existingSub?.paymeSubID) || null;
    const currentSubCode =
      typeof existingSub?.payme?.subCode === 'number' || typeof existingSub?.payme?.subCode === 'string'
        ? existingSub.payme.subCode
        : null;
    const currentBuyerKey = pickString(existingSub?.payme?.buyerKey) || null;
    const currentNextPaymentDate = toDate(existingSub?.payment?.nextPaymentDate);
    const currentLastPaymentDate = toDate(existingSub?.payment?.lastPaymentDate);
    const currentPrice = Number(existingSub?.plan?.price || 0);
    const isCurrentlyActive = existingSub?.states?.isActive === true && existingSub?.states?.willExpire !== true;

    // subscribe: bloquer si déjà actif
    if (operation === 'subscribe' && isCurrentlyActive) {
      res.status(409).json({ error: 'Déjà abonné.', code: 'ALREADY_SUBSCRIBED' });
      return;
    }

    // change: refuser si même pack/plan
    if (operation === 'change' && currentMembership && currentPlanType) {
      if (currentMembership === membership && currentPlanType === pricing.planNormalized) {
        res.status(409).json({ error: 'Même pack/plan.', code: 'SAME_PLAN' });
        return;
      }
    }

    // change: quote obligatoire
    let changeQuote: Record<string, any> | null = null;
    if (operation === 'change') {
      const quoteId = pickString(body.quoteId);
      if (!quoteId) {
        res.status(400).json({ error: 'Quote requis pour le prorata.', code: 'PRORATION_QUOTE_REQUIRED' });
        return;
      }
      const quoteSnap = await clientRef.collection('subscriptionChangeQuotes').doc(quoteId).get();
      if (!quoteSnap.exists) {
        res.status(400).json({ error: 'Quote introuvable.', code: 'PRORATION_QUOTE_INVALID' });
        return;
      }
      const q = (quoteSnap.data() || {}) as Record<string, any>;
      const expiresAt = toDate(q.expiresAt);
      if (!expiresAt || expiresAt.getTime() < Date.now()) {
        res.status(400).json({ error: 'Quote expiré.', code: 'PRORATION_QUOTE_EXPIRED' });
        return;
      }
      const qTargetMembership = pickString(q?.target?.membership);
      const qTargetPlan = pickString(q?.target?.plan);
      const qTargetCardId = pickString(q?.target?.cardId);
      if (qTargetMembership !== membership || qTargetPlan !== pricing.planNormalized) {
        res.status(400).json({ error: 'Quote invalide (cible différente).', code: 'PRORATION_QUOTE_INVALID' });
        return;
      }
      if (paymentCredentialId && qTargetCardId && qTargetCardId !== paymentCredentialId) {
        res.status(400).json({ error: 'Quote invalide (carte différente).', code: 'PRORATION_QUOTE_INVALID' });
        return;
      }
      const qPromo = q.promo ? pickString(q.promo.promoCode) : '';
      const expectedPromo = promoResult?.ok ? promoResult.promoCodeNormalized : '';
      if ((qPromo || expectedPromo) && qPromo !== expectedPromo) {
        res.status(400).json({ error: 'Quote invalide (promo différente).', code: 'PRORATION_QUOTE_INVALID' });
        return;
      }
      changeQuote = q;
    }

    const email = pickString(clientData.Email);
    if (!email) {
      res.status(400).json({ error: 'Email requis pour PayMe.', code: 'EMAIL_REQUIRED' });
      return;
    }

    const firstName = pickString(clientData['First Name'] ?? clientData.firstName);
    const lastName = pickString(clientData['Last Name'] ?? clientData.lastName);
    const clientName = `${firstName} ${lastName}`.trim() || pickString(clientData.Email) || uid;

    // buyerKey: soit depuis une carte existante (cardId), soit via tokenisation inline (inscription)
    let buyerKey = '';
    let cardIdToMarkAsSubscription: string | null = paymentCredentialId || null;
    let createdCard: { id: string; paymentDoc: Record<string, any> } | null = null;

    if (paymentCredentialId) {
      const paymentResult = await readPaymentCredential(uid, paymentCredentialId, async () => {
        const snap = await clientRef.collection('Payment credentials').doc(paymentCredentialId).get();
        return { exists: snap.exists, data: snap.exists ? (snap.data() || {}) as Record<string, any> : null };
      });
      if (!paymentResult.exists || !paymentResult.data) {
        res.status(404).json({ error: 'Payment credential introuvable.', code: 'CARD_NOT_FOUND' });
        return;
      }
      buyerKey = pickString(paymentResult.data['Isracard Key']);
      if (!buyerKey) {
        res.status(400).json({ error: 'Carte invalide (buyerKey manquant).', code: 'CARD_INVALID' });
        return;
      }
    } else {
      // Mode inscription: on tokenise, puis on ne stocke la carte que si PayMe (sale/sub) passe.
      const expParsed = parseExpiryMmYy(body.expirationDate);
      const expirationDate = expParsed.normalized;
      const cvv = pickString(body.cvv);
      const norm = normalizeCardNumberDigitsOnly(body.cardNumber);
      if (!norm.ok) {
        res.status(400).json({ error: 'cardNumber invalide.', code: 'CARD_NUMBER_INVALID' });
        return;
      }
      if (!expirationDate) {
        res.status(400).json({ error: 'expirationDate requis.', code: 'EXPIRATION_DATE_REQUIRED' });
        return;
      }
      if (!cvv) {
        res.status(400).json({ error: 'cvv requis.', code: 'CVV_REQUIRED' });
        return;
      }

      const buyerZipCode = pickString(body.buyerZipCode);
      const bin6 = norm.digitsOnly.length >= 6 ? norm.digitsOnly.slice(0, 6) : '';
      const isRevolut = await isRevolutBin6(bin6);
      if (isRevolut && !buyerZipCode) {
        res.status(400).json({ error: 'Code postal requis pour une carte Revolut.', code: 'BUYER_ZIP_CODE_REQUIRED' });
        return;
      }

      const cardHolder = pickString(body.cardHolder) || clientName;
      const buyerToken = await paymeCaptureBuyerToken({
        email,
        buyerName: clientName,
        cardHolder,
        cardNumber: norm.digitsOnly,
        expirationDate,
        cvv,
        ...(isRevolut ? { buyerZipCode } : {})
      });
      buyerKey = buyerToken.buyerKey;

      // On prépare le doc Firestore (mais on ne l'écrit qu'après succès PayMe)
      const last4 = norm.digitsOnly.length >= 4 ? norm.digitsOnly.slice(-4) : '';
      const maskedCardNumber = last4 ? `${'*'.repeat(Math.max(0, norm.digitsOnly.length - 4))}${last4}` : null;
      const brand = detectCardBrand(norm.digitsOnly);
      const isDefault = body.isDefault !== false; // par défaut true en inscription
      const cardName = pickString(body.cardName) || cardHolder;

      // Securden: best-effort, mais seulement après succès PayMe (pour éviter une carte stockée si paiement échoue)
      let accountId: string | null = null;
      let folderId = pickString(clientData.securden_Folder);
      const securdenWarnings: string[] = [];

      createdCard = {
        id: clientRef.collection('Payment credentials').doc().id,
        paymentDoc: {
          'Card Name': cardName,
          'Card Number': maskedCardNumber,
          'Card Holder': cardHolder || null,
          'Isracard Key': buyerToken.buyerKey,
          'Card Suffix': last4 || null,
          isSubscriptionCard: true,
          'Securden ID': null,
          'Created At': admin.firestore.FieldValue.serverTimestamp(),
          'Created From': 'Mobile App (Subscribe)',
          last4: last4 || buyerToken.buyerCard.replace(/\D+/g, '').slice(-4) || '',
          brand,
          expiryMonth: expParsed.month,
          expiryYear: expParsed.year,
          isDefault,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: null,
          securden: { folderId: folderId || null, warnings: securdenWarnings }
        }
      };

      // On stocke les infos nécessaires pour Securden dans un closure via variables locales
      (createdCard as any)._securden = {
        folderId,
        firstName,
        lastName,
        clientName,
        cardNumberDigits: norm.digitsOnly,
        expirationDate,
        cvv
      };
      cardIdToMarkAsSubscription = createdCard.id;
      void accountId;
    }

    // PayMe: operation=subscribe (comportement historique) / operation=change (prorata + set-price ou recréation)
    let salePaymeId: string | null = null;
    let subCode: number | string | null = null;
    let subID: string | null = null;
    let nextPaymentDate: Date | null = null;

    if (operation === 'subscribe') {
      // annual => sale unique ; monthly => sale + subscription future
      if (planNumber === 4) {
        const sale = await paymeGenerateSale({ priceInCents: finalPriceInCents, description: membership, buyerKey });
        salePaymeId = sale.salePaymeId;
      } else {
        const sale = await paymeGenerateSale({
          priceInCents: finalPriceInCents,
          description: `${membership} - Premier mois`,
          buyerKey
        });
        salePaymeId = sale.salePaymeId;

        const startDateDdMmYyyy = calculateSubscriptionStartDate(3);
        nextPaymentDate = parseDdMmYyyy(startDateDdMmYyyy);
        const sub = await paymeGenerateSubscription({
          priceInCents: finalPriceInCents,
          description: membership,
          email,
          buyerKey,
          planIterationType: 3,
          startDateDdMmYyyy
        });
        subCode = sub.subCode;
        subID = sub.subID;
      }
    } else {
      // operation === "change"
      const targetPlan = pricing.planNormalized;
      const currentIsMonthly = currentPlanType === 'monthly';
      const oldMonthlyPriceInCents = currentIsMonthly && Number.isFinite(currentPrice) && currentPrice > 0 ? Math.floor(currentPrice) : 0;

      if (targetPlan === 'annual') {
        // One-shot annual. Si un mensuel existe, on le cancel pour éviter des prélèvements futurs.
        if (currentIsMonthly && currentSubId) {
          try {
            await paymeCancelSubscription({ subId: currentSubId });
          } catch (e: any) {
            // best effort
          }
        }
        const sale = await paymeGenerateSale({ priceInCents: finalPriceInCents, description: membership, buyerKey });
        salePaymeId = sale.salePaymeId;
        subCode = null;
        subID = null;
        nextPaymentDate = null;
      } else {
        // target monthly
        // Prorata: difference proratisée non négative (défini par la quote)
        const proratedChargeInCents = Number(changeQuote?.proration?.proratedChargeInCents || 0) || 0;
        if (proratedChargeInCents > 0) {
          const sale = await paymeGenerateSale({
            priceInCents: proratedChargeInCents,
            description: `Changement abonnement (prorata) - ${membership}`,
            buyerKey
          });
          salePaymeId = sale.salePaymeId;
        } else {
          salePaymeId = null;
        }

        // Cas standard: subscription mensuelle existante -> set-price, ou recréer si buyerKey a changé
        if (currentIsMonthly && currentSubId) {
          const buyerKeyChanged = Boolean(currentBuyerKey) && currentBuyerKey !== buyerKey;
          const desiredNext = currentNextPaymentDate;
          const startDateDdMmYyyy = desiredNext ? formatDdMmYyyy(desiredNext) : calculateSubscriptionStartDate(3);
          nextPaymentDate = desiredNext || parseDdMmYyyy(startDateDdMmYyyy);

          if (buyerKeyChanged) {
            // Recréer pour changer la carte (PayMe ne permet pas forcément de swap le buyerKey sur une sub existante)
            try {
              await paymeCancelSubscription({ subId: currentSubId });
            } catch (e: any) {
              // best effort
            }
            const sub = await paymeGenerateSubscription({
              priceInCents: finalPriceInCents,
              description: membership,
              email,
              buyerKey,
              planIterationType: 3,
              startDateDdMmYyyy
            });
            subCode = sub.subCode;
            subID = sub.subID;
          } else {
            await paymeSetSubscriptionPrice({ subId: currentSubId, priceInCents: finalPriceInCents });
            subID = currentSubId;
            subCode = currentSubCode;
          }
        } else {
          // Pas de subscription mensuelle existante => fallback safe: sale premier mois + création sub
          const sale = await paymeGenerateSale({
            priceInCents: finalPriceInCents,
            description: `${membership} - Premier mois`,
            buyerKey
          });
          salePaymeId = sale.salePaymeId;
          const startDateDdMmYyyy = calculateSubscriptionStartDate(3);
          nextPaymentDate = parseDdMmYyyy(startDateDdMmYyyy);
          const sub = await paymeGenerateSubscription({
            priceInCents: finalPriceInCents,
            description: membership,
            email,
            buyerKey,
            planIterationType: 3,
            startDateDdMmYyyy
          });
          subCode = sub.subCode;
          subID = sub.subID;
        }
      }
    }

    const batch = db.batch();
    const now = admin.firestore.FieldValue.serverTimestamp();

    // Si on a créé une carte "inline", on la persiste maintenant (APRÈS succès PayMe uniquement)
    if (createdCard) {
      // Securden STRICT (après PayMe) : on n'écrit rien dans Firestore si Securden échoue.
      const s = (createdCard as any)._securden as any;
      let accountId: string | undefined;
      let folderId = pickString(s?.folderId);
      const securdenWarnings: string[] = [];
      if (folderId) {
        const result = await createSecurdenCreditCardAccountInFolder({
          folderId,
          clientName: pickString(s?.clientName) || clientName,
          cardNumber: pickString(s?.cardNumberDigits),
          expirationDate: pickString(s?.expirationDate),
          cvv: pickString(s?.cvv),
          isRegistration: true
        });
        accountId = result.accountId;
        securdenWarnings.push(...(result.warnings || []));
      } else if (pickString(s?.firstName) && pickString(s?.lastName)) {
        const securden = await tryCreateSecurdenFolderAndCard({
          firstName: pickString(s?.firstName),
          lastName: pickString(s?.lastName),
          isPayingClient: true,
          cardNumber: pickString(s?.cardNumberDigits),
          expirationDate: pickString(s?.expirationDate),
          cvv: pickString(s?.cvv)
        });
        folderId = securden.folderId || '';
        accountId = securden.accountId;
        securdenWarnings.push(...(securden.warnings || []));
        if (folderId) {
          batch.set(clientRef, { securden_Folder: folderId }, { merge: true });
        }
      }

      if (!accountId) {
        res.status(502).json({ error: `Securden: échec création de la carte. ${securdenWarnings[0] || ''}`.trim() });
        return;
      }

      createdCard.paymentDoc['Securden ID'] = accountId;
      createdCard.paymentDoc.securden = { folderId: folderId || null, warnings: securdenWarnings };

      const payRef = clientRef.collection('Payment credentials').doc(createdCard.id);
      batch.set(payRef, createdCard.paymentDoc, { merge: true });
    }

    // Marquer la carte choisie comme "subscription card" (aligné CRM)
    const credsSnap = await clientRef.collection('Payment credentials').get();
    credsSnap.docs.forEach((d) => {
      batch.set(d.ref, { isSubscriptionCard: d.id === cardIdToMarkAsSubscription }, { merge: true });
    });

    batch.set(
      clientRef,
      {
        Membership: membership,
        subPlan: planNumber,
        isUnpaid: false,
        sale_payme_id: salePaymeId,
        ...(subID ? { paymeSubID: subID, 'IsraCard Sub ID': subID } : {}),
        ...(subCode != null ? { israCard_subCode: subCode } : {}),
        ...(promoResult?.ok ? { promoCodeUsed: promoResult.promoCodeNormalized } : {}),
        ...(promoCodeSource ? { promoCodeSource } : {}),
        updatedAt: now
      },
      { merge: true }
    );

    const subscriptionDoc = buildSubscriptionCurrentDoc({
      planNumber,
      membership,
      priceInCents: finalPriceInCents,
      basePriceInCents,
      payme: planNumber === 3 ? { buyerKey, subCode, subID } : null,
      nextPaymentDate,
      createdByUid: uid
    });
    // Calcul promo revert (utilisé aussi pour PromoReverts post-commit + réponse JSON)
    const promoDurationCycles = promoResult?.ok ? promoResult.durationCycles : null;
    const promoRevertAt =
      promoResult?.ok && promoDurationCycles
        ? pricing.planNormalized === 'monthly'
          ? addMonths(nextPaymentDate || new Date(), promoDurationCycles)
          : addMonths(new Date(), promoDurationCycles)
        : null;

    // Ajout du bloc pricing.promo si un code promo a été validé (format identique CRM)
    if (promoResult?.ok) {
      (subscriptionDoc as any).pricing = {
        basePriceInCents,
        discountInCents,
        chargedPriceInCents: finalPriceInCents,
        pricingSource: 'promo_applied',
        membershipTypeNormalized: pricing.membershipTypeNormalized,
        planNormalized: pricing.planNormalized,
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
    batch.set(clientRef.collection('subscription').doc('current'), subscriptionDoc, { merge: true });

    await batch.commit();

    // Dual-write: subscription/current
    dualWriteSubscription(uid, subscriptionDoc).catch(() => {});
    // Dual-write: inline card (if created)
    if (createdCard) {
      dualWritePaymentCredential(uid, createdCard.id, createdCard.paymentDoc).catch(() => {});
    }
    // Dual-write: isSubscriptionCard flags on all payment credentials
    credsSnap.docs.forEach((d) => {
      dualWritePaymentCredential(uid, d.id, { ...d.data(), isSubscriptionCard: d.id === cardIdToMarkAsSubscription }).catch(() => {});
    });

    // Désactivation des codes promo à usage unique (forEveryone === false => isValid = false)
    // Effectué après le commit pour ne pas bloquer la souscription en cas d'erreur
    if (promoResult?.ok && !promoResult.forEveryone && promoResult.promotionId) {
      try {
        await db.collection('Promotions').doc(promoResult.promotionId).set(
          { isValid: false, usedByUid: uid, usedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
        dualWritePromotion(promoResult.promotionId, { isValid: false, usedByUid: uid, usedAt: new Date() }).catch(() => {});
      } catch (e: any) {
        console.error('[subscribe] Échec désactivation code promo à usage unique:', {
          promotionId: promoResult.promotionId,
          promoCode: promoResult.promoCodeNormalized,
          uid,
          error: String(e?.message || e)
        });
      }
    }

    // Planifier la réversion automatique de la promo si promo_duration > 0
    if (promoResult?.ok && promoDurationCycles && promoDurationCycles > 0 && promoRevertAt) {
      try {
        const promoRevertRef = await db.collection('PromoReverts').add({
          uid,
          promoCode: promoResult.promoCodeNormalized,
          promotionId: promoResult.promotionId,
          revertAt: promoRevertAt,
          basePriceInCents,
          discountedPriceInCents: finalPriceInCents,
          planType: pricing.planNormalized,
          membershipType: membership,
          paymeSubId: subID || null,
          durationCycles: promoDurationCycles,
          status: 'pending',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        dualWritePromoRevert(promoRevertRef.id, {
          uid,
          promoCode: promoResult.promoCodeNormalized,
          promotionId: promoResult.promotionId,
          revertAt: promoRevertAt,
          basePriceInCents,
          discountedPriceInCents: finalPriceInCents,
          planType: pricing.planNormalized,
          membershipType: membership,
          paymeSubId: subID || null,
          durationCycles: promoDurationCycles,
          status: 'pending',
          createdAt: new Date()
        }).catch(() => {});
      } catch (e: any) {
        console.error('[subscribe] Échec écriture PromoReverts:', {
          uid,
          promoCode: promoResult.promoCodeNormalized,
          error: String(e?.message || e)
        });
      }
    }

    res.status(200).json({
      success: true,
      salePaymeId,
      subCode,
      subID,
      ...(createdCard ? { cardId: createdCard.id } : { cardId: cardIdToMarkAsSubscription }),
      chargedPriceInCents: finalPriceInCents,
      basePriceInCents,
      discountInCents,
      pricingSource: promoResult?.ok ? 'promo_applied' : pricing.pricingSource,
      remoteConfigKeyUsed: pricing.remoteConfigKeyUsed,
      remoteConfigValueNisUsed: pricing.remoteConfigValueNisUsed,
      membershipTypeNormalized: pricing.membershipTypeNormalized,
      planNormalized: pricing.planNormalized,
      promo: promoResult?.ok
        ? {
            promoCode: promoResult.promoCodeNormalized,
            promotionId: promoResult.promotionId,
            discountType: promoResult.discountType,
            discountValue: promoResult.discountValue,
            expiresAt: promoResult.expiresAt,
            source: promoCodeSource,
            durationCycles: promoDurationCycles,
            revertAt: promoRevertAt
          }
        : null,
      subscription: subscriptionDoc
    });
  } catch (error: any) {
    res.status(error?.status || 500).json({ error: error.message || String(error), code: error?.code });
  }
}

export async function getCards(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) {
      res.json({ cards: [] });
      return;
    }

    const { data, error } = await supabase
      .from('payment_credentials')
      .select('*')
      .eq('client_id', clientId);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    // Deduplicate by firestore_id or card_masked (migration may have inserted
    // the same card multiple times without a unique constraint)
    const seen = new Set<string>();
    const uniqueData = (data ?? []).filter((d: any) => {
      const key = d.firestore_id ?? d.card_masked ?? d.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const cards = uniqueData.map((d: any) => mapPaymentCredentialToCard(d.firestore_id ?? d.id, {
      'Card Name': d.card_name,
      'Card Number': d.card_masked,
      'Card Holder': d.card_name,
      'Card Suffix': d.card_masked?.replace(/\D+/g, '').slice(-4) ?? '',
      'Isracard Key': d.buyer_key,
      isSubscriptionCard: d.is_subscription_card,
      isDefault: d.is_default,
      brand: d.metadata?.brand ?? '',
      expiryMonth: d.metadata?.expiryMonth ?? null,
      expiryYear: d.metadata?.expiryYear ?? null,
      last4: d.card_masked?.replace(/\D+/g, '').slice(-4) ?? '',
      createdAt: d.created_at,
      updatedAt: d.updated_at,
      'Created At': d.created_at,
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
      // Champs optionnels envoyés par l'app (UX) - ne pas faire confiance.
      buyerZipCode?: unknown;
      cardBin6?: unknown;
      isRevolutCandidate?: unknown;
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

    const buyerZipCode = pickString(body.buyerZipCode);
    const bin6 = norm.digitsOnly.length >= 6 ? norm.digitsOnly.slice(0, 6) : '';
    const isRevolut = await isRevolutBin6(bin6);
    if (isRevolut && !buyerZipCode) {
      res.status(400).json({ error: 'Code postal requis pour une carte Revolut.', code: 'BUYER_ZIP_CODE_REQUIRED' });
      return;
    }

    const clientRef = db.collection('Clients').doc(uid);
    const clientData = await readClientInfo(uid, async () => {
      const snap = await clientRef.get();
      if (!snap.exists) return null as any;
      return (snap.data() || {}) as Record<string, any>;
    });
    if (!clientData) {
      res.status(404).json({ error: 'Client introuvable.' });
      return;
    }
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
      cvv,
      ...(isRevolut ? { buyerZipCode } : {})
    });

    // 2) Securden: STRICT (si PayMe OK, on crée obligatoirement sur Securden avant d'écrire Firestore)
    let folderId = pickString(clientData.securden_Folder);
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
    } else {
      res.status(400).json({ error: 'Client: First Name / Last Name requis pour créer le folder Securden.' });
      return;
    }

    if (!accountId) {
      res.status(502).json({ error: `Securden: échec création de la carte. ${securdenWarnings[0] || ''}`.trim() });
      return;
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
    dualWritePaymentCredential(uid, paymentRef.id, paymentDoc).catch(() => {});

    // Contrat mobile: retourner les identifiants PayMe + l'id Firestore créé.
    // Compat: inclure aussi une vue "card" (ancien format).
    res.status(201).json({
      paymentCredentialId: paymentRef.id,
      buyerKey: buyerToken.buyerKey,
      buyerCard: buyerToken.buyerCard,
      card: mapPaymentCredentialToCard(paymentRef.id, paymentDoc)
    });
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
    const paymentResult = await readPaymentCredential(uid, cardId, async () => {
      const snap = await paymentRef.get();
      return { exists: snap.exists, data: snap.exists ? (snap.data() || {}) as Record<string, any> : null };
    });
    if (paymentResult.exists) {
      await paymentRef.set(
        {
          ...updates,
          'Updated At': admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      dualWritePaymentCredential(uid, cardId, { ...(paymentResult.data || {}), ...updates }).catch(() => {});
      res.json({ message: 'Card updated', cardId });
      return;
    }
    res.status(404).json({ error: 'Card not found' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function deleteCard(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { cardId } = req.params;
    const db = getFirestore();

    const clientRef = db.collection('Clients').doc(uid);
    const paymentRef = clientRef.collection('Payment credentials').doc(cardId);

    const paymentResult = await readPaymentCredential(uid, cardId, async () => {
      const snap = await paymentRef.get().catch(() => null as any);
      return { exists: !!snap?.exists, data: snap?.exists ? (snap.data() as any) : null };
    });
    const securdenId = typeof paymentResult.data?.['Securden ID'] === 'string' ? String(paymentResult.data['Securden ID']).trim() : '';

    if (securdenId) {
      const s = await deleteSecurdenAccounts({
        accountIds: [securdenId],
        deletePermanently: false,
        reason: `Delete card ${cardId}`
      });
      if (!s.ok) {
        res
          .status(502)
          .json({ error: `Securden: suppression impossible. ${s.warnings[0] || ''}`.trim(), warnings: s.warnings });
        return;
      }
    }

    // Supprimer dans Payment credentials (principal)
    await paymentRef.delete().catch(() => {});
    resolveSupabaseClientId(uid).then(clientSupabaseId => {
      if (clientSupabaseId) {
        dualWriteDelete('payment_credentials', 'firestore_id', cardId).catch(() => {});
      }
    }).catch(() => {});

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

    const credResult = await readPaymentCredential(uid, cardId, async () => {
      const doc = await clientRef.collection('Payment credentials').doc(cardId).get();
      return { exists: doc.exists, data: doc.exists ? (doc.data() || {}) as Record<string, any> : null };
    });
    if (!credResult.exists) {
      res.status(404).json({ error: 'Card not found' });
      return;
    }

    const allCreds = await readAllPaymentCredentials(uid, async () => {
      const snap = await clientRef.collection('Payment credentials').get();
      return snap.docs.map(d => ({ id: d.id, data: (d.data() || {}) as Record<string, any> }));
    });

    // Update Firestore: set all to non-default, then selected to default
    for (const cred of allCreds) {
      batch.set(clientRef.collection('Payment credentials').doc(cred.id), { isDefault: false }, { merge: true });
    }
    batch.set(clientRef.collection('Payment credentials').doc(cardId), { isDefault: true }, { merge: true });

    await batch.commit();
    for (const cred of allCreds) {
      dualWritePaymentCredential(uid, cred.id, { ...cred.data, isDefault: cred.id === cardId }).catch(() => {});
    }

    res.json({ message: 'Default card set', cardId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getInvoices(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const { limit = 50 } = req.query;
    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) {
      res.json({ invoices: [] });
      return;
    }

    const { data, error } = await supabase
      .from('invoices')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(Number(limit));

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const invoices = (data ?? []).map((inv: any) => ({
      invoiceId: inv.firestore_id ?? inv.id,
      ...inv,
      // Legacy aliases
      invoiceNumber: inv.invoice_number ?? '',
      amount: inv.amount ?? inv.amount_cents ?? 0,
      amountCents: inv.amount_cents ?? inv.amount ?? 0,
      status: inv.status ?? '',
      paidAt: inv.paid_at ?? null,
      dueDate: inv.due_date ?? null,
      createdAt: inv.created_at ?? '',
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
    const clientId = await resolveSupabaseClientId(uid);

    const { data, error } = await supabase
      .from('invoices')
      .select('*')
      .eq('client_id', clientId)
      .or(`firestore_id.eq.${invoiceId},id.eq.${invoiceId}`)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }

    res.json({
      invoiceId,
      ...data,
      // Legacy aliases
      invoiceNumber: data.invoice_number ?? '',
      amount: data.amount ?? data.amount_cents ?? 0,
      amountCents: data.amount_cents ?? data.amount ?? 0,
      status: data.status ?? '',
      paidAt: data.paid_at ?? null,
      dueDate: data.due_date ?? null,
      createdAt: data.created_at ?? '',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getRefundRequests(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const uid = req.uid!;
    const clientId = await resolveSupabaseClientId(uid);
    if (!clientId) {
      res.json({ refunds: [] });
      return;
    }

    const { data, error } = await supabase
      .from('refund_requests')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const refunds = (data ?? []).map((r: any) => ({
      refundId: r.firestore_id ?? r.id,
      ...r,
      // Legacy aliases
      requestId: r.request_id ?? null,
      amount: r.amount ?? r.amount_cents ?? 0,
      amountCents: r.amount_cents ?? r.amount ?? 0,
      reason: r.reason ?? '',
      status: r.status ?? '',
      createdAt: r.created_at ?? '',
      updatedAt: r.updated_at ?? '',
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

    const refundData = {
      requestId: requestId || null,
      amount: Number(amount),
      reason: reason || '',
      status: 'pending',
      createdAt: new Date()
    };
    const refundRef = await db
      .collection('Clients')
      .doc(uid)
      .collection('refund_requests')
      .add(refundData);
    resolveSupabaseClientId(uid).then(clientSupabaseId => {
      dualWriteToSupabase('refund_requests', mapRefundRequestToSupabase(clientSupabaseId, refundRef.id, uid, { ...refundData, amountCents: refundData.amount }), { mode: 'insert' }).catch(() => {});
    }).catch(() => {});

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
    const clientId = await resolveSupabaseClientId(uid);

    const { data, error } = await supabase
      .from('refund_requests')
      .select('*')
      .eq('client_id', clientId)
      .or(`firestore_id.eq.${refundId},id.eq.${refundId}`)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Refund request not found' });
      return;
    }

    res.json({
      refundId,
      ...data,
      // Legacy aliases
      requestId: data.request_id ?? null,
      amount: data.amount ?? data.amount_cents ?? 0,
      amountCents: data.amount_cents ?? data.amount ?? 0,
      reason: data.reason ?? '',
      status: data.status ?? '',
      createdAt: data.created_at ?? '',
      updatedAt: data.updated_at ?? '',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

