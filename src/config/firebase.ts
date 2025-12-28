import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join } from 'path';

let firebaseInitialized = false;

function loadServiceAccount(): Record<string, unknown> {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (json?.trim()) {
    return JSON.parse(json);
  }

  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64;
  if (b64?.trim()) {
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(decoded);
  }

  const serviceAccountPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 'olimservice-7dbee-firebase-adminsdk-r13so-8e1912f7d8.json';
  return JSON.parse(readFileSync(join(process.cwd(), serviceAccountPath), 'utf8'));
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
    console.log('✅ Firebase Admin initialized successfully');
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

