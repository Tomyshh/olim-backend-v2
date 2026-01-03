import type { Response } from 'express';
import { admin, getFirestore } from '../../config/firebase.js';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import { HttpError } from '../../utils/errors.js';
import { paymeGenerateSale } from '../../services/payme.service.js';
import { isConjoint, recomputeAndApplyFamilyMonthlySupplement } from '../../services/familyBilling.service.js';
import { getFamilyMemberPricingNis, nisToCents } from '../../services/remoteConfigPricing.service.js';

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
  if (!firstName) throw new HttpError(400, 'First Name requis.');

  const familyMemberStatus = pickString(
    pickFromMany(
      member.relationship,
      getLegacyKey(raw, 'Family Member Status'),
      getLegacyKey(raw, 'Status'),
      getLegacyKey(raw, 'relationship', 'relationship'),
      getLegacyKey(raw, 'familyMemberStatus', 'familyMemberStatus')
    )
  );
  if (!familyMemberStatus) throw new HttpError(400, 'Family Member Status requis.');

  // Requis côté storage: string "dd/MM/yyyy" (JJ/MM/YYYY)
  const birthdayRaw = pickFromMany(member.birthday, getLegacyKey(raw, 'Birthday', 'birthday'));
  const birthdayStr = birthdayRaw == null ? null : parseBirthdayToDdMmYyyy(birthdayRaw);
  // Birthday requis (car on doit calculer age et la facturation dépend de l'âge)
  if (birthdayRaw == null) {
    throw new HttpError(400, 'Birthday requis (format "dd/MM/yyyy").');
  }
  if (!birthdayStr) {
    throw new HttpError(400, 'Birthday invalide (attendu "dd/MM/yyyy").');
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
    if (!birthdayStr) throw new HttpError(400, 'Birthday invalide (attendu "dd/MM/yyyy").');
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
    keys.has('livesAtHome')
  );
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
      throw new HttpError(400, 'payment.cardId requis pour ajouter un membre majeur.');
    }
    // Par défaut, un membre majeur ajouté est considéré "au foyer" si le frontend n'a pas explicitement fourni le flag.
    // Sans livesAtHome=true, le supplément mensuel ne peut pas être appliqué.
    if ((doc as any).livesAtHome !== true) {
      (doc as any).livesAtHome = true;
    }

    // Récupérer buyerKey depuis Payment credentials/{cardId}
    const cardSnap = await db.collection('Clients').doc(uid).collection('Payment credentials').doc(cardIdFromPayload).get();
    if (!cardSnap.exists) throw new HttpError(404, 'Carte introuvable.');
    const buyerKey = pickString((cardSnap.data() || {})['Isracard Key']);
    if (!buyerKey) throw new HttpError(400, 'Carte invalide: buyerKey PayMe manquant.');

    const ponctuallyPriceInCents = nisToCents(pricing.ponctuallyNis);
    if (!ponctuallyPriceInCents || ponctuallyPriceInCents <= 0) {
      throw new HttpError(500, 'Prix activation service invalide (Remote Config).');
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

  // Appliquer supplément uniquement si le nouveau membre peut l'impacter
  const shouldRecompute =
    doc.isActive === true && doc.livesAtHome === true && !isConjoint(status) && doc.Birthday != null;

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
  if (!memberId) throw new HttpError(400, 'Id manquant.');

  const db = getFirestore();
  const ref = db.collection('Clients').doc(uid).collection(FAMILY_MEMBERS_COLLECTION).doc(memberId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Membre introuvable.');

  const updates = buildUpdateDoc({ uid, body: req.body || {} });
  // Si rien à mettre à jour (à part updatedAt), on évite un faux-positif
  const meaningfulKeys = Object.keys(updates).filter((k) => k !== 'updatedAt');
  if (meaningfulKeys.length === 0) {
    throw new HttpError(400, 'Aucun champ à modifier.');
  }
  await ref.set(stripUndefinedDeep(updates), { merge: true });

  if (patchAffectsMonthlySupplement(req.body || {})) {
    await recomputeAndApplyFamilyMonthlySupplement(uid);
  }

  const after = await ref.get();
  res.json({ ok: true, memberId, member: { memberId, ...(after.data() || {}) } });
}

export async function v1DeactivateFamilyMember(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid!;
  const memberId = pickString(req.params.id);
  if (!memberId) throw new HttpError(400, 'Id manquant.');

  const db = getFirestore();
  const ref = db.collection('Clients').doc(uid).collection(FAMILY_MEMBERS_COLLECTION).doc(memberId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Membre introuvable.');

  await ref.set(
    {
      isActive: false,
      deactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  await recomputeAndApplyFamilyMonthlySupplement(uid);
  res.json({ ok: true, memberId });
}

export async function v1ActivateFamilyMember(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid!;
  const memberId = pickString(req.params.id);
  if (!memberId) throw new HttpError(400, 'Id manquant.');

  const db = getFirestore();
  const ref = db.collection('Clients').doc(uid).collection(FAMILY_MEMBERS_COLLECTION).doc(memberId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Membre introuvable.');

  await ref.set(
    {
      isActive: true,
      reactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  await recomputeAndApplyFamilyMonthlySupplement(uid);
  res.json({ ok: true, memberId });
}

export async function v1ActivateFamilyMemberService(req: AuthenticatedRequest, res: Response): Promise<void> {
  const uid = req.uid!;
  const memberId = pickString(req.params.id);
  if (!memberId) throw new HttpError(400, 'Id manquant.');

  const cardId = pickString(req.body?.payment?.cardId ?? req.body?.cardId ?? req.body?.selectedCardId);
  if (!cardId) throw new HttpError(400, 'cardId requis.');

  const db = getFirestore();
  const memberRef = db.collection('Clients').doc(uid).collection(FAMILY_MEMBERS_COLLECTION).doc(memberId);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) throw new HttpError(404, 'Membre introuvable.');

  const memberData = (memberSnap.data() || {}) as Record<string, any>;
  const status = pickString(memberData['Family Member Status']);

  // Idempotence: si déjà actif, on répond OK
  if (memberData.serviceActive === true) {
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
    await memberRef.set(
      {
        serviceActive: true,
        serviceActivationPaymentId: null,
        selectedCardId: cardId,
        serviceActivatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    res.json({ ok: true, memberId, serviceActive: true, serviceActivationPaymentId: null });
    return;
  }

  // Récupérer buyerKey depuis Payment credentials/{cardId}
  const cardSnap = await db.collection('Clients').doc(uid).collection('Payment credentials').doc(cardId).get();
  if (!cardSnap.exists) throw new HttpError(404, 'Carte introuvable.');
  const buyerKey = pickString((cardSnap.data() || {})['Isracard Key']);
  if (!buyerKey) throw new HttpError(400, 'Carte invalide: buyerKey PayMe manquant.');

  // Débit one-shot (Remote Config: add_family_member_ponctually en NIS)
  const pricing = await getFamilyMemberPricingNis();
  const ponctuallyPriceInCents = nisToCents(pricing.ponctuallyNis);
  if (!ponctuallyPriceInCents || ponctuallyPriceInCents <= 0) {
    throw new HttpError(500, 'Prix activation service invalide (Remote Config).');
  }

  const sale = await paymeGenerateSale({
    priceInCents: ponctuallyPriceInCents,
    description: `Activation service - Family Member ${memberId}`,
    buyerKey
  });

  await memberRef.set(
    {
      serviceActive: true,
      serviceActivationPaymentId: sale.salePaymeId,
      selectedCardId: cardId,
      serviceActivatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  res.json({ ok: true, memberId, serviceActive: true, serviceActivationPaymentId: sale.salePaymeId });
}


