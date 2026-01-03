import { admin, getFirestore } from '../config/firebase.js';
import { HttpError } from '../utils/errors.js';
import { paymeSetSubscriptionPrice } from './payme.service.js';
import { getFamilyMemberPricingNis, nisToCents } from './remoteConfigPricing.service.js';

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
  if (!memberIsActive(data)) return false;
  if (!memberLivesAtHome(data)) return false;
  const status = getMemberStatus(data);
  if (isConjoint(status)) return false;
  const b = getMemberBirthdayDate(data);
  if (!b) return false;
  return computeAgeYears(b) >= 18;
}

async function loadSubscriptionPaymeInfo(uid: string): Promise<{
  subId: string | null;
  planPriceInCents: number | null;
  planBasePriceInCents: number | null;
}> {
  const db = getFirestore();
  const currentSubscriptionDoc = await db.collection('Clients').doc(uid).collection('subscription').doc('current').get();
  if (!currentSubscriptionDoc.exists) return { subId: null, planPriceInCents: null, planBasePriceInCents: null };
  const data = (currentSubscriptionDoc.data() || {}) as Record<string, any>;
  const subId = pickString(data?.payme?.subID);
  const planPriceInCents =
    typeof data?.plan?.price === 'number' && Number.isFinite(data.plan.price) ? Number(data.plan.price) : null;
  const planBasePriceInCents =
    typeof data?.plan?.basePriceInCents === 'number' && Number.isFinite(data.plan.basePriceInCents)
      ? Number(data.plan.basePriceInCents)
      : null;
  return { subId: subId || null, planPriceInCents, planBasePriceInCents };
}

/**
 * Recalcule le supplément famille et le pousse à Payme.
 * Source of truth: liste des membres en Firestore (actifs + livesAtHome + >=18, hors Conjoint, hors titulaire).
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

  const { subId, planPriceInCents, planBasePriceInCents } = await loadSubscriptionPaymeInfo(uid);
  const basePriceInCents = planBasePriceInCents ?? planPriceInCents;

  // Mettre à jour flags membres (même si Payme est absent) pour garder l'app cohérente
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

  // Si pas d'abonnement Payme, on ne peut pas appliquer le supplément.
  if (!subId || basePriceInCents == null) {
    await batch.commit();
    if (eligibleAdultsCount > 0) {
      throw new HttpError(400, "Abonnement PayMe introuvable: impossible d'appliquer le supplément famille.");
    }
    return { eligibleAdultsCount, targetPriceInCents: null, paymeUpdated: false };
  }

  // On fige la base (une seule fois) pour éviter toute dérive dans le futur
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

  const targetPriceInCents = basePriceInCents + supplementTotalInCents;
  await paymeSetSubscriptionPrice({ subId, priceInCents: targetPriceInCents });

  return { eligibleAdultsCount, targetPriceInCents, paymeUpdated: true };
}


