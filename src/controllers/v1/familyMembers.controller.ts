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

function buildMemberFirestoreDoc(params: { uid: string; body: any; defaults?: Record<string, any> }): Record<string, any> {
  const { uid, body } = params;

  const firstName = pickString(getLegacyKey(body, 'First Name', 'firstName'));
  if (!firstName) throw new HttpError(400, 'First Name requis.');

  const familyMemberStatus = pickString(getLegacyKey(body, 'Family Member Status', 'familyMemberStatus'));
  if (!familyMemberStatus) throw new HttpError(400, 'Family Member Status requis.');

  const birthdayRaw = getLegacyKey(body, 'Birthday', 'birthday');
  const birthdayTs = birthdayToTimestamp(birthdayRaw);
  if (birthdayRaw != null && !birthdayTs) {
    throw new HttpError(400, 'Birthday invalide (attendu Timestamp ou "dd/MM/yyyy").');
  }

  const phoneNumber = pickStringOrNull(getLegacyKey(body, 'Phone Number', 'phoneNumber'));
  const phoneNumbers = coerceStringList(getLegacyKey(body, 'phoneNumbers', 'phoneNumbers'));

  const doc: Record<string, any> = {
    // Champs legacy (exact)
    'First Name': firstName,
    'Last Name': pickStringOrNull(getLegacyKey(body, 'Last Name', 'lastName')),
    'Father Name': pickStringOrNull(getLegacyKey(body, 'Father Name', 'fatherName')),
    Email: pickStringOrNull(getLegacyKey(body, 'Email', 'email')),
    'Phone Number': phoneNumber,
    phoneNumbers: phoneNumbers,
    'Teoudat Zeout': pickStringOrNull(getLegacyKey(body, 'Teoudat Zeout', 'teoudatZeout')),
    ...(birthdayTs ? { Birthday: birthdayTs } : {}),
    'Koupat Holim': pickStringOrNull(getLegacyKey(body, 'Koupat Holim', 'koupatHolim')),
    'Family Member Status': familyMemberStatus,
    hasGOVacces: pickBool(getLegacyKey(body, 'hasGOVacces', 'hasGOVacces'), false),
    isConnected: pickBool(getLegacyKey(body, 'isConnected', 'isConnected'), false),
    'Client ID': uid,
    'Created From': pickStringOrNull(getLegacyKey(body, 'Created From', 'createdFrom')) ?? 'Application',

    // Nouveaux champs (flat, non cassants)
    isAccountOwner: pickBool(getLegacyKey(body, 'isAccountOwner', 'isAccountOwner'), false),
    isChild: getLegacyKey(body, 'isChild', 'isChild') === undefined ? undefined : pickBool(getLegacyKey(body, 'isChild', 'isChild'), false),
    isActive: pickBool(getLegacyKey(body, 'isActive', 'isActive'), true),
    livesAtHome: pickBool(getLegacyKey(body, 'livesAtHome', 'livesAtHome'), false),
    validationStatus: pickStringOrNull(getLegacyKey(body, 'validationStatus', 'validationStatus')) ?? 'en_attente',
    serviceActive: pickBool(getLegacyKey(body, 'serviceActive', 'serviceActive'), false),
    selectedCardId: pickStringOrNull(getLegacyKey(body, 'selectedCardId', 'selectedCardId')),
    serviceActivatedAt: getLegacyKey(body, 'serviceActivatedAt', 'serviceActivatedAt') ?? null,
    serviceActivationPaymentId: pickStringOrNull(getLegacyKey(body, 'serviceActivationPaymentId', 'serviceActivationPaymentId')),
    monthlySupplementApplied: pickBool(getLegacyKey(body, 'monthlySupplementApplied', 'monthlySupplementApplied'), false),
    monthlySupplementNis:
      typeof getLegacyKey(body, 'monthlySupplementNis', 'monthlySupplementNis') === 'number'
        ? (getLegacyKey(body, 'monthlySupplementNis', 'monthlySupplementNis') as number)
        : 69
  };

  return { ...(params.defaults || {}), ...doc };
}

function buildUpdateDoc(params: { uid: string; body: any }): Record<string, any> {
  const { uid, body } = params;
  const updates: Record<string, any> = {};

  const maybe = (legacyKey: string, camelKey?: string) => getLegacyKey(body, legacyKey, camelKey);

  if (maybe('First Name', 'firstName') !== undefined) updates['First Name'] = pickString(maybe('First Name', 'firstName'));
  if (maybe('Last Name', 'lastName') !== undefined) updates['Last Name'] = pickStringOrNull(maybe('Last Name', 'lastName'));
  if (maybe('Father Name', 'fatherName') !== undefined) updates['Father Name'] = pickStringOrNull(maybe('Father Name', 'fatherName'));
  if (maybe('Email', 'email') !== undefined) updates.Email = pickStringOrNull(maybe('Email', 'email'));

  if (maybe('Phone Number', 'phoneNumber') !== undefined) updates['Phone Number'] = pickStringOrNull(maybe('Phone Number', 'phoneNumber'));
  if (maybe('phoneNumbers', 'phoneNumbers') !== undefined) updates.phoneNumbers = coerceStringList(maybe('phoneNumbers', 'phoneNumbers'));

  if (maybe('Teoudat Zeout', 'teoudatZeout') !== undefined) updates['Teoudat Zeout'] = pickStringOrNull(maybe('Teoudat Zeout', 'teoudatZeout'));
  if (maybe('Koupat Holim', 'koupatHolim') !== undefined) updates['Koupat Holim'] = pickStringOrNull(maybe('Koupat Holim', 'koupatHolim'));
  if (maybe('Family Member Status', 'familyMemberStatus') !== undefined)
    updates['Family Member Status'] = pickString(maybe('Family Member Status', 'familyMemberStatus'));

  if (maybe('Birthday', 'birthday') !== undefined) {
    const birthdayTs = birthdayToTimestamp(maybe('Birthday', 'birthday'));
    if (!birthdayTs) throw new HttpError(400, 'Birthday invalide (attendu Timestamp ou "dd/MM/yyyy").');
    updates.Birthday = birthdayTs;
  }

  if (maybe('hasGOVacces', 'hasGOVacces') !== undefined) updates.hasGOVacces = pickBool(maybe('hasGOVacces', 'hasGOVacces'), false);
  if (maybe('isConnected', 'isConnected') !== undefined) updates.isConnected = pickBool(maybe('isConnected', 'isConnected'), false);

  // Nouveaux champs
  if (maybe('isAccountOwner', 'isAccountOwner') !== undefined) updates.isAccountOwner = pickBool(maybe('isAccountOwner', 'isAccountOwner'), false);
  if (maybe('isChild', 'isChild') !== undefined) updates.isChild = pickBool(maybe('isChild', 'isChild'), false);
  if (maybe('isActive', 'isActive') !== undefined) updates.isActive = pickBool(maybe('isActive', 'isActive'), true);
  if (maybe('livesAtHome', 'livesAtHome') !== undefined) updates.livesAtHome = pickBool(maybe('livesAtHome', 'livesAtHome'), false);
  if (maybe('validationStatus', 'validationStatus') !== undefined) updates.validationStatus = pickStringOrNull(maybe('validationStatus', 'validationStatus'));

  // Champs système
  updates['Client ID'] = uid;
  updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

  return updates;
}

function patchAffectsMonthlySupplement(body: any): boolean {
  const keys = new Set(Object.keys(body || {}));
  return (
    keys.has('Birthday') ||
    keys.has('birthday') ||
    keys.has('Family Member Status') ||
    keys.has('familyMemberStatus') ||
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


