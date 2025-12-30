import type { Response } from 'express';
import crypto from 'crypto';
import { getAuth, getFirestore } from '../config/firebase.js';
import type { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { HttpError } from '../utils/errors.js';
import { tryCreateSecurdenFolderAndCard } from '../services/securden.service.js';
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

  const firstName = pickString(cd.firstName);
  const lastName = pickString(cd.lastName);
  const birthday = pickString(cd.birthday);
  const phone = coercePhoneField(cd.phoneNumber);

  const planRaw = cd.plan;
  const plan = typeof planRaw === 'number' || typeof planRaw === 'string' ? String(planRaw) : undefined;
  const subCodeRaw = cd.subCode;
  const subCode = typeof subCodeRaw === 'number' || typeof subCodeRaw === 'string' ? String(subCodeRaw) : undefined;

  const isFreeClient = cd.isFreeClient === true;

  const doc: Record<string, any> = {
    uid: params.uid,
    Email: params.email,
    'First Name': firstName || undefined,
    'Last Name': lastName || undefined,
    ...(phone ? { 'Phone Number': phone } : {}),
    ...(birthday ? { birthday, Birthday: birthday } : {}),
    registrationComplete: true,
    registrationCompletedAt: new Date(),
    createdVia: 'api/clients',
    createdAt: new Date(),
    language: 'fr',
    isFreeClient
  };

  // Champs "métier" (compat / recherche)
  const teoudatZeout = pickString(cd.teoudatZeout);
  const fatherName = pickString(cd.fatherName);
  const koupatHolim = pickString(cd.koupatHolim);
  const civility = pickString(cd.civility);
  const membershipType = pickString(cd.membershipType);

  if (teoudatZeout) doc['Teoudat Zeout'] = teoudatZeout;
  if (fatherName) doc['Father Name'] = fatherName;
  if (koupatHolim) doc['Koupat Holim'] = koupatHolim;
  if (civility) doc.Civility = civility;
  if (membershipType) {
    doc.membershipType = membershipType;
    // Legacy key parfois utilisé
    doc.Membership = membershipType;
  }
  if (plan) doc['Membership Plan'] = plan;
  if (subCode) doc['IsraCard Sub Code'] = subCode;

  // PayMe (si fourni par le flow de paiement)
  const buyerKey = pickString(cd.buyerKey);
  const buyerCard = pickString(cd.buyerCard);
  const paymeSubId = pickString(cd.paymeSubID || cd.subID);
  const paymeSubCode = cd.paymeSubCode ?? cd.subCodePayme ?? cd.subCode;
  if (buyerKey) doc['Isracard Key'] = buyerKey;
  if (buyerCard) doc['Card Number'] = buyerCard; // attendu: "****1234"
  if (paymeSubId) doc['IsraCard Sub ID'] = paymeSubId;
  if (typeof paymeSubCode === 'number' || typeof paymeSubCode === 'string') doc['IsraCard Sub Code'] = String(paymeSubCode);

  // Payloads bruts (sans champs carte), pour ne pas perdre d'info côté back-office
  const membershipData = coerceObject(cd.membershipData);
  const subscriptionData = coerceObject(cd.subscriptionData);
  if (membershipData) doc.membershipData = membershipData;
  if (subscriptionData) doc.subscriptionData = subscriptionData;

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
  if (isPayingClient) {
    try {
      const plan = Number(clientData.plan || 0);
      if (![3, 4].includes(plan)) throw new HttpError(400, 'Plan invalide (PayMe).');

      const cardNumberRaw = (body.clientData as any)?.cardNumber;
      const expRaw = (body.clientData as any)?.expirationDate;
      const cvvRaw = (body.clientData as any)?.cvv;

      if (!pickString(cardNumberRaw) || !pickString(expRaw) || !pickString(cvvRaw)) {
        throw new HttpError(400, 'Carte requise (cardNumber/expirationDate/cvv) pour un client payant.');
      }

      // Prix (centimes) - fallback sur valeurs connues si non fourni
      const priceFromPayload = Number((clientData as any).membershipPrice || 0);
      const priceInCents = Number.isFinite(priceFromPayload) && priceFromPayload > 0 ? priceFromPayload : plan === 4 ? 249000 : 24900;
      const membershipType = pickString(clientData.membershipType) || 'Pack Start';
      const fullName = `${firstName} ${lastName}`.trim();
      const cardHolder = pickString((clientData as any).cardHolder) || fullName;

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

      if (plan === 4) {
        // Annuel: sale unique (installments optionnel)
        const installments = Number((clientData as any).selectedInstallments || 0);
        await paymeGenerateSale({
          priceInCents,
          description: membershipType,
          buyerKey: buyerToken.buyerKey,
          installments: Number.isFinite(installments) ? installments : undefined
        });
        subCode = null;
        subID = null;
      } else {
        // Mensuel: sale immédiat + subscription future (J+1 mois)
        await paymeGenerateSale({
          priceInCents,
          description: `${membershipType} - Premier mois`,
          buyerKey: buyerToken.buyerKey
        });

        const startDateDdMmYyyy = calculateSubscriptionStartDate(3);
        const sub = await paymeGenerateSubscription({
          priceInCents,
          description: membershipType,
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

    // Addresses (si présent)
    const addressFields = {
      address: pickString(clientData.address),
      additionalAddress: pickString(clientData.additionalAddress),
      appartment: pickString(clientData.appartment),
      etage: pickString(clientData.etage)
    };
    const hasAddress = Object.values(addressFields).some(Boolean);
    if (hasAddress) {
      batch.set(clientRef.collection('Addresses').doc('primary'), { ...addressFields, createdAt: new Date() }, { merge: true });
    }

    // Family Members (si présent)
    const familyFields = {
      firstName: pickString(clientData.familyFirstName),
      lastName: pickString(clientData.familyLastName),
      birthday: pickString(clientData.familyBirthday),
      koupatHolim: pickString(clientData.familyKoupatHolim),
      email: pickString(clientData.familyEmail),
      phoneNumber: clientData.familyPhoneNumber
    };
    const hasFamily = Boolean(familyFields.firstName || familyFields.lastName || familyFields.email || familyFields.birthday);
    if (hasFamily) {
      batch.set(clientRef.collection('Family Members').doc('primary'), { ...familyFields, createdAt: new Date() }, { merge: true });
    }

    // Payment credentials (si payant) - sans carte
    const paymentRef = clientRef.collection('Payment credentials').doc('securden');
    if (isPayingClient) {
      batch.set(
        paymentRef,
        {
          provider: 'securden',
          status: 'pending',
          hasCard: Boolean(pickString((body.clientData as any)?.cardNumber)),
          // PayMe (jamais la carte, jamais le cvv/exp)
          payme: payme
            ? { buyerCard: payme.buyerCard, subCode: payme.subCode ?? null, subID: payme.subID ?? null, updatedAt: new Date() }
            : { updatedAt: new Date() },
          createdAt: new Date()
        },
        { merge: true }
      );
    }

    // subscription/current
    const subscriptionData = coerceObject((body.clientData as any)?.subscriptionData);
    if (subscriptionData) {
      batch.set(
        clientRef.collection('subscription').doc('current'),
        { ...subscriptionData, updatedAt: new Date(), createdAt: new Date() },
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
      await paymentRef
        .set(
          {
            provider: 'securden',
            folderId: securden.folderId || null,
            accountId: securden.accountId || null,
            warnings: securden.warnings,
            updatedAt: new Date()
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


