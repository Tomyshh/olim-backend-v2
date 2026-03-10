import { admin, getFirestore } from '../config/firebase.js';
import { HttpError } from '../utils/errors.js';
import { paymeGetSubscriptionDetails, paymeSetSubscriptionPrice } from './payme.service.js';
import { getFamilyMemberPricingNis, nisToCents } from './remoteConfigPricing.service.js';
import { dualWriteSubscription, dualWriteFamilyMember } from './dualWrite.service.js';

const FAMILY_MEMBERS_COLLECTION = 'Family Members';

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pickBool(value: unknown, defaultValue: boolean): boolean {
  if (value === true) return true;
  if (value === false) return false;
  return defaultValue;
}

function isFirestoreTimestampLike(value: any): value is { toDate: () => Date } {
  return !!value && typeof value === 'object' && typeof value.toDate === 'function';
}

function parseBirthdayToDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (isFirestoreTimestampLike(value)) return value.toDate();

  // Firestore Timestamp JSON-like {seconds,nanoseconds}
  if (typeof value === 'object' && value != null) {
    const seconds = (value as any).seconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds)) {
      return new Date(seconds * 1000);
    }
  }

  const raw = pickString(value);
  if (!raw) return null;
  // dd/MM/yyyy
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yyyy)) return null;
  if (yyyy < 1900 || yyyy > 2100) return null;
  if (mm < 1 || mm > 12) return null;
  if (dd < 1 || dd > 31) return null;
  const d = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0));
  // Validate round-trip (avoid 31/02 rolling)
  if (d.getUTCFullYear() !== yyyy || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
  return d;
}

export function birthdayToTimestamp(value: unknown): admin.firestore.Timestamp | null {
  const d = parseBirthdayToDate(value);
  if (!d) return null;
  return admin.firestore.Timestamp.fromDate(d);
}

function computeAgeYears(birthday: Date, now: Date = new Date()): number {
  // Age sur calendrier (année - correction si pas encore l'anniversaire cette année)
  const yNow = now.getUTCFullYear();
  const mNow = now.getUTCMonth() + 1;
  const dNow = now.getUTCDate();

  const yB = birthday.getUTCFullYear();
  const mB = birthday.getUTCMonth() + 1;
  const dB = birthday.getUTCDate();

  let age = yNow - yB;
  if (mNow < mB || (mNow === mB && dNow < dB)) age -= 1;
  return age;
}

export function isConjoint(status: unknown): boolean {
  return pickString(status).toLowerCase() === 'conjoint';
}

function isAccountOwnerMember(docId: string, data: Record<string, any>): boolean {
  if (docId === 'account_owner') return true;
  if (data.isAccountOwner === true) return true;
  const status = pickString(data['Family Member Status'] ?? data.familyMemberStatus);
  return status === 'Account Owner';
}

function getMemberStatus(data: Record<string, any>): string {
  return pickString(data['Family Member Status'] ?? data.familyMemberStatus);
}

function getMemberBirthdayDate(data: Record<string, any>): Date | null {
  return parseBirthdayToDate(data.Birthday ?? data.birthday);
}

function memberIsActive(data: Record<string, any>): boolean {
  // Compat: si le champ n'existe pas, legacy = actif
  return pickBool(data.isActive, true);
}

function memberLivesAtHome(data: Record<string, any>): boolean {
  return pickBool(data.livesAtHome, false);
}

export function memberIsEligibleAdultSupplement(docId: string, data: Record<string, any>): boolean {
  if (isAccountOwnerMember(docId, data)) return false; // le titulaire est inclus dans l'abonnement de base
  // Override admin: permet d'ajouter/activer un membre majeur sans impacter la facturation (ni supplément mensuel)
  if (data.billingExempt === true) return false;
  if (!memberIsActive(data)) return false;
  if (!memberLivesAtHome(data)) return false;
  const status = getMemberStatus(data);
  if (isConjoint(status)) return false;

  // Priorité: champ age déjà calculé côté backend (plus robuste que reparser Birthday)
  const age = typeof (data as any).age === 'number' ? Number((data as any).age) : null;
  if (age != null && Number.isFinite(age)) {
    return age >= 18;
  }

  const b = getMemberBirthdayDate(data);
  if (!b) return false;
  return computeAgeYears(b) >= 18;
}

async function loadSubscriptionPaymeInfo(uid: string): Promise<{
  subId: string | null;
  subCode: number | string | null;
  planPriceInCents: number | null;
  planBasePriceInCents: number | null;
  previousFamilySupplementTotalInCents: number | null;
}> {
  const db = getFirestore();
  const currentSubscriptionDoc = await db.collection('Clients').doc(uid).collection('subscription').doc('current').get();
  if (!currentSubscriptionDoc.exists) return { subId: null, subCode: null, planPriceInCents: null, planBasePriceInCents: null, previousFamilySupplementTotalInCents: null };
  const data = (currentSubscriptionDoc.data() || {}) as Record<string, any>;
  const subId = pickString(data?.payme?.subID);
  const subCodeRaw = data?.payme?.subCode ?? data?.payme?.sub_payme_code ?? null;
  const subCode = subCodeRaw != null && (typeof subCodeRaw === 'number' || (typeof subCodeRaw === 'string' && subCodeRaw.trim())) ? subCodeRaw : null;
  const planPriceInCents =
    typeof data?.plan?.price === 'number' && Number.isFinite(data.plan.price) ? Number(data.plan.price) : null;
  const planBasePriceInCents =
    typeof data?.plan?.basePriceInCents === 'number' && Number.isFinite(data.plan.basePriceInCents)
      ? Number(data.plan.basePriceInCents)
      : null;
  const previousFamilySupplementTotalInCents =
    typeof data?.plan?.familySupplementTotalInCents === 'number' && Number.isFinite(data.plan.familySupplementTotalInCents)
      ? Number(data.plan.familySupplementTotalInCents)
      : null;
  return { subId: subId || null, subCode, planPriceInCents, planBasePriceInCents, previousFamilySupplementTotalInCents };
}

// ──────────────────────────────────────────────────────────────
// Helpers: récupérer le prix actuel de l'abonnement depuis Payme
// (source de vérité externe, utilisée en fallback si Firestore est incohérent)
// ──────────────────────────────────────────────────────────────

function parsePaymeMoneyToAgorot(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim()) {
    const s0 = value.trim().replace(',', '.');
    if (!s0) return null;
    if (s0.includes('.')) {
      const f = Number(s0);
      return Number.isFinite(f) ? Math.round(f * 100) : null;
    }
    const n = Number(s0);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

function pickPaymeSubscriptionAmountRaw(item: any): unknown {
  return (
    item?.sub_price ??
    item?.subPrice ??
    item?.transaction_periodical_payment ??
    item?.transactionPeriodicalPayment ??
    item?.transaction_first_payment ??
    item?.transactionFirstPayment ??
    item?.sale_price ??
    item?.salePrice ??
    item?.sale_price_after_fees ??
    item?.salePriceAfterFees ??
    item?.price ??
    item?.amount ??
    item?.sale?.sale_price ??
    item?.sale?.price ??
    null
  );
}

/**
 * Récupère le prix courant de l'abonnement Payme (en agorot/cents).
 * Retourne null si on n'arrive pas à l'obtenir (pas de sub, erreur réseau, etc.)
 */
async function fetchPaymeCurrentPriceInCents(subCode: number | string): Promise<number | null> {
  try {
    const details = await paymeGetSubscriptionDetails({ subCode });
    if (!details?.raw) return null;
    const items = Array.isArray(details.raw?.items) ? details.raw.items : [];
    const item = items.length > 0 ? items[0] : null;
    if (!item) return null;
    const rawPrice = pickPaymeSubscriptionAmountRaw(item);
    const agorot = parsePaymeMoneyToAgorot(rawPrice);
    return typeof agorot === 'number' && Number.isFinite(agorot) && agorot > 0 ? agorot : null;
  } catch (e: any) {
    console.error('[familyBilling] fetchPaymeCurrentPriceInCents: impossible de récupérer le prix Payme.', {
      subCode,
      message: e?.message || String(e)
    });
    return null;
  }
}

/**
 * Recalcule le supplément famille et le pousse à Payme.
 * Source of truth: liste des membres en Firestore (actifs + livesAtHome + >=18, hors Conjoint, hors titulaire).
 *
 * SÉCURITÉ :
 * - Le prix de base est d'abord lu depuis Firestore (plan.basePriceInCents).
 * - Si absent / invalide / <= 0 : on interroge Payme pour récupérer le prix réel,
 *   puis on déduit l'ancien supplément pour retrouver la base.
 * - Si malgré tout la base est <= 0, on refuse d'appliquer le supplément (erreur).
 * - Le prix cible ne peut jamais être < base ou <= 0.
 */
export async function recomputeAndApplyFamilyMonthlySupplement(uid: string): Promise<{
  eligibleAdultsCount: number;
  targetPriceInCents: number | null;
  paymeUpdated: boolean;
}> {
  const db = getFirestore();
  const pricing = await getFamilyMemberPricingNis();
  const monthlySupplementNis = pricing.monthlyNis;
  const monthlySupplementCents = nisToCents(monthlySupplementNis);

  const membersSnap = await db.collection('Clients').doc(uid).collection(FAMILY_MEMBERS_COLLECTION).get();

  const members = membersSnap.docs.map((d) => ({ id: d.id, data: (d.data() || {}) as Record<string, any> }));
  const eligibleAdults = members.filter((m) => memberIsEligibleAdultSupplement(m.id, m.data));
  const eligibleAdultsCount = eligibleAdults.length;
  const supplementTotalInCents = eligibleAdultsCount * monthlySupplementCents;

  const { subId, subCode, planPriceInCents, planBasePriceInCents, previousFamilySupplementTotalInCents } =
    await loadSubscriptionPaymeInfo(uid);

  // ── Étape 1 : Déterminer le prix de base de façon fiable ──────────────

  let basePriceInCents: number | null = null;

  // 1-a) Priorité : plan.basePriceInCents depuis Firestore (quand il est cohérent)
  if (planBasePriceInCents != null && planBasePriceInCents > 0) {
    basePriceInCents = planBasePriceInCents;
  }

  // 1-b) Fallback Firestore : plan.price – ancien supplément déjà appliqué
  if (basePriceInCents == null || basePriceInCents <= 0) {
    if (planPriceInCents != null && planPriceInCents > 0) {
      const oldSupplement = (previousFamilySupplementTotalInCents != null && previousFamilySupplementTotalInCents >= 0)
        ? previousFamilySupplementTotalInCents
        : 0;
      const derived = planPriceInCents - oldSupplement;
      if (derived > 0) {
        basePriceInCents = derived;
        console.warn(
          `[familyBilling] uid=${uid}: basePriceInCents dérivé depuis plan.price Firestore` +
          ` (planPrice=${planPriceInCents}, oldSupplement=${oldSupplement}, derived=${derived}).`
        );
      }
    }
  }

  // 1-c) Fallback Payme : interroger l'API Payme pour obtenir le prix réel
  if ((basePriceInCents == null || basePriceInCents <= 0) && subCode != null) {
    const paymePriceInCents = await fetchPaymeCurrentPriceInCents(subCode);
    if (paymePriceInCents != null && paymePriceInCents > 0) {
      const oldSupplement = (previousFamilySupplementTotalInCents != null && previousFamilySupplementTotalInCents >= 0)
        ? previousFamilySupplementTotalInCents
        : 0;
      const derived = paymePriceInCents - oldSupplement;
      if (derived > 0) {
        basePriceInCents = derived;
      } else {
        // Aucun supplément cohérent n'avait été appliqué : le prix Payme est la base brute
        basePriceInCents = paymePriceInCents;
      }
      console.warn(
        `[familyBilling] uid=${uid}: basePriceInCents récupéré depuis Payme` +
        ` (paymePriceInCents=${paymePriceInCents}, oldSupplement=${oldSupplement}, basePriceInCents=${basePriceInCents}).`
      );
    }
  }

  // ── Étape 2 : Mettre à jour les flags des membres ────────────────────

  const batch = db.batch();
  for (const m of members) {
    const eligible = memberIsEligibleAdultSupplement(m.id, m.data);
    batch.set(
      db.collection('Clients').doc(uid).collection(FAMILY_MEMBERS_COLLECTION).doc(m.id),
      {
        monthlySupplementApplied: eligible,
        monthlySupplementNis: monthlySupplementNis,
        isPaidAdultChild: eligible
      },
      { merge: true }
    );
  }

  // ── Étape 3 : Gardes de sécurité ─────────────────────────────────────

  // 3-a) Pas de subId Payme → impossible de modifier le prix
  if (!subId) {
    await batch.commit();
    if (eligibleAdultsCount > 0) {
      throw new HttpError(
        400,
        `Abonnement PayMe introuvable (subId manquant) pour uid=${uid}: impossible d'appliquer le supplément famille.`
      );
    }
    return { eligibleAdultsCount, targetPriceInCents: null, paymeUpdated: false };
  }

  // 3-b) Base invalide après tous les fallbacks → bloquer pour éviter un prix aberrant
  if (basePriceInCents == null || basePriceInCents <= 0) {
    await batch.commit();
    if (eligibleAdultsCount > 0) {
      throw new HttpError(
        400,
        `Prix de base de l'abonnement introuvable ou invalide (basePriceInCents=${basePriceInCents}) pour uid=${uid}. ` +
        `Impossible d'appliquer le supplément famille. Vérifiez l'abonnement du client.`
      );
    }
    // Pas d'adultes éligibles et pas de base : rien à faire (on ne touche pas au prix Payme)
    return { eligibleAdultsCount, targetPriceInCents: null, paymeUpdated: false };
  }

  // ── Étape 4 : Calculer et valider le prix cible ──────────────────────

  const targetPriceInCents = basePriceInCents + supplementTotalInCents;

  // Sécurité : le prix cible ne peut jamais être inférieur à la base
  if (targetPriceInCents < basePriceInCents) {
    throw new HttpError(
      500,
      `[BUG] targetPriceInCents (${targetPriceInCents}) < basePriceInCents (${basePriceInCents}) pour uid=${uid}.`
    );
  }

  // Sécurité : le prix cible doit être > 0
  if (targetPriceInCents <= 0) {
    throw new HttpError(
      500,
      `[BUG] targetPriceInCents est ${targetPriceInCents} pour uid=${uid}, ne peut pas être <= 0.`
    );
  }

  // ── Étape 5 : Persister en Firestore puis pousser à Payme ────────────

  const subscriptionRef = db.collection('Clients').doc(uid).collection('subscription').doc('current');
  batch.set(
    subscriptionRef,
    {
      plan: {
        basePriceInCents: basePriceInCents,
        familySupplementCount: eligibleAdultsCount,
        familySupplementTotalInCents: supplementTotalInCents
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  // Commit les flags Firestore avant Payme (cohérence + audit). Payme est ensuite idempotent (set-price).
  await batch.commit();
  for (const m of members) {
    const eligible = memberIsEligibleAdultSupplement(m.id, m.data);
    dualWriteFamilyMember(uid, m.id, { monthlySupplementApplied: eligible, monthlySupplementNis: monthlySupplementNis }).catch(() => {});
  }

  await paymeSetSubscriptionPrice({ subId, priceInCents: targetPriceInCents });

  // Aligner Firestore avec le prix réellement poussé à Payme
  await subscriptionRef.set(
    {
      plan: {
        price: targetPriceInCents
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
  dualWriteSubscription(uid, {
    plan: { price: targetPriceInCents, basePriceInCents, familySupplementCount: eligibleAdultsCount, familySupplementTotalInCents: supplementTotalInCents }
  }).catch(() => {});

  return { eligibleAdultsCount, targetPriceInCents, paymeUpdated: true };
}

/**
 * Pré-validation : vérifie qu'un abonnement Payme existe avec un prix de base valide
 * pour pouvoir appliquer le supplément famille.
 * À appeler AVANT d'activer un membre éligible au supplément,
 * afin d'éviter un état incohérent (membre activé mais prix non mis à jour).
 *
 * Lève une HttpError si l'abonnement est absent ou invalide.
 */
export async function assertSubscriptionCanSupportFamilySupplement(uid: string): Promise<void> {
  const { subId, subCode, planPriceInCents, planBasePriceInCents, previousFamilySupplementTotalInCents } =
    await loadSubscriptionPaymeInfo(uid);

  if (!subId) {
    throw new HttpError(
      400,
      `Impossible d'activer un membre famille payant: aucun abonnement PayMe trouvé (subId manquant) pour uid=${uid}.`
    );
  }

  // Vérifier qu'on a un prix de base > 0 (ou qu'on peut le dériver)
  let baseOk = false;

  // plan.basePriceInCents > 0 ?
  if (planBasePriceInCents != null && planBasePriceInCents > 0) {
    baseOk = true;
  }

  // Dérivé depuis plan.price - ancien supplément ?
  if (!baseOk && planPriceInCents != null && planPriceInCents > 0) {
    const oldSupplement = (previousFamilySupplementTotalInCents != null && previousFamilySupplementTotalInCents >= 0)
      ? previousFamilySupplementTotalInCents
      : 0;
    if (planPriceInCents - oldSupplement > 0) {
      baseOk = true;
    }
  }

  // Dernier recours : interroger Payme
  if (!baseOk && subCode != null) {
    const paymePriceInCents = await fetchPaymeCurrentPriceInCents(subCode);
    if (paymePriceInCents != null && paymePriceInCents > 0) {
      baseOk = true;
    }
  }

  if (!baseOk) {
    throw new HttpError(
      400,
      `Impossible d'activer un membre famille payant: prix de base de l'abonnement introuvable ou invalide ` +
      `(basePriceInCents=${planBasePriceInCents}, planPrice=${planPriceInCents}) pour uid=${uid}. ` +
      `Vérifiez l'abonnement du client avant de réessayer.`
    );
  }
}


