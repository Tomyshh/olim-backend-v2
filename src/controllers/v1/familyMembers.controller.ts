import type { Response } from 'express';
import { admin, getFirestore } from '../../config/firebase.js';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import { HttpError } from '../../utils/errors.js';
import { paymeGenerateSale } from '../../services/payme.service.js';
import { isConjoint, recomputeAndApplyFamilyMonthlySupplement, memberIsEligibleAdultSupplement, assertSubscriptionCanSupportFamilySupplement } from '../../services/familyBilling.service.js';
import { getFamilyMemberPricingNis, nisToCents } from '../../services/remoteConfigPricing.service.js';
import { dualWriteFamilyMember, dualWriteDelete } from '../../services/dualWrite.service.js';

const FAMILY_MEMBERS_COLLECTION = 'Family Members';

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pickBool(value: unknown, defaultValue: boolean): boolean {
  if (value === true) return true;
  if (value === false) return false;
  return defaultValue;
}

function pickStringOrNull(value: unknown): string | null {
  const s = pickString(value);
  return s ? s : null;
}

function coerceStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
  }
  const s = pickString(value);
  return s ? [s] : [];
}

function getLegacyKey(body: any, legacyKey: string, camelKey?: string): unknown {
  if (body && Object.prototype.hasOwnProperty.call(body, legacyKey)) return body[legacyKey];
  if (camelKey && body && Object.prototype.hasOwnProperty.call(body, camelKey)) return body[camelKey];
  return undefined;
}

function isPlainObject(value: any): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  // Important: exclure les sentinelles Firestore (FieldValue.serverTimestamp(), etc.)
  // et autres objets non "plain" (Timestamp, DocumentReference, etc.)
  return proto === Object.prototype || proto === null;
}

function pickFromMany(...values: unknown[]): unknown {
  for (const v of values) {
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function formatDdMmYyyyFromDate(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getUTCFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

function parseBirthdayToDdMmYyyy(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return formatDdMmYyyyFromDate(value);
  if (typeof (value as any)?.toDate === 'function') {
    try {
      const d = (value as any).toDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) return formatDdMmYyyyFromDate(d);
    } catch {
      // ignore
    }
  }
  if (typeof value === 'object' && value != null) {
    const seconds = (value as any).seconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds)) return formatDdMmYyyyFromDate(new Date(seconds * 1000));
  }

  const raw = pickString(value);
  if (!raw) return null;
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
  if (d.getUTCFullYear() !== yyyy || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
  return raw;
}

function computeAgeYearsFromBirthdayString(ddMmYyyy: string, now: Date = new Date()): number | null {
  const m = ddMmYyyy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yyyy)) return null;
  const b = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0));
  if (Number.isNaN(b.getTime())) return null;

  const yNow = now.getUTCFullYear();
  const mNow = now.getUTCMonth() + 1;
  const dNow = now.getUTCDate();
  const yB = b.getUTCFullYear();
  const mB = b.getUTCMonth() + 1;
  const dB = b.getUTCDate();
  let age = yNow - yB;
  if (mNow < mB || (mNow === mB && dNow < dB)) age -= 1;
  return age;
}

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    // On garde les arrays, mais on nettoie leurs items
    return value.map((v) => stripUndefinedDeep(v)) as any;
  }
  if (isPlainObject(value)) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = stripUndefinedDeep(v as any);
    }
    return out as any;
  }
  return value;
}

// ═══════════════════════════════════════════════════════════════════
// Normalisation de la réponse API (format canonique camelCase)
// ═══════════════════════════════════════════════════════════════════

function normalizeMemberForResponse(
  memberId: string,
  data: Record<string, any>
): {
  memberId: string;
  member: Record<string, any>;
  serviceState: Record<string, any>;
  validationStatus: string;
} {
  const birthday = pickString(data.Birthday);
  const age = birthday
    ? computeAgeYearsFromBirthdayString(birthday)
    : typeof data.age === 'number'
      ? data.age
      : null;
  const phoneNumbers = Array.isArray(data.phoneNumbers)
    ? data.phoneNumbers.filter(Boolean)
    : data['Phone Number']
      ? [data['Phone Number']]
      : [];

  return {
    memberId,
    member: {
      firstName: pickString(data['First Name']),
      lastName: pickStringOrNull(data['Last Name']),
      fatherName: pickStringOrNull(data['Father Name']),
      relationship: pickString(data['Family Member Status']),
      birthday: birthday || null,
      age,
      teoudatZeout: pickStringOrNull(data['Teoudat Zeout']),
      koupatHolim: pickStringOrNull(data['Koupat Holim']),
      phoneNumbers,
      email: pickStringOrNull(data.Email),
      livesAtHome: pickBool(data.livesAtHome, false),
      isChild: data.isChild === true,
      isAccountOwner: data.isAccountOwner === true
    },
    serviceState: {
      isActive: pickBool(data.isActive, true),
      serviceActive: pickBool(data.serviceActive, false),
      billingExempt: pickBool(data.billingExempt, false),
      billingExemptReason: pickStringOrNull(data.billingExemptReason),
      monthlySupplementApplied: pickBool(data.monthlySupplementApplied, false),
      monthlySupplementNis: typeof data.monthlySupplementNis === 'number' ? data.monthlySupplementNis : null,
      selectedCardId: pickStringOrNull(data.selectedCardId),
      serviceActivationPaymentId: pickStringOrNull(data.serviceActivationPaymentId)
    },
    validationStatus: pickString(data.validationStatus) || 'en_attente'
  };
}

function buildPricingImpact(monthly: {
  attempted: boolean;
  paymeUpdated: boolean;
  eligibleAdultsCount?: number;
  targetPriceInCents?: number | null;
}): Record<string, any> | null {
  if (!monthly.attempted) return null;
  return {
    recomputed: true,
    eligibleAdultsCount: monthly.eligibleAdultsCount ?? 0,
    targetPriceInCents: monthly.targetPriceInCents ?? null,
    paymeUpdated: monthly.paymeUpdated
  };
}

async function resolveCardIdForBilling(params: {
  db: ReturnType<typeof getFirestore>;
  uid: string;
  providedCardId: string;
  memberData: Record<string, any>;
}): Promise<string> {
  const { db, uid, providedCardId, memberData } = params;
  const fromMember = pickString(memberData?.selectedCardId);
  if (providedCardId) return providedCardId;
  if (fromMember) return fromMember;

  // Fallback: carte par défaut (Payment credentials.isDefault == true)
  const snap = await db
    .collection('Clients')
    .doc(uid)
    .collection('Payment credentials')
    .where('isDefault', '==', true)
    .limit(1)
    .get();
  const doc = snap.docs[0];
  if (doc) return doc.id;

  throw new HttpError(400, 'payment.cardId requis (aucune carte par défaut / carte membre).', 'CARD_REQUIRED');
}

function normalizePayload(body: any): { member: Record<string, any>; flags: Record<string, any>; payment: Record<string, any>; raw: any } {
  // PATCH legacy: { memberId, fields: { "First Name": "...", ... } }
  if (isPlainObject(body?.fields)) {
    return { member: {}, flags: {}, payment: {}, raw: body.fields };
  }

  // Forme principale: { member, flags, payment }
  if (isPlainObject(body?.member) || isPlainObject(body?.flags) || isPlainObject(body?.payment)) {
    return {
      member: isPlainObject(body?.member) ? body.member : {},
      flags: isPlainObject(body?.flags) ? body.flags : {},
      payment: isPlainObject(body?.payment) ? body.payment : {},
      raw: body
    };
  }

  // Tolérance: PATCH/POST peuvent envoyer directement les champs du membre à la racine
  // ex: { firstName, lastName, relationship, birthday, phoneNumbers, ... }
  if (isPlainObject(body)) {
    const hasMemberLikeKeys =
      'firstName' in body ||
      'lastName' in body ||
      'fatherName' in body ||
      'relationship' in body ||
      'birthday' in body ||
      'phoneNumbers' in body ||
      'email' in body ||
      'teoudatZeout' in body ||
      'koupatHolim' in body;
    if (hasMemberLikeKeys) {
      return { member: body, flags: {}, payment: {}, raw: body };
    }
  }

  return { member: {}, flags: {}, payment: {}, raw: body };
}

function buildMemberFirestoreDoc(params: { uid: string; body: any; defaults?: Record<string, any> }): Record<string, any> {
  const { uid, body } = params;
  // Contrat frontend: { member: { firstName, relationship, ... }, flags, payment }
  // Tolérance legacy: accepter aussi le format flat (First Name, Family Member Status, etc.)
  const { member, flags, payment, raw } = normalizePayload(body);

  const firstName = pickString(
    pickFromMany(
      member.firstName,
      getLegacyKey(raw, 'First Name'),
      getLegacyKey(raw, 'Prénom'),
      getLegacyKey(raw, 'firstName', 'firstName')
    )
  );
  if (!firstName) throw new HttpError(400, 'First Name requis.', 'MISSING_REQUIRED_FIELD');

  const familyMemberStatus = pickString(
    pickFromMany(
      member.relationship,
      getLegacyKey(raw, 'Family Member Status'),
      getLegacyKey(raw, 'Status'),
      getLegacyKey(raw, 'relationship', 'relationship'),
      getLegacyKey(raw, 'familyMemberStatus', 'familyMemberStatus')
    )
  );
  if (!familyMemberStatus) throw new HttpError(400, 'Family Member Status requis.', 'MISSING_REQUIRED_FIELD');

  // Requis côté storage: string "dd/MM/yyyy" (JJ/MM/YYYY)
  const birthdayRaw = pickFromMany(member.birthday, getLegacyKey(raw, 'Birthday', 'birthday'));
  const birthdayStr = birthdayRaw == null ? null : parseBirthdayToDdMmYyyy(birthdayRaw);
  // Birthday requis (car on doit calculer age et la facturation dépend de l'âge)
  if (birthdayRaw == null) {
    throw new HttpError(400, 'Birthday requis (format "dd/MM/yyyy").', 'INVALID_BIRTHDAY');
  }
  if (!birthdayStr) {
    throw new HttpError(400, 'Birthday invalide (attendu "dd/MM/yyyy").', 'INVALID_BIRTHDAY');
  }
  const age = birthdayStr ? computeAgeYearsFromBirthdayString(birthdayStr) : null;

  const phoneNumbers = coerceStringList(
    pickFromMany(member.phoneNumbers, getLegacyKey(raw, 'phoneNumbers', 'phoneNumbers'), getLegacyKey(raw, 'Phone Number', 'phoneNumber'))
  );
  const phoneNumber =
    pickStringOrNull(pickFromMany(member.phoneNumber, getLegacyKey(raw, 'Phone Number', 'phoneNumber'))) ??
    (phoneNumbers.length > 0 ? phoneNumbers[0]! : null);

  const doc: Record<string, any> = {
    // Champs legacy (exact)
    'First Name': firstName,
    'Last Name': pickStringOrNull(pickFromMany(member.lastName, getLegacyKey(raw, 'Last Name', 'lastName'))),
    'Father Name': pickStringOrNull(pickFromMany(member.fatherName, getLegacyKey(raw, 'Father Name', 'fatherName'))),
    Email: pickStringOrNull(pickFromMany(member.email, getLegacyKey(raw, 'Email', 'email'))),
    'Phone Number': phoneNumber,
    phoneNumbers: phoneNumbers,
    'Teoudat Zeout': pickStringOrNull(pickFromMany(member.teoudatZeout, getLegacyKey(raw, 'Teoudat Zeout', 'teoudatZeout'))),
    ...(birthdayStr ? { Birthday: birthdayStr } : {}),
    ...(typeof age === 'number' && Number.isFinite(age) ? { age } : {}),
    'Koupat Holim': pickStringOrNull(pickFromMany(member.koupatHolim, getLegacyKey(raw, 'Koupat Holim', 'koupatHolim'))),
    'Family Member Status': familyMemberStatus,
    hasGOVacces: pickBool(pickFromMany(raw?.hasGOVacces, raw?.hasGOVacces), false),
    isConnected: pickBool(pickFromMany(raw?.isConnected, raw?.isConnected), false),
    'Created From': pickStringOrNull(pickFromMany(getLegacyKey(raw, 'Created From', 'createdFrom'))) ?? 'Application',

    // Nouveaux champs (flat, non cassants)
    isAccountOwner: pickBool(pickFromMany(raw?.isAccountOwner, raw?.isAccountOwner), false),
    isChild: raw?.isChild === undefined ? undefined : pickBool(raw?.isChild, false),
    isActive: pickBool(pickFromMany(raw?.isActive, raw?.isActive), true),
    livesAtHome: pickBool(pickFromMany(flags.livesAtHome, raw?.livesAtHome), false),
    validationStatus: pickStringOrNull(pickFromMany(flags.validationStatus, raw?.validationStatus)) ?? 'en_attente',
    serviceActive: pickBool(pickFromMany(raw?.serviceActive, raw?.serviceActive), false),
    selectedCardId: pickStringOrNull(pickFromMany(payment.cardId, raw?.selectedCardId)),
    serviceActivatedAt: pickFromMany(raw?.serviceActivatedAt, null) ?? null,
    serviceActivationPaymentId: pickStringOrNull(pickFromMany(raw?.serviceActivationPaymentId)),
    monthlySupplementApplied: pickBool(pickFromMany(raw?.monthlySupplementApplied), false),
    monthlySupplementNis:
      typeof pickFromMany(raw?.monthlySupplementNis) === 'number'
        ? (pickFromMany(raw?.monthlySupplementNis) as number)
        : 69
  };

  return stripUndefinedDeep({ ...(params.defaults || {}), ...doc });
}

function buildUpdateDoc(params: { uid: string; body: any }): Record<string, any> {
  const { uid, body } = params;
  const { member, flags, payment, raw } = normalizePayload(body);
  const updates: Record<string, any> = {};

  const maybe = (legacyKey: string, camelKey?: string) => getLegacyKey(raw, legacyKey, camelKey);

  if (member.firstName !== undefined || maybe('First Name') !== undefined || maybe('Prénom') !== undefined) {
    updates['First Name'] = pickString(pickFromMany(member.firstName, maybe('First Name'), maybe('Prénom')));
  }
  if (member.lastName !== undefined || maybe('Last Name', 'lastName') !== undefined) {
    updates['Last Name'] = pickStringOrNull(pickFromMany(member.lastName, maybe('Last Name', 'lastName')));
  }
  if (member.fatherName !== undefined || maybe('Father Name', 'fatherName') !== undefined) {
    updates['Father Name'] = pickStringOrNull(pickFromMany(member.fatherName, maybe('Father Name', 'fatherName')));
  }
  if (member.email !== undefined || maybe('Email', 'email') !== undefined) {
    updates.Email = pickStringOrNull(pickFromMany(member.email, maybe('Email', 'email')));
  }

  if (
    member.phoneNumbers !== undefined ||
    member.phoneNumber !== undefined ||
    maybe('phoneNumbers', 'phoneNumbers') !== undefined ||
    maybe('Phone Number', 'phoneNumber') !== undefined
  ) {
    // Tolérance: certains payloads envoient Phone Number comme array (au lieu de string)
    const phoneNumbers = coerceStringList(
      pickFromMany(member.phoneNumbers, maybe('phoneNumbers', 'phoneNumbers'), maybe('Phone Number', 'phoneNumber'))
    );
    const phoneNumber =
      pickStringOrNull(pickFromMany(member.phoneNumber, maybe('Phone Number', 'phoneNumber'))) ??
      (phoneNumbers.length > 0 ? phoneNumbers[0]! : null);
    updates['Phone Number'] = phoneNumber;
    updates.phoneNumbers = phoneNumbers;
  }

  if (member.teoudatZeout !== undefined || maybe('Teoudat Zeout', 'teoudatZeout') !== undefined) {
    updates['Teoudat Zeout'] = pickStringOrNull(pickFromMany(member.teoudatZeout, maybe('Teoudat Zeout', 'teoudatZeout')));
  }
  if (member.koupatHolim !== undefined || maybe('Koupat Holim', 'koupatHolim') !== undefined) {
    updates['Koupat Holim'] = pickStringOrNull(pickFromMany(member.koupatHolim, maybe('Koupat Holim', 'koupatHolim')));
  }
  if (member.relationship !== undefined || maybe('Family Member Status') !== undefined || maybe('Status') !== undefined || maybe('relationship') !== undefined) {
    updates['Family Member Status'] = pickString(pickFromMany(member.relationship, maybe('Family Member Status'), maybe('Status'), maybe('relationship')));
  }

  if (member.birthday !== undefined || maybe('Birthday', 'birthday') !== undefined) {
    const birthdayStr = parseBirthdayToDdMmYyyy(pickFromMany(member.birthday, maybe('Birthday', 'birthday')));
    if (!birthdayStr) throw new HttpError(400, 'Birthday invalide (attendu "dd/MM/yyyy").', 'INVALID_BIRTHDAY');
    updates.Birthday = birthdayStr;
    const age = computeAgeYearsFromBirthdayString(birthdayStr);
    if (typeof age === 'number' && Number.isFinite(age)) updates.age = age;
  }

  if (raw?.hasGOVacces !== undefined) updates.hasGOVacces = pickBool(raw.hasGOVacces, false);
  if (raw?.isConnected !== undefined) updates.isConnected = pickBool(raw.isConnected, false);

  // Nouveaux champs
  if (raw?.isAccountOwner !== undefined) updates.isAccountOwner = pickBool(raw.isAccountOwner, false);
  if (raw?.isChild !== undefined) updates.isChild = pickBool(raw.isChild, false);
  if (raw?.isActive !== undefined) updates.isActive = pickBool(raw.isActive, true);
  if (flags.livesAtHome !== undefined || raw?.livesAtHome !== undefined) {
    updates.livesAtHome = pickBool(pickFromMany(flags.livesAtHome, raw?.livesAtHome), false);
  }
  if (flags.validationStatus !== undefined || raw?.validationStatus !== undefined) {
    updates.validationStatus = pickStringOrNull(pickFromMany(flags.validationStatus, raw?.validationStatus));
  }
  if (payment.cardId !== undefined || raw?.selectedCardId !== undefined) {
    updates.selectedCardId = pickStringOrNull(pickFromMany(payment.cardId, raw?.selectedCardId));
  }

  // billingExempt (flags ou raw)
  if (flags.billingExempt !== undefined || raw?.billingExempt !== undefined) {
    updates.billingExempt = pickBool(pickFromMany(flags.billingExempt, raw?.billingExempt), false);
    if (updates.billingExempt) {
      updates.billingExemptReason =
        pickStringOrNull(pickFromMany(flags.billingExemptReason, raw?.billingExemptReason)) || 'admin_manual';
    }
  }

  // Champs système
  updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

  return stripUndefinedDeep(updates);
}

function patchAffectsMonthlySupplement(body: any): boolean {
  const { member, flags, raw } = normalizePayload(body);
  const keys = new Set<string>([...Object.keys(raw || {}), ...Object.keys(member || {}), ...Object.keys(flags || {})]);
  return (
    keys.has('Birthday') ||
    keys.has('birthday') ||
    keys.has('Family Member Status') ||
    keys.has('familyMemberStatus') ||
    keys.has('relationship') ||
    keys.has('isActive') ||
    keys.has('livesAtHome') ||
    keys.has('billingExempt')
  );
}

function pickTargetClientUidFromParams(req: AuthenticatedRequest): string {
  const uid = pickString((req.params as any)?.uid);
  if (!uid) throw new HttpError(400, 'Paramètre uid (client) manquant.', 'MISSING_REQUIRED_FIELD');
  return uid;
}

function ensureRequiredIdentityFields(params: {
  existing: Record<string, any>;
  body: any;
}): { firstName: string; status: string; birthdayStr: string; age: number | null } {
  const { existing, body } = params;
  const normalized = normalizePayload(body || {});
  const raw = normalized.raw || body || {};

  const firstName =
    pickString(existing['First Name']) ||
    pickString(
      pickFromMany(
        normalized.member?.firstName,
        getLegacyKey(raw, 'First Name'),
        getLegacyKey(raw, 'Prénom'),
        getLegacyKey(raw, 'firstName', 'firstName')
      )
    );

  const status =
    pickString(existing['Family Member Status']) ||
    pickString(
      pickFromMany(
        normalized.member?.relationship,
        getLegacyKey(raw, 'Family Member Status'),
        getLegacyKey(raw, 'Status'),
        getLegacyKey(raw, 'relationship', 'relationship'),
        getLegacyKey(raw, 'familyMemberStatus', 'familyMemberStatus')
      )
    );

  const birthdayRaw = pickFromMany(normalized.member?.birthday, getLegacyKey(raw, 'Birthday', 'birthday'), existing.Birthday);
  const birthdayStr = birthdayRaw == null ? '' : parseBirthdayToDdMmYyyy(birthdayRaw) || '';

  const missing: string[] = [];
  if (!firstName) missing.push('First Name');
  if (!status) missing.push('Family Member Status');
  if (!birthdayStr) missing.push('Birthday (dd/MM/yyyy)');
  if (missing.length > 0) {
    throw new HttpError(400, `Champs requis manquants pour activer: ${missing.join(', ')}.`, 'MISSING_REQUIRED_FIELD');
  }

  const age = birthdayStr ? computeAgeYearsFromBirthdayString(birthdayStr) : null;
  return { firstName, status, birthdayStr, age };
}

export async function v1CreateFamilyMember(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid!;
  const db = getFirestore();
  const pricing = await getFamilyMemberPricingNis();
  const normalized = normalizePayload(req.body || {});
  const cardIdFromPayload = pickString(
    pickFromMany(
      normalized.payment?.cardId,
      (req.body as any)?.payment?.cardId,
      (req.body as any)?.cardId,
      (req.body as any)?.selectedCardId
    )
  );

  const doc = buildMemberFirestoreDoc({
    uid,
    body: req.body || {},
    defaults: {
      isActive: true,
      serviceActive: false,
      monthlySupplementApplied: false,
      monthlySupplementNis: pricing.monthlyNis,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }
  });

  const status = pickString(doc['Family Member Status']);
  const age = typeof (doc as any).age === 'number' ? Number((doc as any).age) : null;
  const isAdult = age != null && Number.isFinite(age) && age >= 18;
  let salePaymeId: string | null = null;

  // Si majeur (hors conjoint), l'ajout doit déclencher les 2 actions:
  // - one-shot (activation service)
  // - supplément mensuel (géré plus bas via recompute)
  if (isAdult && !isConjoint(status)) {
    if (!cardIdFromPayload) {
      throw new HttpError(400, 'payment.cardId requis pour ajouter un membre majeur.', 'CARD_REQUIRED');
    }
    // Par défaut, un membre majeur ajouté est considéré "au foyer" si le frontend n'a pas explicitement fourni le flag.
    // Sans livesAtHome=true, le supplément mensuel ne peut pas être appliqué.
    if ((doc as any).livesAtHome !== true) {
      (doc as any).livesAtHome = true;
    }

    // Récupérer buyerKey depuis Payment credentials/{cardId}
    const cardSnap = await db.collection('Clients').doc(uid).collection('Payment credentials').doc(cardIdFromPayload).get();
    if (!cardSnap.exists) throw new HttpError(404, 'Carte introuvable.', 'CARD_NOT_FOUND');
    const buyerKey = pickString((cardSnap.data() || {})['Isracard Key']);
    if (!buyerKey) throw new HttpError(400, 'Carte invalide: buyerKey PayMe manquant.', 'INVALID_CARD');

    const ponctuallyPriceInCents = nisToCents(pricing.ponctuallyNis);
    if (!ponctuallyPriceInCents || ponctuallyPriceInCents <= 0) {
      throw new HttpError(500, 'Prix activation service invalide (Remote Config).', 'INVALID_PRICING');
    }

    // Débit one-shot immédiatement à l'ajout (membre majeur)
    const sale = await paymeGenerateSale({
      priceInCents: ponctuallyPriceInCents,
      description: `Ajout membre famille (majeur) - ${pickString(doc['First Name'])} ${pickString(doc['Last Name'])}`.trim(),
      buyerKey
    });
    salePaymeId = sale.salePaymeId;

    // Marquer service activé (idempotence: ce membre est nouveau)
    (doc as any).serviceActive = true;
    (doc as any).serviceActivationPaymentId = sale.salePaymeId;
    (doc as any).selectedCardId = cardIdFromPayload;
    (doc as any).serviceActivatedAt = admin.firestore.FieldValue.serverTimestamp();
  }

  const ref = await db.collection('Clients').doc(uid).collection(FAMILY_MEMBERS_COLLECTION).add(stripUndefinedDeep(doc));
  dualWriteFamilyMember(uid, ref.id, doc).catch(() => {});

  // Recompute systématique après création (le calcul interne décide si count=0/1/2/...).
  // C'est ce qui garantit le caractère "cumulable" sans dépendre d'un pré-check fragile.
  const shouldRecompute = !isConjoint(status);

  let monthly: { attempted: boolean; paymeUpdated: boolean; eligibleAdultsCount?: number; targetPriceInCents?: number | null } = {
    attempted: false,
    paymeUpdated: false
  };
  if (shouldRecompute) {
    monthly.attempted = true;
    const result = await recomputeAndApplyFamilyMonthlySupplement(uid);
    monthly.paymeUpdated = result.paymeUpdated;
    monthly.eligibleAdultsCount = result.eligibleAdultsCount;
    monthly.targetPriceInCents = result.targetPriceInCents;
  }

  res.status(201).json({
    memberId: ref.id,
    ...doc,
    billing: {
      sale: { attempted: isAdult && !isConjoint(status), salePaymeId },
      monthly
    }
  });
}

export async function v1UpdateFamilyMember(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid!;
  const memberId = pickString(req.params.id);
  if (!memberId) throw new HttpError(400, 'Id manquant.', 'MISSING_MEMBER_ID');

  const db = getFirestore();
  const ref = db.collection('Clients').doc(uid).collection(FAMILY_MEMBERS_COLLECTION).doc(memberId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Membre introuvable.', 'MEMBER_NOT_FOUND');

  const updates = buildUpdateDoc({ uid, body: req.body || {} });
  // Si rien à mettre à jour (à part updatedAt), on évite un faux-positif
  const meaningfulKeys = Object.keys(updates).filter((k) => k !== 'updatedAt');
  if (meaningfulKeys.length === 0) {
    throw new HttpError(400, 'Aucun champ à modifier.', 'NO_FIELDS_TO_UPDATE');
  }
  await ref.set(stripUndefinedDeep(updates), { merge: true });
  dualWriteFamilyMember(uid, memberId, updates).catch(() => {});

  if (patchAffectsMonthlySupplement(req.body || {})) {
    await recomputeAndApplyFamilyMonthlySupplement(uid);
  }

  const after = await ref.get();
  res.json({ ok: true, memberId, member: { memberId, ...(after.data() || {}) } });
}

export async function v1DeactivateFamilyMember(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid!;
  const memberId = pickString(req.params.id);
  if (!memberId) throw new HttpError(400, 'Id manquant.', 'MISSING_MEMBER_ID');

  const db = getFirestore();
  const ref = db.collection('Clients').doc(uid).collection(FAMILY_MEMBERS_COLLECTION).doc(memberId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Membre introuvable.', 'MEMBER_NOT_FOUND');

  await ref.set(
    {
      isActive: false,
      deactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
  dualWriteFamilyMember(uid, memberId, { isActive: false, deactivatedAt: new Date().toISOString() }).catch(() => {});

  await recomputeAndApplyFamilyMonthlySupplement(uid);
  res.json({ ok: true, memberId });
}

export async function v1ActivateFamilyMember(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid!;
  const memberId = pickString(req.params.id);
  if (!memberId) throw new HttpError(400, 'Id manquant.', 'MISSING_MEMBER_ID');

  const db = getFirestore();
  const ref = db.collection('Clients').doc(uid).collection(FAMILY_MEMBERS_COLLECTION).doc(memberId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Membre introuvable.', 'MEMBER_NOT_FOUND');

  const data = (snap.data() || {}) as Record<string, any>;
  const status = pickString(data['Family Member Status']);
  const age =
    typeof data.age === 'number'
      ? Number(data.age)
      : typeof data.Birthday === 'string'
        ? computeAgeYearsFromBirthdayString(data.Birthday)
        : null;
  const isAdult = age != null && Number.isFinite(age) && age >= 18;
  const normalized = normalizePayload(req.body || {});
  const cardIdFromPayload = pickString(
    pickFromMany(
      normalized.payment?.cardId,
      (req.body as any)?.payment?.cardId,
      (req.body as any)?.cardId,
      (req.body as any)?.selectedCardId
    )
  );

  // Idempotence: si déjà actif, rien à faire
  if (data.isActive === true) {
    res.json({ ok: true, memberId, alreadyActive: true });
    return;
  }

  const updates: Record<string, any> = {
    // on set isActive après le sale (voir plus bas)
    reactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  // Contrat frontend: /activate doit prélever (sale) AVANT d'activer le membre.
  // Règle: Conjoint = gratuit => pas de sale.
  // On déclenche le sale si membre majeur (>=18) et non conjoint.
  let salePaymeId: string | null = null;
  if (isAdult && !isConjoint(status)) {
    // Sécurité : vérifier que l'abonnement Payme existe et a un prix de base valide
    // AVANT de prélever et d'activer le membre (évite un état incohérent).
    await assertSubscriptionCanSupportFamilySupplement(uid);

    // Ici, on exige la cardId envoyée par le frontend (pas de fallback silencieux)
    const cardId = cardIdFromPayload;
    if (!cardId) throw new HttpError(400, 'cardId requis pour réactiver un membre majeur.', 'CARD_REQUIRED');

    // Récupérer buyerKey depuis Payment credentials/{cardId}
    const cardSnap = await db.collection('Clients').doc(uid).collection('Payment credentials').doc(cardId).get();
    if (!cardSnap.exists) throw new HttpError(404, 'Carte introuvable.', 'CARD_NOT_FOUND');
    const buyerKey = pickString((cardSnap.data() || {})['Isracard Key']);
    if (!buyerKey) throw new HttpError(400, 'Carte invalide: buyerKey PayMe manquant.', 'INVALID_CARD');

    const pricing = await getFamilyMemberPricingNis();
    const ponctuallyPriceInCents = nisToCents(pricing.ponctuallyNis);
    if (!ponctuallyPriceInCents || ponctuallyPriceInCents <= 0) {
      throw new HttpError(500, 'Prix activation service invalide (Remote Config).', 'INVALID_PRICING');
    }

    // Débit one-shot lors de la réactivation (membre majeur)
    const sale = await paymeGenerateSale({
      priceInCents: ponctuallyPriceInCents,
      description: `Réactivation membre famille (majeur) - ${pickString(data['First Name'])} ${pickString(data['Last Name'])}`.trim(),
      buyerKey
    });
    salePaymeId = sale.salePaymeId;

    updates.serviceActive = true;
    updates.serviceActivationPaymentId = sale.salePaymeId;
    updates.selectedCardId = cardId;
    updates.serviceActivatedAt = admin.firestore.FieldValue.serverTimestamp();

    // Pour que le supplément mensuel soit appliqué au moment de la réactivation
    if (data.livesAtHome !== true) updates.livesAtHome = true;
  }

  // Activer le membre après le sale (ou immédiatement si pas de sale requis)
  updates.isActive = true;
  // Passer le statut de validation à "validé" (le membre a été activé/payé)
  updates.validationStatus = 'validé';
  await ref.set(stripUndefinedDeep(updates), { merge: true });
  dualWriteFamilyMember(uid, memberId, updates).catch(() => {});

  // Vérification de sécurité: garantir que isActive est bien défini
  const verifySnap = await ref.get();
  const verifyData = verifySnap.data() || {};
  if (verifyData.serviceActive === true && verifyData.isActive !== true) {
    await ref.set({ isActive: true }, { merge: true });
  }

  // Recalculer le supplément mensuel (si le membre est éligible)
  await recomputeAndApplyFamilyMonthlySupplement(uid);

  res.json({
    ok: true,
    memberId,
    billing: {
      sale: { attempted: isAdult && !isConjoint(status), salePaymeId }
    }
  });
}

export async function v1DeleteFamilyMember(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid!;
  const memberId = pickString(req.params.id);
  if (!memberId) throw new HttpError(400, 'Id manquant.', 'MISSING_MEMBER_ID');

  // Sécurité: ne jamais supprimer le titulaire
  if (memberId === 'account_owner') {
    throw new HttpError(400, "Impossible de supprimer le titulaire du compte.", 'CANNOT_DELETE_ACCOUNT_OWNER');
  }

  const db = getFirestore();
  const ref = db.collection('Clients').doc(uid).collection(FAMILY_MEMBERS_COLLECTION).doc(memberId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Membre introuvable.', 'MEMBER_NOT_FOUND');

  const memberData = (snap.data() || {}) as Record<string, any>;
  // Refuser la suppression d'un membre avec service actif
  if (memberData.serviceActive === true && memberData.isActive === true) {
    throw new HttpError(
      400,
      "Impossible de supprimer un membre avec un service actif. Désactivez-le d'abord.",
      'MEMBER_ACTIVE_CANNOT_DELETE'
    );
  }

  // Suppression complète du document Firestore (hard delete)
  await ref.delete();
  dualWriteDelete('family_members', 'firestore_id', memberId).catch(() => {});

  // Recalculer pour retirer le supplément (cumulable) si ce membre contribuait
  await recomputeAndApplyFamilyMonthlySupplement(uid);

  res.json({ ok: true, memberId, deleted: true });
}

export async function v1ActivateFamilyMemberService(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid!;
  const memberId = pickString(req.params.id);
  if (!memberId) throw new HttpError(400, 'Id manquant.', 'MISSING_MEMBER_ID');

  const cardId = pickString(req.body?.payment?.cardId ?? req.body?.cardId ?? req.body?.selectedCardId);
  if (!cardId) throw new HttpError(400, 'cardId requis.', 'CARD_REQUIRED');

  const db = getFirestore();
  const memberRef = db.collection('Clients').doc(uid).collection(FAMILY_MEMBERS_COLLECTION).doc(memberId);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) throw new HttpError(404, 'Membre introuvable.', 'MEMBER_NOT_FOUND');

  const memberData = (memberSnap.data() || {}) as Record<string, any>;
  const status = pickString(memberData['Family Member Status']);

  // Idempotence: si déjà actif, on répond OK
  if (memberData.serviceActive === true) {
    // Cas réel observé: serviceActive=true mais isActive=false (incohérent).
    // Contrat: si le service est actif, le membre doit être actif.
    if (memberData.isActive !== true) {
      await memberRef.set(
        {
          isActive: true,
          reactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      await recomputeAndApplyFamilyMonthlySupplement(uid);
    }
    res.json({
      ok: true,
      memberId,
      serviceActive: true,
      serviceActivationPaymentId: memberData.serviceActivationPaymentId ?? null
    });
    return;
  }

  // Conjoint: gratuit => pas de paiement
  if (isConjoint(status)) {
    const conjointUpdates = {
      isActive: true,
      serviceActive: true,
      serviceActivationPaymentId: null,
      selectedCardId: cardId,
      validationStatus: 'validé',
      serviceActivatedAt: admin.firestore.FieldValue.serverTimestamp(),
      reactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await memberRef.set(conjointUpdates, { merge: true });
    dualWriteFamilyMember(uid, memberId, conjointUpdates).catch(() => {});
    // Vérification de sécurité: garantir que isActive est bien défini
    const verifySnap = await memberRef.get();
    const verifyData = verifySnap.data() || {};
    if (verifyData.serviceActive === true && verifyData.isActive !== true) {
      await memberRef.set({ isActive: true }, { merge: true });
    }
    await recomputeAndApplyFamilyMonthlySupplement(uid);
    res.json({ ok: true, memberId, serviceActive: true, serviceActivationPaymentId: null });
    return;
  }

  // Sécurité : vérifier que l'abonnement Payme existe et a un prix de base valide
  // AVANT de prélever et d'activer le membre (évite un état incohérent).
  await assertSubscriptionCanSupportFamilySupplement(uid);

  // Récupérer buyerKey depuis Payment credentials/{cardId}
  const cardSnap = await db.collection('Clients').doc(uid).collection('Payment credentials').doc(cardId).get();
  if (!cardSnap.exists) throw new HttpError(404, 'Carte introuvable.', 'CARD_NOT_FOUND');
  const buyerKey = pickString((cardSnap.data() || {})['Isracard Key']);
  if (!buyerKey) throw new HttpError(400, 'Carte invalide: buyerKey PayMe manquant.', 'INVALID_CARD');

  // Débit one-shot (Remote Config: add_family_member_ponctually en NIS)
  const pricing = await getFamilyMemberPricingNis();
  const ponctuallyPriceInCents = nisToCents(pricing.ponctuallyNis);
  if (!ponctuallyPriceInCents || ponctuallyPriceInCents <= 0) {
    throw new HttpError(500, 'Prix activation service invalide (Remote Config).', 'INVALID_PRICING');
  }

  const sale = await paymeGenerateSale({
    priceInCents: ponctuallyPriceInCents,
    description: `Activation service - Family Member ${memberId}`,
    buyerKey
  });

  const serviceUpdates = {
    isActive: true,
    serviceActive: true,
    serviceActivationPaymentId: sale.salePaymeId,
    selectedCardId: cardId,
    validationStatus: 'validé',
    serviceActivatedAt: admin.firestore.FieldValue.serverTimestamp(),
    reactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  await memberRef.set(serviceUpdates, { merge: true });
  dualWriteFamilyMember(uid, memberId, serviceUpdates).catch(() => {});

  // Vérification de sécurité: garantir que isActive est bien défini
  // (cas observé: serviceActive=true mais isActive manquant)
  const verifySnap = await memberRef.get();
  const verifyData = verifySnap.data() || {};
  if (verifyData.serviceActive === true && verifyData.isActive !== true) {
    await memberRef.set({ isActive: true }, { merge: true });
  }

  await recomputeAndApplyFamilyMonthlySupplement(uid);
  res.json({ ok: true, memberId, serviceActive: true, serviceActivationPaymentId: sale.salePaymeId });
}

// =========================
// Admin routes (agir pour un client cible)
// =========================

async function adminCreateFamilyMember(params: {
  clientUid: string;
  adminUid: string;
  body: any;
  mode: 'adult_free' | 'adult_paid' | 'child' | 'conjoint_free';
}): Promise<{
  memberId: string;
  doc: Record<string, any>;
  billing: any;
}> {
  const { clientUid, adminUid, body, mode } = params;
  const db = getFirestore();
  const pricing = await getFamilyMemberPricingNis();
  const normalized = normalizePayload(body || {});
  const cardIdFromPayload = pickString(
    pickFromMany(
      normalized.payment?.cardId,
      (body as any)?.payment?.cardId,
      (body as any)?.cardId,
      (body as any)?.selectedCardId
    )
  );

  const defaults: Record<string, any> = {
    isActive: true,
    serviceActive: false,
    monthlySupplementApplied: false,
    monthlySupplementNis: pricing.monthlyNis,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdByAdminUid: adminUid,
    createdByAdminAt: admin.firestore.FieldValue.serverTimestamp()
  };

  const doc = buildMemberFirestoreDoc({ uid: clientUid, body: body || {}, defaults });

  // Mode overrides
  if (mode === 'conjoint_free') {
    doc['Family Member Status'] = 'conjoint';
  }

  const status = pickString(doc['Family Member Status']);
  const age = typeof (doc as any).age === 'number' ? Number((doc as any).age) : null;
  const isAdult = age != null && Number.isFinite(age) && age >= 18;

  // Validation âge selon la route
  if (mode === 'adult_free' || mode === 'adult_paid') {
    if (!isAdult) throw new HttpError(400, 'Le membre doit être majeur (>= 18 ans) pour cette route.', 'INVALID_AGE_FOR_ROUTE');
  }
  if (mode === 'child') {
    if (isAdult) throw new HttpError(400, 'Le membre doit être mineur (< 18 ans) pour cette route.', 'INVALID_AGE_FOR_ROUTE');
    (doc as any).isChild = true;
  }

  let salePaymeId: string | null = null;

  // Paid adult: one-shot + recompute mensuel (logique identique à la route client)
  if (mode === 'adult_paid' && isAdult && !isConjoint(status)) {
    if (!cardIdFromPayload) {
      throw new HttpError(400, 'payment.cardId requis pour ajouter un membre majeur (paid).', 'CARD_REQUIRED');
    }
    if ((doc as any).livesAtHome !== true) (doc as any).livesAtHome = true;

    const cardSnap = await db.collection('Clients').doc(clientUid).collection('Payment credentials').doc(cardIdFromPayload).get();
    if (!cardSnap.exists) throw new HttpError(404, 'Carte introuvable.', 'CARD_NOT_FOUND');
    const buyerKey = pickString((cardSnap.data() || {})['Isracard Key']);
    if (!buyerKey) throw new HttpError(400, 'Carte invalide: buyerKey PayMe manquant.', 'INVALID_CARD');

    const ponctuallyPriceInCents = nisToCents(pricing.ponctuallyNis);
    if (!ponctuallyPriceInCents || ponctuallyPriceInCents <= 0) {
      throw new HttpError(500, 'Prix activation service invalide (Remote Config).', 'INVALID_PRICING');
    }

    const sale = await paymeGenerateSale({
      priceInCents: ponctuallyPriceInCents,
      description: `Ajout membre famille (admin, majeur) - ${pickString(doc['First Name'])} ${pickString(doc['Last Name'])}`.trim(),
      buyerKey
    });
    salePaymeId = sale.salePaymeId;

    (doc as any).serviceActive = true;
    (doc as any).serviceActivationPaymentId = sale.salePaymeId;
    (doc as any).selectedCardId = cardIdFromPayload;
    (doc as any).serviceActivatedAt = admin.firestore.FieldValue.serverTimestamp();
    (doc as any).billingExempt = false;
  }

  // Free adult / conjoint: pas de sale, pas d'impact mensuel (billingExempt)
  if (mode === 'adult_free') {
    (doc as any).billingExempt = true;
    (doc as any).billingExemptReason = 'admin_free_adult';
    // IMPORTANT: on ne touche PAS à serviceActive ici.
    // Le "service" doit rester cohérent avec les routes client :
    // - /family/members/:id/activate => peut activer service via paiement (majeur non-conjoint)
    // - /family/members/:id/service/activate => gère l'activation du service (conjoint gratuit)
  }
  if (mode === 'conjoint_free') {
    (doc as any).billingExempt = true;
    (doc as any).billingExemptReason = 'admin_free_conjoint';
    // IMPORTANT: idem, on ne touche PAS à serviceActive lors de la création.
  }

  const ref = await db.collection('Clients').doc(clientUid).collection(FAMILY_MEMBERS_COLLECTION).add(stripUndefinedDeep(doc));
  dualWriteFamilyMember(clientUid, ref.id, doc).catch(() => {});

  // Recompute: safe (billingExempt/conjoint/enfant => eligible false)
  const shouldRecompute = !isConjoint(status);
  let monthly: { attempted: boolean; paymeUpdated: boolean; eligibleAdultsCount?: number; targetPriceInCents?: number | null } = {
    attempted: false,
    paymeUpdated: false
  };
  if (shouldRecompute) {
    monthly.attempted = true;
    const result = await recomputeAndApplyFamilyMonthlySupplement(clientUid);
    monthly.paymeUpdated = result.paymeUpdated;
    monthly.eligibleAdultsCount = result.eligibleAdultsCount;
    monthly.targetPriceInCents = result.targetPriceInCents;
  }

  return {
    memberId: ref.id,
    doc,
    billing: {
      mode,
      sale: { attempted: mode === 'adult_paid' && isAdult && !isConjoint(status), salePaymeId },
      monthly
    }
  };
}

function buildAdminCreateResponse(clientUid: string, result: { memberId: string; doc: Record<string, any>; billing: any }) {
  const normalized = normalizeMemberForResponse(result.memberId, result.doc);
  return {
    ok: true,
    clientUid,
    ...normalized,
    pricingImpact: buildPricingImpact(result.billing.monthly),
    billing: result.billing
  };
}

export async function v1AdminCreateFamilyMemberAdultFree(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientUid = pickTargetClientUidFromParams(req);
  const adminUid = req.uid!;
  const result = await adminCreateFamilyMember({ clientUid, adminUid, body: req.body || {}, mode: 'adult_free' });
  res.status(201).json(buildAdminCreateResponse(clientUid, result));
}

export async function v1AdminCreateFamilyMemberAdultPaid(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientUid = pickTargetClientUidFromParams(req);
  const adminUid = req.uid!;
  const result = await adminCreateFamilyMember({ clientUid, adminUid, body: req.body || {}, mode: 'adult_paid' });
  res.status(201).json(buildAdminCreateResponse(clientUid, result));
}

export async function v1AdminCreateFamilyMemberChild(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientUid = pickTargetClientUidFromParams(req);
  const adminUid = req.uid!;
  const result = await adminCreateFamilyMember({ clientUid, adminUid, body: req.body || {}, mode: 'child' });
  res.status(201).json(buildAdminCreateResponse(clientUid, result));
}

export async function v1AdminCreateFamilyMemberConjointFree(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientUid = pickTargetClientUidFromParams(req);
  const adminUid = req.uid!;
  const result = await adminCreateFamilyMember({ clientUid, adminUid, body: req.body || {}, mode: 'conjoint_free' });
  res.status(201).json(buildAdminCreateResponse(clientUid, result));
}

export async function v1AdminDeactivateFamilyMember(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientUid = pickTargetClientUidFromParams(req);
  const memberId = pickString(req.params.id);
  if (!memberId) throw new HttpError(400, 'Id manquant.', 'MISSING_MEMBER_ID');

  const db = getFirestore();
  const ref = db.collection('Clients').doc(clientUid).collection(FAMILY_MEMBERS_COLLECTION).doc(memberId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Membre introuvable.', 'MEMBER_NOT_FOUND');

  await ref.set(
    {
      isActive: false,
      serviceActive: false,
      deactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedByAdminUid: req.uid!,
      updatedByAdminAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
  dualWriteFamilyMember(clientUid, memberId, { isActive: false, serviceActive: false, deactivatedAt: new Date().toISOString() }).catch(() => {});

  const result = await recomputeAndApplyFamilyMonthlySupplement(clientUid);

  // Lire l'état après désactivation
  const afterSnap = await ref.get();
  const afterData = afterSnap.data() || {};
  const normalized = normalizeMemberForResponse(memberId, afterData);

  res.json({
    ok: true,
    clientUid,
    ...normalized,
    pricingImpact: {
      recomputed: true,
      eligibleAdultsCount: result.eligibleAdultsCount,
      targetPriceInCents: result.targetPriceInCents,
      paymeUpdated: result.paymeUpdated
    }
  });
}

async function adminActivateFamilyMember(params: {
  clientUid: string;
  memberId: string;
  adminUid: string;
  body: any;
  mode: 'free' | 'paid';
}): Promise<{ salePaymeId: string | null; attemptedSale: boolean; alreadyActive: boolean }> {
  const { clientUid, memberId, adminUid, body, mode } = params;
  const db = getFirestore();
  const ref = db.collection('Clients').doc(clientUid).collection(FAMILY_MEMBERS_COLLECTION).doc(memberId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Membre introuvable.', 'MEMBER_NOT_FOUND');

  const data = (snap.data() || {}) as Record<string, any>;
  if (data.isActive === true) {
    return { salePaymeId: null, attemptedSale: false, alreadyActive: true };
  }

  // S'assurer que les champs minimaux existent (ou les compléter depuis le payload)
  const ident = ensureRequiredIdentityFields({ existing: data, body });
  const status = pickString(data['Family Member Status']) || ident.status;
  const isAdult = ident.age != null && Number.isFinite(ident.age) && ident.age >= 18;

  const normalized = normalizePayload(body || {});
  const cardIdFromPayload = pickString(
    pickFromMany(
      normalized.payment?.cardId,
      (body as any)?.payment?.cardId,
      (body as any)?.cardId,
      (body as any)?.selectedCardId
    )
  );

  const updates: Record<string, any> = {
    reactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedByAdminUid: adminUid,
    updatedByAdminAt: admin.firestore.FieldValue.serverTimestamp(),
    isActive: true,
    validationStatus: 'validé'
  };

  // Compléter uniquement si manquant
  if (!pickString(data['First Name'])) updates['First Name'] = ident.firstName;
  if (!pickString(data['Family Member Status'])) updates['Family Member Status'] = ident.status;
  if (!pickString(data.Birthday)) updates.Birthday = ident.birthdayStr;
  if (typeof (data as any).age !== 'number' && typeof ident.age === 'number' && Number.isFinite(ident.age)) updates.age = ident.age;

  let salePaymeId: string | null = null;
  let attemptedSale = false;

  if (mode === 'paid') {
    // Paid activation: same rule as client route (adult + non conjoint)
    if (isAdult && !isConjoint(status)) {
      // Sécurité : vérifier que l'abonnement Payme existe et a un prix de base valide
      // AVANT de prélever et d'activer (évite un état incohérent).
      await assertSubscriptionCanSupportFamilySupplement(clientUid);

      attemptedSale = true;
      const cardId = cardIdFromPayload;
      if (!cardId) throw new HttpError(400, 'cardId requis pour activer (paid) un membre majeur.', 'CARD_REQUIRED');

      const cardSnap = await db.collection('Clients').doc(clientUid).collection('Payment credentials').doc(cardId).get();
      if (!cardSnap.exists) throw new HttpError(404, 'Carte introuvable.', 'CARD_NOT_FOUND');
      const buyerKey = pickString((cardSnap.data() || {})['Isracard Key']);
      if (!buyerKey) throw new HttpError(400, 'Carte invalide: buyerKey PayMe manquant.', 'INVALID_CARD');

      const pricing = await getFamilyMemberPricingNis();
      const ponctuallyPriceInCents = nisToCents(pricing.ponctuallyNis);
      if (!ponctuallyPriceInCents || ponctuallyPriceInCents <= 0) {
        throw new HttpError(500, 'Prix activation service invalide (Remote Config).', 'INVALID_PRICING');
      }

      const sale = await paymeGenerateSale({
        priceInCents: ponctuallyPriceInCents,
        description: `Réactivation membre famille (admin, majeur) - ${ident.firstName}`.trim(),
        buyerKey
      });
      salePaymeId = sale.salePaymeId;

      updates.serviceActive = true;
      updates.serviceActivationPaymentId = sale.salePaymeId;
      updates.selectedCardId = cardId;
      updates.serviceActivatedAt = admin.firestore.FieldValue.serverTimestamp();
      updates.billingExempt = false;
      if (data.livesAtHome !== true) updates.livesAtHome = true;
    }
  } else {
    // Free activation: no sale, no monthly impact
    updates.billingExempt = true;
    updates.billingExemptReason = 'admin_free_activation';
    // Traiter le membre comme "adult_paid" côté service : service actif sans paiement
    if (isAdult && !isConjoint(status)) {
      updates.serviceActive = true;
      updates.serviceActivatedAt = admin.firestore.FieldValue.serverTimestamp();
      updates.adult_paid = true; // membre majeur (hors conjoint) considéré comme service activé (gratuit admin)
    }
  }

  await ref.set(stripUndefinedDeep(updates), { merge: true });
  dualWriteFamilyMember(clientUid, memberId, updates).catch(() => {});
  await recomputeAndApplyFamilyMonthlySupplement(clientUid);
  return { salePaymeId, attemptedSale, alreadyActive: false };
}

export async function v1AdminActivateFamilyMemberFree(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientUid = pickTargetClientUidFromParams(req);
  const memberId = pickString(req.params.id);
  if (!memberId) throw new HttpError(400, 'Id manquant.', 'MISSING_MEMBER_ID');
  const result = await adminActivateFamilyMember({
    clientUid,
    memberId,
    adminUid: req.uid!,
    body: req.body || {},
    mode: 'free'
  });
  // Lire le membre après activation pour réponse normalisée
  const db = getFirestore();
  const afterSnap = await db.collection('Clients').doc(clientUid).collection(FAMILY_MEMBERS_COLLECTION).doc(memberId).get();
  const afterData = afterSnap.data() || {};
  const normalized = normalizeMemberForResponse(memberId, afterData);
  res.json({
    ok: true,
    clientUid,
    ...normalized,
    alreadyActive: result.alreadyActive,
    billing: { sale: { attempted: result.attemptedSale, salePaymeId: result.salePaymeId } }
  });
}

// ═══════════════════════════════════════════════════════════════════
// Admin: PATCH édition métier complète d'un membre
// ═══════════════════════════════════════════════════════════════════

export async function v1AdminEditFamilyMember(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientUid = pickTargetClientUidFromParams(req);
  const memberId = pickString(req.params.id);
  if (!memberId) throw new HttpError(400, 'Id membre manquant.', 'MISSING_MEMBER_ID');

  const db = getFirestore();
  const ref = db.collection('Clients').doc(clientUid).collection(FAMILY_MEMBERS_COLLECTION).doc(memberId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Membre introuvable.', 'MEMBER_NOT_FOUND');

  const existing = (snap.data() || {}) as Record<string, any>;
  const updates = buildUpdateDoc({ uid: clientUid, body: req.body || {} });
  const { flags, raw } = normalizePayload(req.body || {});

  // billingExempt via flags ou raw (déjà géré dans buildUpdateDoc, mais on vérifie la raison)
  // Admin metadata
  updates.updatedByAdminUid = req.uid!;
  updates.updatedByAdminAt = admin.firestore.FieldValue.serverTimestamp();

  // ── Règles métier ──────────────────────────────────────────────
  const warnings: string[] = [];

  // Recalculer l'âge si le birthday change
  const birthdayStr = updates.Birthday || existing.Birthday;
  const age = birthdayStr ? computeAgeYearsFromBirthdayString(birthdayStr) : null;
  if (updates.Birthday && age !== null) {
    updates.age = age;
    const oldAge = typeof existing.age === 'number' ? existing.age : null;
    // Transition mineur → majeur
    if (oldAge !== null && oldAge < 18 && age >= 18) {
      warnings.push('Le membre est passé à majeur (>= 18 ans). Vérifier les options de facturation.');
    }
    // Transition majeur → mineur
    if (oldAge !== null && oldAge >= 18 && age < 18) {
      warnings.push("Le membre est passé à mineur (< 18 ans). La facturation adulte ne s'applique plus.");
    }
  }

  // Règles relationship
  const relationship = updates['Family Member Status'] || existing['Family Member Status'];
  const currentAge = age ?? (typeof existing.age === 'number' ? existing.age : null);
  const isAdult = currentAge != null && Number.isFinite(currentAge) && currentAge >= 18;

  if (isConjoint(relationship)) {
    // Conjoint: pas de supplément mensuel
    if (existing.monthlySupplementApplied) {
      warnings.push("Le conjoint n'est pas éligible au supplément mensuel.");
    }
  }

  // Mineur: pas d'activation payante adulte
  if (!isAdult && existing.serviceActive === true && !isConjoint(relationship)) {
    warnings.push('Le membre est mineur mais a un service actif (adulte). Vérifier la cohérence.');
  }

  // États contradictoires
  if (updates.billingExempt === true && existing.serviceActive === true && !isConjoint(relationship)) {
    warnings.push('billingExempt=true avec serviceActive=true: le membre est actif mais exempté de facturation.');
  }

  // Vérification champs significatifs
  const meaningfulKeys = Object.keys(updates).filter(
    (k) => k !== 'updatedAt' && k !== 'updatedByAdminUid' && k !== 'updatedByAdminAt'
  );
  if (meaningfulKeys.length === 0) {
    throw new HttpError(400, 'Aucun champ à modifier.', 'NO_FIELDS_TO_UPDATE');
  }

  await ref.set(stripUndefinedDeep(updates), { merge: true });
  dualWriteFamilyMember(clientUid, memberId, updates).catch(() => {});

  // Recalcul billing si nécessaire
  let pricingImpact: Record<string, any> | null = null;
  if (patchAffectsMonthlySupplement(req.body || {})) {
    const result = await recomputeAndApplyFamilyMonthlySupplement(clientUid);
    pricingImpact = {
      recomputed: true,
      eligibleAdultsCount: result.eligibleAdultsCount,
      targetPriceInCents: result.targetPriceInCents,
      paymeUpdated: result.paymeUpdated
    };
  }

  const afterSnap = await ref.get();
  const afterData = afterSnap.data() || {};
  const normalized = normalizeMemberForResponse(memberId, afterData);

  res.json({
    ok: true,
    clientUid,
    ...normalized,
    pricingImpact,
    warnings: warnings.length > 0 ? warnings : undefined
  });
}

// ═══════════════════════════════════════════════════════════════════
// Admin: DELETE suppression d'un membre (avec protection membre actif)
// ═══════════════════════════════════════════════════════════════════

export async function v1AdminDeleteFamilyMember(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientUid = pickTargetClientUidFromParams(req);
  const memberId = pickString(req.params.id);
  if (!memberId) throw new HttpError(400, 'Id membre manquant.', 'MISSING_MEMBER_ID');

  // Sécurité: ne jamais supprimer le titulaire
  if (memberId === 'account_owner') {
    throw new HttpError(400, 'Impossible de supprimer le titulaire du compte.', 'CANNOT_DELETE_ACCOUNT_OWNER');
  }

  const db = getFirestore();
  const ref = db.collection('Clients').doc(clientUid).collection(FAMILY_MEMBERS_COLLECTION).doc(memberId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Membre introuvable.', 'MEMBER_NOT_FOUND');

  const data = (snap.data() || {}) as Record<string, any>;

  // Refuser la suppression d'un membre avec service actif
  // sauf si force=true est explicitement fourni
  const force = pickBool(req.body?.force, false);
  if (data.isActive === true && data.serviceActive === true && !force) {
    throw new HttpError(
      400,
      "Impossible de supprimer un membre avec un service actif. Désactivez-le d'abord ou utilisez force=true.",
      'MEMBER_ACTIVE_CANNOT_DELETE'
    );
  }
  if (data.isActive === true && !force) {
    throw new HttpError(
      400,
      "Le membre est encore actif. Désactivez-le d'abord ou utilisez force=true.",
      'MEMBER_ACTIVE_CANNOT_DELETE'
    );
  }

  // Capturer l'état avant suppression pour la réponse
  const memberSnapshot = normalizeMemberForResponse(memberId, data);

  await ref.delete();
  dualWriteDelete('family_members', 'firestore_id', memberId).catch(() => {});

  // Recalculer le supplément (cumulable) si ce membre contribuait
  await recomputeAndApplyFamilyMonthlySupplement(clientUid);

  res.json({
    ok: true,
    clientUid,
    memberId,
    deleted: true,
    deletedMember: memberSnapshot.member,
    deletedByAdminUid: req.uid!
  });
}

export async function v1AdminActivateFamilyMemberPaid(req: AuthenticatedRequest, res: Response): Promise<void> {
  const clientUid = pickTargetClientUidFromParams(req);
  const memberId = pickString(req.params.id);
  if (!memberId) throw new HttpError(400, 'Id manquant.', 'MISSING_MEMBER_ID');
  const result = await adminActivateFamilyMember({
    clientUid,
    memberId,
    adminUid: req.uid!,
    body: req.body || {},
    mode: 'paid'
  });
  // Lire le membre après activation pour réponse normalisée
  const db = getFirestore();
  const afterSnap = await db.collection('Clients').doc(clientUid).collection(FAMILY_MEMBERS_COLLECTION).doc(memberId).get();
  const afterData = afterSnap.data() || {};
  const normalized = normalizeMemberForResponse(memberId, afterData);
  res.json({
    ok: true,
    clientUid,
    ...normalized,
    alreadyActive: result.alreadyActive,
    billing: { sale: { attempted: result.attemptedSale, salePaymeId: result.salePaymeId } }
  });
}


