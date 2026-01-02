import type { Response } from 'express';
import { admin, getFirestore } from '../../config/firebase.js';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware.js';
import { HttpError } from '../../utils/errors.js';
import { paymeGenerateSale } from '../../services/payme.service.js';
import { birthdayToTimestamp, isConjoint, recomputeAndApplyFamilyMonthlySupplement } from '../../services/familyBilling.service.js';

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
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickFromMany(...values: unknown[]): unknown {
  for (const v of values) {
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function normalizePayload(body: any): { member: Record<string, any>; flags: Record<string, any>; payment: Record<string, any>; raw: any } {
  const member = isPlainObject(body?.member) ? body.member : {};
  const flags = isPlainObject(body?.flags) ? body.flags : {};
  const payment = isPlainObject(body?.payment) ? body.payment : {};
  return { member, flags, payment, raw: body };
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

  const birthdayRaw = pickFromMany(member.birthday, getLegacyKey(raw, 'Birthday', 'birthday'));
  const birthdayTs = birthdayToTimestamp(birthdayRaw);
  if (birthdayRaw != null && !birthdayTs) {
    throw new HttpError(400, 'Birthday invalide (attendu Timestamp ou "dd/MM/yyyy").');
  }

  const phoneNumbers = coerceStringList(pickFromMany(member.phoneNumbers, getLegacyKey(raw, 'phoneNumbers', 'phoneNumbers')));
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
    ...(birthdayTs ? { Birthday: birthdayTs } : {}),
    'Koupat Holim': pickStringOrNull(pickFromMany(member.koupatHolim, getLegacyKey(raw, 'Koupat Holim', 'koupatHolim'))),
    'Family Member Status': familyMemberStatus,
    hasGOVacces: pickBool(pickFromMany(raw?.hasGOVacces, raw?.hasGOVacces), false),
    isConnected: pickBool(pickFromMany(raw?.isConnected, raw?.isConnected), false),
    'Client ID': uid,
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

  return { ...(params.defaults || {}), ...doc };
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

  if (member.phoneNumbers !== undefined || member.phoneNumber !== undefined || maybe('phoneNumbers', 'phoneNumbers') !== undefined || maybe('Phone Number', 'phoneNumber') !== undefined) {
    const phoneNumbers = coerceStringList(pickFromMany(member.phoneNumbers, maybe('phoneNumbers', 'phoneNumbers')));
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
    const birthdayTs = birthdayToTimestamp(pickFromMany(member.birthday, maybe('Birthday', 'birthday')));
    if (!birthdayTs) throw new HttpError(400, 'Birthday invalide (attendu Timestamp ou "dd/MM/yyyy").');
    updates.Birthday = birthdayTs;
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
  updates['Client ID'] = uid;
  updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

  return updates;
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

  const doc = buildMemberFirestoreDoc({
    uid,
    body: req.body || {},
    defaults: {
      isActive: true,
      serviceActive: false,
      monthlySupplementApplied: false,
      monthlySupplementNis: 69,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }
  });

  const ref = await db.collection('Clients').doc(uid).collection(FAMILY_MEMBERS_COLLECTION).add(doc);

  // Appliquer supplément uniquement si le nouveau membre peut l'impacter
  const status = pickString(doc['Family Member Status']);
  const shouldRecompute =
    doc.isActive === true && doc.livesAtHome === true && !isConjoint(status) && doc.Birthday != null;

  if (shouldRecompute) {
    await recomputeAndApplyFamilyMonthlySupplement(uid);
  }

  res.status(201).json({ memberId: ref.id, ...doc });
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
  await ref.set(updates, { merge: true });

  if (patchAffectsMonthlySupplement(req.body || {})) {
    await recomputeAndApplyFamilyMonthlySupplement(uid);
  }

  res.json({ ok: true, memberId });
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

  const cardId = pickString(req.body?.cardId ?? req.body?.selectedCardId);
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

  // Débit one-shot 39₪
  const sale = await paymeGenerateSale({
    priceInCents: 3900,
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


