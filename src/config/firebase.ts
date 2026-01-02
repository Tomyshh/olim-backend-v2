import admin from 'firebase-admin';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

let firebaseInitialized = false;

function loadServiceAccount(): Record<string, unknown> {
  // Compat: variable demandée côté infra/front
  // - FIREBASE_SERVICE_ACCOUNT (JSON string)
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw?.trim()) {
    return JSON.parse(raw);
  }

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (json?.trim()) {
    return JSON.parse(json);
  }

  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64;
  if (b64?.trim()) {
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(decoded);
  }

  const envPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();
  const defaultCandidates = ['serviceAccountKey.json', 'olimservice-7dbee-firebase-adminsdk-r13so-8e1912f7d8.json'];
  const chosen =
    envPath ||
    defaultCandidates.find((p) => existsSync(join(process.cwd(), p))) ||
    defaultCandidates[defaultCandidates.length - 1]!;
  return JSON.parse(readFileSync(join(process.cwd(), chosen), 'utf8'));
}

export function initializeFirebase(): void {
  if (firebaseInitialized) {
    console.log('⚠️  Firebase already initialized');
    return;
  }

  try {
    const serviceAccount = loadServiceAccount();

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 
        `${(serviceAccount as any).project_id}.appspot.com`
    });

    firebaseInitialized = true;
    // Important pour debug prod: savoir dans quel projet Firebase on écrit réellement (Auth/Firestore).
    console.log('✅ Firebase Admin initialized successfully', {
      projectId: (serviceAccount as any).project_id,
      clientEmail: (serviceAccount as any).client_email
    });
  } catch (error) {
    console.error('❌ Error initializing Firebase Admin:', error);
    throw error;
  }
}

export function getFirestore() {
  if (!firebaseInitialized) {
    throw new Error('Firebase not initialized');
  }
  return admin.firestore();
}

export function getAuth() {
  if (!firebaseInitialized) {
    throw new Error('Firebase not initialized');
  }
  return admin.auth();
}

export function getStorage() {
  if (!firebaseInitialized) {
    throw new Error('Firebase not initialized');
  }
  return admin.storage();
}

export { admin };

