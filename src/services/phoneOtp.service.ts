import { getAuth, getFirestore, admin } from '../config/firebase.js';
import { normalizeE164PhoneNumber } from '../utils/phone.js';
import { consumeRateLimit } from './rateLimit.service.js';
import { generateOtpCode6, otpCodeHash, requireOtpSecret, timingSafeEqualHex } from './otpCrypto.service.js';
import { sendOtpViaTwilio } from './twilio.service.js';

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 3;
const LOGIN_SEND_LIMIT = 3;
const LOGIN_SEND_WINDOW_SECONDS = 10 * 60;

type Channels = Array<'sms' | 'whatsapp'>;

function nowMs(): number {
  return Date.now();
}

function sanitizeChannels(input: unknown): Channels {
  const arr = Array.isArray(input) ? input : [];
  const set = new Set<'sms' | 'whatsapp'>();
  for (const v of arr) {
    if (v === 'sms' || v === 'whatsapp') set.add(v);
  }
  // défaut: sms
  return set.size ? Array.from(set) : ['sms'];
}

export async function sendLoginOtp(params: {
  phoneNumber: unknown;
  languageCode?: unknown;
  channels?: unknown;
  ipKey?: string; // pour rate-limit IP optionnel
}): Promise<void> {
  const norm = normalizeE164PhoneNumber(params.phoneNumber);
  if (!norm.ok) {
    const err: any = new Error(norm.message);
    err.status = 400;
    throw err;
  }

  const languageCode = typeof params.languageCode === 'string' ? params.languageCode : 'fr';
  const channels = sanitizeChannels(params.channels);
  const secret = requireOtpSecret();

  // Rate-limit (phone): 3 / 10min
  const rlPhone = await consumeRateLimit({
    key: `otp:send:login:phone:${norm.digitsOnly}`,
    limit: LOGIN_SEND_LIMIT,
    windowSeconds: LOGIN_SEND_WINDOW_SECONDS
  });
  if (!rlPhone.allowed) {
    const err: any = new Error('Trop de demandes. Veuillez attendre 10 minutes.');
    err.status = 429;
    throw err;
  }

  // Rate-limit (ip) léger (optionnel)
  if (params.ipKey) {
    const rlIp = await consumeRateLimit({
      key: `otp:send:login:ip:${params.ipKey}`,
      limit: 30,
      windowSeconds: 10 * 60
    });
    if (!rlIp.allowed) {
      const err: any = new Error('Trop de demandes. Veuillez attendre 10 minutes.');
      err.status = 429;
      throw err;
    }
  }

  const code = generateOtpCode6();
  const codeHash = otpCodeHash(secret, norm.e164, code);
  const expiresAt = nowMs() + OTP_TTL_MS;

  const db = getFirestore();
  const docRef = db.collection('PhoneOtpLogin').doc(norm.digitsOnly);

  // Stocker avant l’envoi pour durcir contre l’abus (même si l’envoi Twilio échoue, on a consommé le quota)
  await docRef.set(
    {
      phoneNumber: norm.e164,
      codeHash,
      expiresAt,
      attempts: 0,
      requestCount: admin.firestore.FieldValue.increment(1),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  await sendOtpViaTwilio({ phoneNumberE164: norm.e164, languageCode, channels, code });
}

export async function verifyLoginOtp(params: {
  phoneNumber: unknown;
  code: unknown;
  ipKey?: string;
}): Promise<{ customToken: string; isNewUser: boolean; uid: string; phoneNumberE164: string }> {
  const norm = normalizeE164PhoneNumber(params.phoneNumber);
  if (!norm.ok) {
    const err: any = new Error(norm.message);
    err.status = 400;
    throw err;
  }
  const code = typeof params.code === 'string' ? params.code.trim() : '';
  if (!/^\d{6}$/.test(code)) {
    const err: any = new Error('Code invalide.');
    err.status = 400;
    throw err;
  }

  if (params.ipKey) {
    const rlIp = await consumeRateLimit({
      key: `otp:verify:login:ip:${params.ipKey}`,
      limit: 60,
      windowSeconds: 10 * 60
    });
    if (!rlIp.allowed) {
      const err: any = new Error('Trop de demandes. Veuillez attendre 10 minutes.');
      err.status = 429;
      throw err;
    }
  }

  const db = getFirestore();
  const docRef = db.collection('PhoneOtpLogin').doc(norm.digitsOnly);
  const snap = await docRef.get();
  if (!snap.exists) {
    const err: any = new Error('Code invalide.');
    err.status = 400;
    throw err;
  }

  const data = snap.data() as any;
  const expiresAt = Number(data.expiresAt || 0);
  const attempts = Number(data.attempts || 0);
  const storedHash = String(data.codeHash || '');
  if (!expiresAt || nowMs() > expiresAt) {
    const err: any = new Error('Code expiré.');
    err.status = 410;
    throw err;
  }
  if (attempts >= OTP_MAX_ATTEMPTS) {
    const err: any = new Error('Code invalide.');
    err.status = 400;
    throw err;
  }

  const secret = requireOtpSecret();
  const computed = otpCodeHash(secret, norm.e164, code);
  const ok = timingSafeEqualHex(storedHash, computed);

  if (!ok) {
    await docRef.set({ attempts: admin.firestore.FieldValue.increment(1) }, { merge: true });
    const err: any = new Error('Code invalide.');
    err.status = 400;
    throw err;
  }

  // OTP consommé: on supprime pour éviter réutilisation
  await docRef.delete().catch(() => {});

  const auth = getAuth();

  let uid: string;
  let isNewUser = false;
  try {
    const existing = await auth.getUserByPhoneNumber(norm.e164);
    uid = existing.uid;
  } catch (e: any) {
    // Firebase Admin: auth/user-not-found
    const created = await auth.createUser({ phoneNumber: norm.e164 });
    uid = created.uid;
    isNewUser = true;
  }

  // S’assurer qu’un doc Clients existe (minimal, non destructif)
  const clientRef = db.collection('Clients').doc(uid);
  const clientSnap = await clientRef.get();
  if (!clientSnap.exists) {
    await clientRef.set(
      {
        uid,
        'Phone Number': norm.e164,
        phoneVerified: true,
        verifiedPhoneNumber: norm.e164,
        phoneVerifiedAt: new Date(),
        createdVia: 'phoneOtp',
        createdAt: new Date(),
        registrationComplete: false
      },
      { merge: true }
    );
  } else {
    // si doc existant, on peut juste marquer le téléphone comme vérifié
    await clientRef.set(
      {
        'Phone Number': norm.e164,
        phoneVerified: true,
        verifiedPhoneNumber: norm.e164,
        phoneVerifiedAt: new Date()
      },
      { merge: true }
    );
  }

  const customToken = await auth.createCustomToken(uid, { phoneNumber: norm.e164 });
  return { customToken, isNewUser, uid, phoneNumberE164: norm.e164 };
}

export async function sendLinkPhoneOtp(params: {
  uid: string;
  phoneNumber: unknown;
  languageCode?: unknown;
  channels?: unknown;
  ipKey?: string;
}): Promise<void> {
  const norm = normalizeE164PhoneNumber(params.phoneNumber);
  if (!norm.ok) {
    const err: any = new Error(norm.message);
    err.status = 400;
    throw err;
  }

  const languageCode = typeof params.languageCode === 'string' ? params.languageCode : 'fr';
  const channels = sanitizeChannels(params.channels);
  const secret = requireOtpSecret();

  // Rate-limit (uid + phone)
  const rl = await consumeRateLimit({
    key: `otp:send:me:${params.uid}:${norm.digitsOnly}`,
    limit: 3,
    windowSeconds: 10 * 60
  });
  if (!rl.allowed) {
    const err: any = new Error('Trop de demandes. Veuillez attendre 10 minutes.');
    err.status = 429;
    throw err;
  }

  if (params.ipKey) {
    const rlIp = await consumeRateLimit({ key: `otp:send:me:ip:${params.ipKey}`, limit: 30, windowSeconds: 10 * 60 });
    if (!rlIp.allowed) {
      const err: any = new Error('Trop de demandes. Veuillez attendre 10 minutes.');
      err.status = 429;
      throw err;
    }
  }

  const code = generateOtpCode6();
  const codeHash = otpCodeHash(secret, norm.e164, code);
  const expiresAt = nowMs() + OTP_TTL_MS;

  const db = getFirestore();
  const docRef = db.collection('PhoneOtpRequests').doc(params.uid);
  await docRef.set({
    uid: params.uid,
    phoneNumber: norm.e164,
    codeHash,
    expiresAt,
    attempts: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await sendOtpViaTwilio({ phoneNumberE164: norm.e164, languageCode, channels, code });
}

export async function verifyLinkPhoneOtp(params: {
  uid: string;
  phoneNumber: unknown;
  code: unknown;
  ipKey?: string;
}): Promise<{ ok: true; merged: boolean }> {
  const norm = normalizeE164PhoneNumber(params.phoneNumber);
  if (!norm.ok) {
    const err: any = new Error(norm.message);
    err.status = 400;
    throw err;
  }
  const code = typeof params.code === 'string' ? params.code.trim() : '';
  if (!/^\d{6}$/.test(code)) {
    const err: any = new Error('Code invalide.');
    err.status = 400;
    throw err;
  }

  if (params.ipKey) {
    const rlIp = await consumeRateLimit({ key: `otp:verify:me:ip:${params.ipKey}`, limit: 60, windowSeconds: 10 * 60 });
    if (!rlIp.allowed) {
      const err: any = new Error('Trop de demandes. Veuillez attendre 10 minutes.');
      err.status = 429;
      throw err;
    }
  }

  const db = getFirestore();
  const docRef = db.collection('PhoneOtpRequests').doc(params.uid);
  const snap = await docRef.get();
  if (!snap.exists) {
    const err: any = new Error('Code invalide.');
    err.status = 400;
    throw err;
  }
  const data = snap.data() as any;

  const expiresAt = Number(data.expiresAt || 0);
  const attempts = Number(data.attempts || 0);
  const storedHash = String(data.codeHash || '');
  const storedPhone = String(data.phoneNumber || '');

  if (!expiresAt || nowMs() > expiresAt) {
    const err: any = new Error('Code expiré.');
    err.status = 410;
    throw err;
  }
  if (attempts >= OTP_MAX_ATTEMPTS) {
    const err: any = new Error('Code invalide.');
    err.status = 400;
    throw err;
  }

  // On exige que le téléphone corresponde à celui du request (évite de vérifier un OTP pour un autre numéro)
  if (storedPhone && storedPhone !== norm.e164) {
    await docRef.set({ attempts: admin.firestore.FieldValue.increment(1) }, { merge: true });
    const err: any = new Error('Code invalide.');
    err.status = 400;
    throw err;
  }

  const secret = requireOtpSecret();
  const computed = otpCodeHash(secret, norm.e164, code);
  const ok = timingSafeEqualHex(storedHash, computed);
  if (!ok) {
    await docRef.set({ attempts: admin.firestore.FieldValue.increment(1) }, { merge: true });
    const err: any = new Error('Code invalide.');
    err.status = 400;
    throw err;
  }

  await docRef.delete().catch(() => {});

  const auth = getAuth();
  await auth.updateUser(params.uid, { phoneNumber: norm.e164 });

  // Mise à jour Clients/{uid} (liste + flags)
  const clientRef = db.collection('Clients').doc(params.uid);
  const clientSnap = await clientRef.get();
  const existingPhone = clientSnap.exists ? (clientSnap.data() as any)['Phone Number'] : undefined;
  let newPhoneField: string | string[] = norm.e164;

  if (Array.isArray(existingPhone)) {
    newPhoneField = Array.from(new Set([norm.e164, ...existingPhone.map((x: any) => String(x))]));
  } else if (typeof existingPhone === 'string' && existingPhone.trim()) {
    if (existingPhone.trim() === norm.e164) newPhoneField = existingPhone.trim();
    else newPhoneField = Array.from(new Set([existingPhone.trim(), norm.e164]));
  }

  await clientRef.set(
    {
      'Phone Number': newPhoneField,
      phoneVerified: true,
      verifiedPhoneNumber: norm.e164,
      phoneVerifiedAt: new Date()
    },
    { merge: true }
  );

  return { ok: true, merged: false };
}

export async function verifyVisitorOtp(params: {
  phoneNumber: unknown;
  code: unknown;
  language?: unknown;
  ipKey?: string;
}): Promise<{ customToken: string; isNewUser: boolean }> {
  const { customToken, isNewUser, uid, phoneNumberE164 } = await verifyLoginOtp({
    phoneNumber: params.phoneNumber,
    code: params.code,
    ipKey: params.ipKey
  });

  const language = typeof params.language === 'string' ? params.language : 'fr';
  const db = getFirestore();
  const clientRef = db.collection('Clients').doc(uid);
  await clientRef.set(
    {
      uid,
      language,
      createdVia: 'visitorPhoneOtp',
      isVisitor: true,
      'Phone Number': phoneNumberE164,
      phoneVerified: true,
      verifiedPhoneNumber: phoneNumberE164,
      phoneVerifiedAt: new Date()
    },
    { merge: true }
  );

  return { customToken, isNewUser };
}


